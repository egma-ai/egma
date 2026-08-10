/**
 * The API and CLI validate a platform origin at separate runtime boundaries.
 * The CLI is published as a compiled standalone package, so sharing the API
 * implementation would add a private package to its runtime dependencies.
 * This agreement test makes that deliberate separation safe.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../api/src/config.ts";
import { PLATFORM_IDENTITY_PATH as API_PLATFORM_IDENTITY_PATH } from "../../api/src/routes/platform.ts";
import {
  normalizePlatformOrigin,
  PLATFORM_IDENTITY_PATH,
} from "../src/platform/identity.ts";

const WEB = path.join(import.meta.dirname, "../../web");

const startableApi = {
  DATABASE_URL: "postgres://x/y",
  CLICKHOUSE_URL: "http://x:8123/y",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
};

describe("the API and CLI platform-origin agreement", () => {
  it.each([
    [" HTTPS://Egma.Example:443/ ", "https://egma.example"],
    ["http://127.0.0.1:3101/", "http://127.0.0.1:3101"],
  ])("normalizes %s to %s at both boundaries", (candidate, expected) => {
    expect(normalizePlatformOrigin(candidate)).toBe(expected);
    expect(loadConfig({ ...startableApi, EGMA_BASE_URL: candidate }).baseUrl).toBe(
      expected,
    );
  });

  /**
   * A self-hoster is given one origin, and in every deployment the pages answer
   * there — so the identity read lands on the web process and is forwarded from
   * it. A rewrite that did not carry this path would make the pages answer 404
   * for it, and every command in a bound repository would refuse with "did not
   * return a usable platform identity" on a platform that is running perfectly.
   */
  it("answers at the same path the API serves and the pages forward", async () => {
    expect(PLATFORM_IDENTITY_PATH).toBe(API_PLATFORM_IDENTITY_PATH);

    const rewrites = await readFile(path.join(WEB, "next.config.ts"), "utf8");
    expect(rewrites).toContain(`source: "${PLATFORM_IDENTITY_PATH}"`);
    expect(rewrites).toContain(`destination: \`\${api}${PLATFORM_IDENTITY_PATH}\``);
  });

  it.each([
    "not a URL",
    "ftp://egma.example",
    "https://user:password@egma.example",
    "https://egma.example/api",
    "https://egma.example?one=two",
    "https://egma.example#part",
  ])("refuses %s at both boundaries", (candidate) => {
    expect(() => normalizePlatformOrigin(candidate)).toThrow();
    expect(() =>
      loadConfig({ ...startableApi, EGMA_BASE_URL: candidate }),
    ).toThrow();
  });
});
