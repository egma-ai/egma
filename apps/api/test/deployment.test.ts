/**
 * The API's deployment story, checked against the code that reads it.
 *
 * **This file exists because the gap it closes really happened.** Phone
 * readiness was written, documented in `.env.example`, and covered by tests —
 * and then a real carrier setup against a real Twilio account
 * finished every carrier step correctly and reported `setup required` anyway,
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

import { BUCKET, READ_ONLY_POLICY } from "./support/object-storage.ts";

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

  it("keeps the judge's key off the grader, and every setting off the simulator", () => {
    // Three halves of one decision, held here because each is one line away
    // from being undone and none would fail anything else.
    //
    // A judge configured per container is a judge no project chose, spent on
    // conversations belonging to customers who agreed to neither — so the key
    // reaches the API, which writes it into each project's own sealed row, and
    // never the grader, which opens that row.
    expect(serviceBlock("grader")).not.toContain("EGMA_JUDGE_API_KEY");

    // The API *does* hold the carrier's secrets now, and that is the effort's
    // whole point: it seals them into the platform's own store, exactly as it
    // already seals a judge's key and a connection's credentials, and it
    // neither dials nor speaks with any of them. What it must still never
    // hold is the one credential that opens the whole Twilio account.
    const api = serviceBlock("api");
    expect(api).not.toContain("TWILIO_AUTH_TOKEN");
    expect(api).toContain("EGMA_PHONE_TRUNK_PASSWORD");

    // And the variables the platform's settings are *seeded from* reach the
    // API and no simulator. They are what the API seals into the store, and
    // every simulator is then handed the values on the work order it claims;
    // a compose entry for one of them on the simulator would be a second
    // place the same setting is written down, and the two would disagree the
    // first time somebody changed one. Which is this effort's own failure,
    // arriving by a new route.
    //
    // The simulator's own `EGMA_SIMULATOR_*` provider variables are a
    // different thing and stay: they are what a bare simulator falls back to
    // when the platform holds nothing — the workbench story and every
    // contributor's checkout — and a work-order value replaces each of them.
    const simulator = serviceBlock("simulator");
    for (const owned of [
      "EGMA_PERSONA_MODEL_API_KEY",
      "EGMA_PERSONA_STT_API_KEY",
      "EGMA_PERSONA_TTS_API_KEY",
      "EGMA_PHONE_TRUNK_PASSWORD",
      "EGMA_MEDIA_BACKEND:",
    ]) {
      expect(simulator, `the simulator is handed ${owned}`).not.toContain(owned);
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

  it("gives the API a store credential that can only read, and never the simulator's", () => {
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const api = serviceBlock("api");

    // The whole reason there are two credentials. A leaked read credential must
    // not be usable to overwrite a customer's call recording, and the one line
    // that would undo that is the API being handed the write pair — which is
    // exactly what an interpolation default would do if somebody "simplified"
    // it. Neither write variable may appear on this service at all.
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

  it("never passes the Twilio Auth Token to any container", () => {
    // The one credential in this whole effort that no running container may
    // hold. It opens the entire account — every number, every recording, every
    // log, the billing — and it is a setup-time input used once and kept
    // nowhere. A compose entry for it would undo that silently.
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).not.toContain("TWILIO_AUTH_TOKEN");
  });
});
