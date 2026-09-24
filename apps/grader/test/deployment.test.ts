import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";

/**
 * Check environment names and the grader service block against Compose.
 * These are text-contract tests, not container tests.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const VARIABLE = /EGMA_(?:GRADER|GRADING)_[A-Z0-9_]+/g;

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
  it("is passed through by compose, or it never reaches the container at all", async () => {
    const passed = (
      await Promise.all((await composeFiles()).map((file) => read(file)))
    ).join("\n");

    for (const name of await variablesTheCodeReads()) {
      expect(passed).toContain(name);
    }
  });
});

describe("the grader's place in the deployment", () => {
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

  /** The grader opens organization keys and also uses deployment provider keys. */
  it("is handed provider inputs and the same key used to seal organization credentials", async () => {
    const block = serviceBlock(await read("docker-compose.yml"), "grader");
    expect(block).toBeDefined();
    expect(block).toContain("EGMA_OPENAI_API_KEY:");
    expect(block).toContain("EGMA_DEEPGRAM_API_KEY:");
    expect(block).toContain("EGMA_CARTESIA_API_KEY:");
    expect(block).toContain("EGMA_PROVIDER_CREDENTIALS_SECRET_ID:");
    expect(block).toContain("EGMA_PROVIDER_CREDENTIALS_REGION:");
    expect(block).toContain("EGMA_ENCRYPTION_KEY:");
  });
});

it("keeps the grader WAL on its own volume when the shared environment names the API log", () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("CLICKHOUSE_URL", "http://unused:8123");
  vi.stubEnv("EGMA_INGEST_ENDPOINT", "");
  vi.stubEnv("EGMA_INGESTION_LOG_DIR", "/a/host/path/for/the/api");
  vi.stubEnv("EGMA_GRADER_INGESTION_LOG_DIR", "");
  vi.stubEnv("EGMA_ROLE", "drain");
  try {
    expect(loadConfig().ingestion).toMatchObject({
      role: "ingest", logDirectory: "/var/lib/egma/grader-ingestion",
    });
    vi.stubEnv("EGMA_GRADER_INGESTION_LOG_DIR", "/mounted/grader/log");
    expect(loadConfig().ingestion.logDirectory).toBe("/mounted/grader/log");
  } finally { vi.unstubAllEnvs(); }
});
