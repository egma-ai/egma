/**
 * The API's deployment story, checked against the code that reads it.
 *
 * **This file exists because the gap it closes really happened.** Phone
 * readiness was written, documented in `.env.example`, and covered by tests —
 * and then a real carrier setup against a real Twilio account
 * finished every carrier step correctly and reported phone setup required anyway,
 * because the compose entry for the API never passed the three variables
 * through. A variable absent from a service's `environment:` is not merely
 * undocumented: it does not reach the container at all, whatever the operator
 * sets in their shell or their `.env`. Nothing fails, nothing warns, and the
 * feature is quietly off.
 *
 * The simulator has had this check for its own variables since before the
 * phone work; the API had none. So this is that check, one app over, and it is
 * deliberately about *names and shapes* rather than about Docker: it parses no
 * YAML and starts no container. What it asserts is true of the text, which is
 * what somebody reads.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUCKET,
  INGEST_BUCKET,
  INGEST_POLICY,
  READ_ONLY_POLICY,
} from "./support/object-storage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, "..");
const ROOT = path.resolve(API, "../..");

/**
 * What an `EGMA_*` variable looks like where the API reads one.
 *
 * The API reads its environment through one function, `loadConfig`, and always
 * as `environment.NAME` or `environment["NAME"]` — so the reads are findable
 * without running anything.
 */
const READ = /environment(?:\.|\[")(EGMA_[A-Z0-9_]+)/gu;

/**
 * Variables the API reads that no compose entry has to pass.
 *
 * `EGMA_API_ORIGIN` is the web application's build argument rather than a
 * runtime variable of this process, and lives in that service's `build.args`.
 */
const NOT_A_RUNTIME_VARIABLE = new Set<string>([]);

function everyFileUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const here = path.join(directory, entry);
    if (statSync(here).isDirectory()) found.push(...everyFileUnder(here));
    else if (here.endsWith(".ts")) found.push(here);
  }
  return found;
}

function variablesReadByTheCode(): Set<string> {
  const found = new Set<string>();
  for (const file of everyFileUnder(path.join(API, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(READ)) {
      found.add(match[1] as string);
    }
  }
  return found;
}

/**
 * One service's own lines out of the compose file.
 *
 * Services sit at one indent under `services:` and everything of theirs is
 * indented further, so the block runs to the next line at the same depth.
 * Enough for a file written by hand, which this one is.
 */
function serviceBlock(service: string): string {
  const text = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const opening = new RegExp(`^  ${service}:$`, "mu").exec(text);
  expect(opening, `docker-compose.yml has no ${service} service`).not.toBeNull();
  const rest = text.slice((opening as RegExpExecArray).index + (opening as RegExpExecArray)[0].length);
  const closing = /^\S|^ {2}\S/mu.exec(rest);
  return closing === null ? rest : rest.slice(0, closing.index);
}

describe("the API's deployment story", () => {
  it("always seeds settings and reconciles only when the environment owns the carrier route", () => {
    const entry = readFileSync(path.join(API, "src/index.ts"), "utf8");
    const seed = entry.indexOf(
      "await seedPlatformSettings(config.platformSettings)",
    );
    const reconcile = entry.indexOf(
      "await reconcileDeploymentCarrierSettings(config.platformSettings)",
    );

    expect(seed, "API startup no longer seeds the platform settings").toBeGreaterThan(
      -1,
    );
    expect(
      reconcile,
      "API startup no longer reconciles an environment-owned carrier route",
    ).toBeGreaterThan(seed);
    expect(entry.slice(seed, reconcile)).toContain(
      'config.carrierSettingsSource === "environment"',
    );
    expect(entry.slice(seed, reconcile)).not.toContain("singleOrganization");
  });

  it("passes every variable the API reads to the api container", () => {
    const block = serviceBlock("api");
    const missing = [...variablesReadByTheCode()]
      .filter((name) => !NOT_A_RUNTIME_VARIABLE.has(name))
      .filter((name) => !block.includes(`${name}:`))
      .sort();

    expect(
      missing,
      `the api service in docker-compose.yml does not pass ${missing.join(", ")}, ` +
        "so the container never sees it however it is set — the feature behind " +
        "it is quietly off and nothing says so",
    ).toEqual([]);
  });

  it("documents every variable the API reads in .env.example", () => {
    const documented = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const missing = [...variablesReadByTheCode()]
      .filter((name) => !documented.includes(name))
      .sort();

    expect(
      missing,
      `.env.example does not name ${missing.join(", ")}, which the API reads — ` +
        "a self-hoster cannot set a variable nobody told them about",
    ).toEqual([]);
  });

  it("passes the one telemetry decision into the self-hosted web build", () => {
    const web = serviceBlock("web");
    const dockerfile = readFileSync(path.join(ROOT, "apps/web/Dockerfile"), "utf8");

    for (const line of [
      "EGMA_TELEMETRY: ${EGMA_TELEMETRY:-}",
      "NEXT_PUBLIC_POSTHOG_KEY: ${EGMA_POSTHOG_KEY:-}",
      "NEXT_PUBLIC_POSTHOG_HOST: ${EGMA_POSTHOG_HOST:-}",
    ]) {
      expect(
        web,
        `the web build is missing ${line}, so EGMA_TELEMETRY does not control every process`,
      ).toContain(line);
    }

    for (const argument of [
      "ARG EGMA_TELEMETRY=",
      "ARG NEXT_PUBLIC_POSTHOG_KEY=",
      "ARG NEXT_PUBLIC_POSTHOG_HOST=",
    ]) {
      expect(
        dockerfile,
        `the web Dockerfile is missing ${argument}, so compose cannot pass the telemetry decision`,
      ).toContain(argument);
    }
  });

  it("gives workers direct provider keys and keeps the carrier route on the API", () => {
    // The API resolves simulation work orders and the grader executes judge
    // models, so both read the same deployment-owned provider credentials.
    // The simulator receives only the keys selected for one claimed work order.
    const api = serviceBlock("api");
    const grader = serviceBlock("grader");
    const providerVariables = [
      "EGMA_OPENAI_API_KEY",
      "EGMA_DEEPGRAM_API_KEY",
      "EGMA_CARTESIA_API_KEY",
      "EGMA_PROVIDER_CREDENTIALS_SECRET_ID",
      "EGMA_PROVIDER_CREDENTIALS_REGION",
    ];
    for (const variable of providerVariables) {
      expect(api).toContain(variable);
      expect(grader).toContain(variable);
    }

    // The API seeds and seals the deployment carrier route. Neither worker gets
    // that route as a deployment credential.
    expect(api).not.toContain("TWILIO_AUTH_TOKEN");
    expect(api).toContain("EGMA_PHONE_TRUNK_PASSWORD");
    const simulator = serviceBlock("simulator");
    for (const variable of [...providerVariables, "EGMA_PHONE_TRUNK_PASSWORD"]) {
      expect(simulator, `the simulator is handed ${variable}`).not.toContain(variable);
    }

    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("EGMA_JUDGE_");
    expect(compose).not.toContain("EGMA_PERSONA_");
  });

  it("builds the provider credential boundary into both worker images", () => {
    for (const dockerfile of ["apps/api/Dockerfile", "apps/grader/Dockerfile"]) {
      const image = readFileSync(path.join(ROOT, dockerfile), "utf8");
      expect(
        image,
        `${dockerfile} does not copy @egma/provider-credentials, so its local ` +
          "TypeScript build can pass while the production image cannot resolve it",
      ).toContain(
        "COPY packages/provider-credentials/package.json packages/provider-credentials/",
      );
      expect(image).toContain(
        "COPY packages/provider-credentials packages/provider-credentials",
      );
      expect(image).toContain("packages/provider-credentials");
    }
  });

  it("publishes the recording store to this machine and no further, by default", () => {
    // The one port in this file whose default bind is a security decision.
    // What answers on it is the store's admin surface and its *root*
    // credential — which can list, replace and delete every recording a
    // deployment holds. Bound to 0.0.0.0, `docker compose up` on a shared
    // network offers every customer's recording to the room, to read and to
    // overwrite. This product calls a recording evidence.
    //
    // That credential no longer has a default written in this repository, so
    // the wide bind is no longer a hole anybody can walk through from reading
    // the source. The loopback default stays, because the two are one pair: a
    // password is one mistake away from a wide port, and closing the port by
    // default is the half that costs nothing.
    //
    // Held as a test rather than as the comment beside it, because a comment
    // does not close a port. The publishing itself is required — a browser has
    // to fetch a recording — so what is asserted is the host it is published
    // to, and that opening it is a variable somebody sets on purpose.
    const block = serviceBlock("minio");
    const published = /^\s*-\s*"(.+:9000)"\s*$/mu.exec(block)?.[1] ?? "";
    expect(published, "the minio service publishes its API port").not.toBe("");
    expect(
      published.startsWith("${EGMA_S3_BIND:-127.0.0.1}:"),
      `the recording store is published as ${published}, which does not bind ` +
        "to loopback by default — the store's root credential can overwrite " +
        "every recording, and its default is public in this repository",
    ).toBe(true);
  });

  it("gives the API a recording credential that can only read, and never the simulator's", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const api = serviceBlock("api");

    // The whole reason there are two credentials. A leaked read credential must
    // not be usable to overwrite a customer's call recording, and the one line
    // that would undo that is the API being handed the write pair — which is
    // exactly what an interpolation default would do if somebody "simplified"
    // it. Neither write variable may appear on this service at all.
    //
    // **The API does now hold a credential that can write**, and this test says
    // so on purpose rather than quietly stopping being true: ingestion writes
    // segments, so its pair is on this service by design. What keeps that from
    // reaching a recording is the next test — a different bucket, and a policy
    // confined to one prefix of it. The rule this one holds is unchanged and
    // narrower than it used to read: *the recordings write pair* never appears
    // here.
    for (const write of [
      "EGMA_S3_ACCESS_KEY_ID",
      "EGMA_S3_SECRET_ACCESS_KEY",
      "EGMA_SIMULATOR_S3_ACCESS_KEY_ID",
      "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY",
    ]) {
      // The read pair's own names contain `EGMA_S3_READ_…`, so the write names
      // are looked for as whole words followed by `:-` or `}` — how compose
      // writes an interpolation — rather than as substrings.
      expect(
        new RegExp(`\\$\\{${write}[:}]`, "u").test(api),
        `the api service reads ${write}, which is a credential that can write`,
      ).toBe(false);
    }

    // The API holds exactly one address for the store and it is the browser's.
    // The mistake this guards is a plausible one: somebody finds that
    // `http://localhost:9000` does not answer from inside the container, "fixes"
    // the default to the service name that does, and every recording then fails
    // from every browser with `SignatureDoesNotMatch` — an error naming neither
    // address. Every route test would still pass, because from inside one
    // process the signed address and the fetched address are the same address
    // by construction.
    expect(
      /EGMA_BLOB_PUBLIC_URL:.*minio:9000/u.test(api),
      "the api service signs recording links for the address it reaches the " +
        "store at, which is not the address a browser uses",
    ).toBe(false);
    expect(api).not.toContain("EGMA_SIMULATOR_S3_ENDPOINT");

    // And what that read-only credential is allowed to do, held against the
    // policy the object-storage suite proves against a real MinIO. The two are
    // the same sentence in two files, and a drift between them would mean the
    // suite proving a policy nobody deploys.
    const written =
      /printf '([^']+)'\s*\n?\s*"\$\$EGMA_S3_BUCKET"/u.exec(compose)?.[1] ?? "";
    expect(written, "the bucket job writes a policy document").not.toBe("");
    expect(JSON.parse(written.replace("%s", BUCKET))).toEqual(READ_ONLY_POLICY);
  });

  it("confines the ingestion credential to the pending prefix of its own bucket", () => {
    // The credential the API holds that *can* write, and the two facts that
    // keep it away from everything it must not touch.
    //
    // The first is that it is a different bucket. The second is this policy:
    // one prefix of that bucket for the object operations a spool needs, and a
    // listing statement carrying a prefix condition, so the credential cannot
    // even enumerate the ingestion bucket outside `pending/`. Neither fact is
    // enough alone — a policy is one document in a compose file that a
    // deployment could widen, and a second bucket without a confining policy
    // would still be a credential that could delete a whole bucket's worth of
    // accepted evidence.
    //
    // Held against the copy `ingestion-object-store.test.ts` proves against a
    // real MinIO, the way the recordings policy is, so the suite cannot end up
    // proving a policy nobody deploys.
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const written =
      /printf '([^']+)'\s*\n?\s*"\$\$EGMA_INGEST_BUCKET"/u.exec(compose)?.[1] ?? "";
    expect(written, "the bucket job writes an ingestion policy document").not.toBe(
      "",
    );

    const policy = JSON.parse(written.replaceAll("%s", INGEST_BUCKET)) as {
      Statement: readonly { Resource: readonly string[] }[];
    };
    expect(policy).toEqual(INGEST_POLICY);

    // And what the two files agree on, checked for its shape rather than for
    // its text — so that widening both copies in step still fails here.
    for (const statement of policy.Statement) {
      for (const resource of statement.Resource) {
        expect(
          resource.startsWith(`arn:aws:s3:::${INGEST_BUCKET}`),
          `the ingestion policy names ${resource}, which is outside its bucket`,
        ).toBe(true);
        expect(
          resource === `arn:aws:s3:::${INGEST_BUCKET}` ||
            resource === `arn:aws:s3:::${INGEST_BUCKET}/pending/*`,
          `the ingestion policy names ${resource}, which is wider than the ` +
            "pending prefix",
        ).toBe(true);
      }
    }

    // The recordings bucket is not reachable from it by any spelling, and the
    // ingestion pair is not the recordings pair under another name.
    expect(written).not.toContain(BUCKET);
    const api = serviceBlock("api");
    for (const recordings of [
      "EGMA_S3_ACCESS_KEY_ID",
      "EGMA_S3_SECRET_ACCESS_KEY",
      "EGMA_S3_READ_ACCESS_KEY_ID",
      "EGMA_S3_READ_SECRET_ACCESS_KEY",
    ]) {
      expect(
        new RegExp(`EGMA_INGEST_[A-Z_]+: \\$\\{[^}]*${recordings}[:}]`, "u").test(
          api,
        ),
        `the ingestion credential defaults from ${recordings}, so one leak is both`,
      ).toBe(false);
    }
  });

  it("never passes the Twilio Auth Token to any container", () => {
    // The one credential in this whole effort that no running container may
    // hold. It opens the entire account — every number, every recording, every
    // log and the billing. Setup receives only one limited SIP credential and
    // never receives this account-wide token. A compose entry for it would undo
    // that boundary silently.
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("TWILIO_AUTH_TOKEN");
  });
});
