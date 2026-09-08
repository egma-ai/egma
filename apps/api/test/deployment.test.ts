/**
 * Check that deployment text passes the API's configuration variables into
 * the container. These source checks do not parse YAML or start Docker.
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
const NOT_A_RUNTIME_VARIABLE = new Set<string>([
  // The cloud task definition injects these. Passing them through the
  // self-hosted Compose service would let stray AWS settings select hosted
  // behavior on a deployment that has no launcher role or task family.
  "EGMA_RELEASE_SHA",
  "EGMA_VOICE_FLEET_LAUNCHER",
]);

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
  it("keeps .env.example to the normal operator inputs", () => {
    const example = readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const assignments = example
      .split("\n")
      .map((line) => /^([A-Z][A-Z0-9_]*)=/u.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);

    expect(assignments).toEqual([
      "EGMA_OPENAI_API_KEY",
      "EGMA_CARTESIA_API_KEY",
      "EGMA_DEEPGRAM_API_KEY",
      "EGMA_VOICE_SIMULATION_CONCURRENCY_CAP",
      "EGMA_CHAT_SIMULATION_CONCURRENCY_CAP",
      "EGMA_GRADING_CONCURRENCY_CAP",
      "EGMA_SPEECH_PROVIDER_CONCURRENCY_CAPS",
      "EGMA_PHONE_TRUNK_ADDRESS",
      "EGMA_PHONE_SOURCE_NUMBER",
      "EGMA_PHONE_TRUNK_USERNAME",
      "EGMA_PHONE_TRUNK_PASSWORD",
      // The three optional Stripe settings. They are here because the operator
      // template is where an operator learns what a deployment can be given,
      // and a deployment that charges the people who use it needs all three —
      // but every one of them is empty by default and the product is the
      // product without them.
      "EGMA_STRIPE_SECRET_KEY",
      "EGMA_STRIPE_WEBHOOK_SECRET",
    ]);
  });

  it("keeps both operator and generated secrets out of every Docker build context", () => {
    const ignored = readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());

    expect(ignored).toContain(".env");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain(".egma-platform");
  });

  it("keeps the deployment carrier route out of Postgres", () => {
    const entry = readFileSync(path.join(API, "src/index.ts"), "utf8");
    const claims = readFileSync(
      path.join(API, "src/routes/claims.ts"),
      "utf8",
    );

    expect(entry).not.toContain("seedPlatformSettings");
    expect(entry).not.toContain("reconcileDeploymentCarrierSettings");
    expect(claims).not.toContain("resolvePlatformSettings");
    expect(claims).toContain("options.carrierRoute");
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

  it("documents every variable the API reads in the full environment reference", () => {
    const documented = readFileSync(
      path.join(ROOT, "docs/configuration/environment-variables.mdx"),
      "utf8",
    );
    const missing = [...variablesReadByTheCode()]
      .filter((name) => !documented.includes(name))
      .sort();

    expect(
      missing,
      `the full environment reference does not name ${missing.join(", ")}, ` +
        "which the API reads",
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

    // The API keeps the deployment carrier route. Neither worker gets that
    // route as a process-wide deployment credential.
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
    // Keep the published recording-store port on loopback by default. Publishing
    // is needed for browser audio; wider network access must be an explicit setting.
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

    // The API must receive recording-read credentials, never recording-write
    // credentials. Its separate ingestion credential may write only to the
    // ingestion bucket prefix checked below.
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
    // Keep ingestion in a separate bucket with object operations and listing
    // restricted to pending/. Compare the deployed policy with the policy tested
    // against MinIO in ingestion-object-store.test.ts.
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

  /**
   * The image supports all, ingest, and drain roles. The Compose default uses
   * all, so separating acceptance and draining does not require another image.
   */
  it("ships one image running the whole path, with no container or broker added", () => {
    const api = serviceBlock("api");
    expect(api).toContain("EGMA_ROLE: ${EGMA_ROLE:-all}");

    // The exact list, so that adding a container fails here and has to be
    // argued for rather than noticed later. `livekit-redis` is LiveKit's own
    // dependency and predates this effort; nothing here is an ingestion broker
    // or a second half of the API.
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const services = compose
      .slice(compose.indexOf("\nservices:"), compose.indexOf("\nvolumes:"))
      .matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu);
    expect([...services].map((match) => match[1])).toEqual([
      "postgres",
      "clickhouse",
      "minio",
      "minio-bucket",
      "api",
      "web",
      "simulator",
      "grader",
      "livekit-redis",
      "livekit",
      "livekit-sip",
    ]);

    // And the api service builds one image rather than selecting a second one
    // for a second role.
    expect(api).toMatch(/build:|image:/u);
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
