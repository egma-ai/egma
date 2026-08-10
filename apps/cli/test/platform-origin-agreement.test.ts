/**
 * The API and CLI validate a platform origin at separate runtime boundaries.
 * The CLI is published as a compiled standalone package, so sharing the API
 * implementation would add a private package to its runtime dependencies.
 * This agreement test makes that deliberate separation safe.
 */

import { describe, expect, it } from "vitest";

import { loadConfig } from "../../api/src/config.ts";
import { normalizePlatformOrigin } from "../src/platform/identity.ts";

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
