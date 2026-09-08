import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.ts";

function requiredEnvironment(): void {
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("CLICKHOUSE_URL", "http://unused");
}

afterEach(() => vi.unstubAllEnvs());

describe("grading concurrency cap configuration", () => {
  it("is absent by default for self-hosted deployments", () => {
    requiredEnvironment();
    vi.stubEnv("EGMA_GRADING_CONCURRENCY_CAP", "");
    expect(loadConfig().concurrencyCap).toBeUndefined();
  });

  it("accepts a positive whole-number platform cap", () => {
    requiredEnvironment();
    vi.stubEnv("EGMA_GRADING_CONCURRENCY_CAP", "100");
    expect(loadConfig().concurrencyCap).toBe(100);
  });

  it("rejects an invalid platform cap", () => {
    requiredEnvironment();
    vi.stubEnv("EGMA_GRADING_CONCURRENCY_CAP", "0");
    expect(() => loadConfig()).toThrow(
      'EGMA_GRADING_CONCURRENCY_CAP is a positive whole number, and "0" is not',
    );
  });
});
