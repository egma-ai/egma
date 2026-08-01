import * as dataAccess from "@egma/db";
import { describe, expect, it } from "vitest";

/**
 * What the rest of the codebase can reach, written out so that widening it is a
 * visible change rather than a quiet one.
 *
 * That each of these takes an `AuthContext` and injects the tenancy predicates
 * is a build rule rather than a test — see `@egma/lint`, which fails the build
 * on a new export that does not, and on a third export in the
 * context-establishing group.
 */

/** Opening and closing the connection, and asking whether it is there. */
const CONNECTION = ["connect", "disconnect", "ping"];

/** Applying the schema, which happens on boot before any context exists. */
const MIGRATIONS = ["MIGRATIONS_DIRECTORY", "readMigrations", "runMigrations"];

/** What produces an `AuthContext`. Two, and a third is a decision. */
const CONTEXT_ESTABLISHING = ["membershipsOf", "provisionOrganization"];

/** Everything that touches a customer's data. All of it needs the context. */
const CONTEXT_REQUIRING = [
  "createApiKey",
  "createProject",
  "listApiKeys",
  "listMemberships",
  "listProjects",
  "readOrganization",
  "readOrganizationSettings",
  "readProject",
  "revokeApiKey",
  "updateOrganizationSettings",
];

/**
 * Deciding what a role may do. These take the context like everything else and
 * then read nothing: a permission is answered from the role the context already
 * carries, which is how a key comes to act at its creator's current role.
 */
const PERMISSION = [
  "ACTIONS",
  "ROLES",
  "authorize",
  "permits",
  "permitsApiKeyMintedBy",
];

/** Vocabulary: the table definitions, how a caller proved who they are, and the refusals. */
const VALUES = [
  "NotPermittedError",
  "ProjectOutsideOrganizationError",
  "VIA",
  "schema",
];

describe("the data-access module's surface", () => {
  it("is exactly this, so widening it cannot happen by accident", () => {
    expect(Object.keys(dataAccess).sort()).toEqual(
      [
        ...CONNECTION,
        ...MIGRATIONS,
        ...CONTEXT_ESTABLISHING,
        ...CONTEXT_REQUIRING,
        ...PERMISSION,
        ...VALUES,
      ].sort(),
    );
  });

  it("hands out no pool, and no way to run a statement of your own", () => {
    const escapeHatches = [
      "pool",
      "db",
      "database",
      "client",
      "query",
      "execute",
      "sql",
      "transaction",
      "raw",
    ];
    for (const name of escapeHatches) {
      expect(Object.keys(dataAccess)).not.toContain(name);
    }
  });

  it("connects without returning anything a caller could keep", () => {
    // `connect` exists so a process can open the pool at boot. It returns
    // nothing, so opening it grants no handle to it.
    expect(dataAccess.connect.length).toBe(1);
  });

  it("exports the tables as definitions, which are not a way in", () => {
    expect(Object.keys(dataAccess.schema)).toContain("organization");
    expect(Object.keys(dataAccess.schema)).toContain("project");
  });
});
