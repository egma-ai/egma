import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The deployment story, checked against the code that reads it.
 *
 * The full environment reference tells an operator about every advanced
 * variable, while `.env.example` stays limited to normal operator inputs.
 * Compose and this app's README must agree with that reference. Each names
 * variables, and every one of them can fall behind the module that reads them,
 * silently, because nothing fails when a variable is documented and unread or
 * read and undocumented. The second is the expensive kind: a self-hoster cannot
 * set a variable nobody told them about, and the failure is a feature that
 * quietly never turns on.
 *
 * So this file compares them, and it is deliberately about **names and shapes**
 * rather than about Docker. It parses no YAML and starts no container: what it
 * asserts is true of the text, which is what somebody reads. The simulator's own
 * deployment test does exactly this, and this is that test for the service on
 * the other side of the wire.
 *
 * The other half is the invariant the whole arrangement rests on — **the grader
 * publishes nothing** — which is a claim about every compose file in the
 * repository at once, and so cannot be tested from inside any one of them.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VARIABLE = /EGMA_GRADER_[A-Z0-9_]+/g;

async function read(...parts: string[]): Promise<string> {
  return readFile(path.join(ROOT, ...parts), "utf8");
}

async function composeFiles(): Promise<string[]> {
  const entries = await readdir(ROOT);
  return entries
    .filter((name) => /^docker-compose.*\.yml$/.test(name))
    .sort();
}

/** Every `EGMA_GRADER_*` the service actually looks up. */
async function variablesTheCodeReads(): Promise<Set<string>> {
  const source = path.join(ROOT, "apps/grader/src");
  const found = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        for (const name of (await readFile(full, "utf8")).match(VARIABLE) ?? []) {
          found.add(name);
        }
      }
    }
  };

  await walk(source);
  return found;
}

/** One service's own lines out of a compose file, or `undefined`. */
function serviceBlock(compose: string, service: string): string | undefined {
  const opening = new RegExp(`^  ${service}:$`, "m").exec(compose);
  if (opening === null) return undefined;
  const rest = compose.slice(opening.index + opening[0].length);
  const closing = /^\S|^ {2}\S/m.exec(rest);
  return closing === null ? rest : rest.slice(0, closing.index);
}

describe("every variable the grader reads", () => {
  it("is in the full environment reference", async () => {
    const documented = await read("docs/configuration/environment-variables.mdx");
    for (const name of await variablesTheCodeReads()) {
      expect(documented).toContain(name);
    }
  });

  it("is passed through by compose, or it never reaches the container at all", async () => {
    const passed = (
      await Promise.all((await composeFiles()).map((file) => read(file)))
    ).join("\n");

    for (const name of await variablesTheCodeReads()) {
      expect(passed).toContain(name);
    }
  });

  it("is in the README's table", async () => {
    const readme = await read("apps/grader/README.md");
    for (const name of await variablesTheCodeReads()) {
      expect(readme).toContain(name);
    }
  });

  /**
   * The other direction, which rots more quietly: a variable somebody sets
   * carefully and nothing has read since it was renamed. A paragraph telling
   * somebody to do something with no effect is worse than silence.
   */
  it("is the only one anything documents", async () => {
    const read_ = await variablesTheCodeReads();
    for (const named of [
      "docs/configuration/environment-variables.mdx",
      "apps/grader/README.md",
      ...(await composeFiles()),
    ]) {
      const stale = [...new Set((await read(named)).match(VARIABLE) ?? [])].filter(
        (name) => !read_.has(name),
      );
      expect(stale, `${named} names variables nothing reads`).toEqual([]);
    }
  });
});

describe("the grader's place in the deployment", () => {
  /**
   * The invariant the whole arrangement rests on, held across every overlay. The
   * service claims its work rather than being sent it, so it needs no inbound
   * network surface at all — and an overlay could break that in one line with
   * nothing else in this suite noticing.
   */
  it("publishes nothing, in every configuration", async () => {
    for (const file of await composeFiles()) {
      const block = serviceBlock(await read(file), "grader");
      if (block === undefined) continue;
      expect(block, `${file} publishes a port on the grader`).not.toContain(
        "ports:",
      );
    }
  });

  it("is one more container in the plain compose file, with no new decision in it", async () => {
    const block = serviceBlock(await read("docker-compose.yml"), "grader");
    expect(block).toBeDefined();
    expect(block).toContain("dockerfile: apps/grader/Dockerfile");
    // The schema is applied by the API on boot, so the grader waits for it
    // rather than migrating a second time.
    expect(block).toContain("api:");
    expect(block).toContain("condition: service_healthy");
    // Both stores, because it reads conversations from one and writes grades
    // to the other.
    expect(block).toContain("DATABASE_URL:");
    expect(block).toContain("CLICKHOUSE_URL:");
  });

  /** The grader reads the shared provider bundle. It no longer opens model
   * credentials stored in Postgres, so the connection encryption key must not
   * cross this container boundary.
   */
  it("is handed the provider credential inputs, and no encryption key", async () => {
    const block = serviceBlock(await read("docker-compose.yml"), "grader");
    expect(block).toBeDefined();
    expect(block).toContain("EGMA_OPENAI_API_KEY:");
    expect(block).toContain("EGMA_DEEPGRAM_API_KEY:");
    expect(block).toContain("EGMA_CARTESIA_API_KEY:");
    expect(block).toContain("EGMA_PROVIDER_CREDENTIALS_SECRET_ID:");
    expect(block).toContain("EGMA_PROVIDER_CREDENTIALS_REGION:");
    expect(block).not.toContain("EGMA_ENCRYPTION_KEY:");
  });

  it("has no healthcheck, because nothing listens for one to reach", async () => {
    const block = serviceBlock(await read("docker-compose.yml"), "grader");
    expect(block).not.toContain("healthcheck:");
  });
});

describe("the API process", () => {
  /**
   * Grading exists and the request path did not grow. Grading is bursty in a
   * way a request path is not — one run of thirty simulations lands thirty
   * conversations to judge at once — so it scales by its own copies rather than
   * by the API's, and the queue is reached by the service that works it and by
   * nothing that answers an HTTP request.
   */
  it("gains nothing from grading existing", async () => {
    const source = path.join(ROOT, "apps/api/src");
    const offending: string[] = [];

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) {
          const text = await readFile(full, "utf8");
          if (/claimGradingJobs|watchGradingWork|\bgradingJob\b/.test(text)) {
            offending.push(path.relative(ROOT, full));
          }
        }
      }
    };

    await walk(source);
    expect(offending).toEqual([]);
  });
});
