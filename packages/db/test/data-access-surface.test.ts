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

/**
 * How the auth provider reaches the five identity tables. It is handed a
 * binding rather than a connection, so the pool is still never given out, and
 * this is the only place in the codebase that knows both the provider and the
 * tables.
 */
const IDENTITY = ["IDENTITY_MODELS", "identityId", "identityStore"];

/**
 * What produces an `AuthContext`: which organization a person is in, which
 * projects are in it, and what a credential resolves to. An eighth name here is
 * a decision somebody makes on purpose, and the build rule makes them make it.
 *
 * The last two are an invitation's, and they are here rather than above because
 * the person following a link has no account when they read it and no
 * membership when they accept it. The token's hash is the whole argument.
 */
const CONTEXT_ESTABLISHING = [
  "membershipsOf",
  "projectsOf",
  "provisionOrganization",
  "resolveApiKey",
  "resolveDeviceAuthorization",
  "readInvitation",
  "acceptInvitation",
];

/**
 * What answers a question about the deployment rather than about a customer.
 * It takes nothing and returns a boolean, which is what makes it safe without a
 * context; a build rule refuses it the moment it grows an argument.
 */
const INSTANCE_SCOPED = ["instanceIsClaimed"];

/** Everything that touches a customer's data. All of it needs the context. */
const CONTEXT_REQUIRING = [
  "addConnection",
  "changeRole",
  "cloneDigitalHuman",
  "createAgent",
  "createApiKey",
  "createDigitalHuman",
  "createInvitation",
  "createProject",
  "deactivateUser",
  "deleteDigitalHuman",
  "editDigitalHuman",
  "getAgent",
  "getConnection",
  "getDigitalHuman",
  "getDigitalHumanVersion",
  "listApiKeys",
  "listConnections",
  "listDigitalHumans",
  "listMembers",
  "listPendingInvitations",
  "listProjects",
  "readOrganization",
  "readOrganizationSettings",
  "readProject",
  "recordDeviceAuthorization",
  "removeConnection",
  "removeMember",
  "resolveConnectionCredentials",
  "revokeApiKey",
  "updateConnection",
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
  "AlreadyBelongsToAnOrganizationError",
  "LastAdminError",
  "NotPermittedError",
  "ProjectOutsideOrganizationError",
  "VIA",
  "VOICE_PROVIDERS",
  "schema",
];

describe("the data-access module's surface", () => {
  it("is exactly this, so widening it cannot happen by accident", () => {
    expect(Object.keys(dataAccess).sort()).toEqual(
      [
        ...CONNECTION,
        ...MIGRATIONS,
        ...IDENTITY,
        ...CONTEXT_ESTABLISHING,
        ...INSTANCE_SCOPED,
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
