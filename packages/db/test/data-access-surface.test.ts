import * as dataAccess from "@egma/db";
import { describe, expect, it } from "vitest";

/**
 * The data-access module hands out no way around its tenancy predicates: no
 * pool, no client, and no way to run a statement of your own.
 */

describe("the data-access module's surface", () => {
  it("hands out no pool and no client, and no way to run a statement of your own", () => {
    const escapeHatches = [
      "pool",
      "db",
      "database",
      "client",
      "clickhouse",
      "traceStore",
      "query",
      "command",
      "insert",
      "execute",
      "sql",
      "transaction",
      "raw",
    ];
    for (const name of escapeHatches) {
      expect(Object.keys(dataAccess)).not.toContain(name);
    }
  });
});
