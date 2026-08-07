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

/**
 * Opening and closing the connections, and asking whether they are there. Two
 * stores, one module: the ClickHouse client is as private as the pool, and what
 * is exported for it is the same three verbs and no more.
 */
const CONNECTION = [
  "connect",
  "disconnect",
  "ping",
  "connectClickHouse",
  "disconnectClickHouse",
  "pingClickHouse",
];

/** Applying the schema, which happens on boot before any context exists. */
const MIGRATIONS = [
  "MIGRATIONS_DIRECTORY",
  "readMigrations",
  "runMigrations",
  "CLICKHOUSE_MIGRATIONS_DIRECTORY",
  "runClickHouseMigrations",
];

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

/**
 * Everything that touches a customer's data. All of it needs the context.
 *
 * The trace store's three are `appendSpans`, which writes, and `listTraces` and
 * `readTrace`, which arrived with the two v1 endpoints that call them — an
 * exported read with no caller would be a hole in the boundary that nothing is
 * watching, which is the same objection as a permission row nothing enforces.
 * Both reads take a required time window on top of the context, so neither can
 * be called in a way that scans the whole table.
 */
const CONTEXT_REQUIRING = [
  "addConnection",
  "appendSpans",
  "cancelRun",
  "changeRole",
  "claimSimulations",
  "clonePersona",
  "cloneTest",
  "completeSimulation",
  "createAgent",
  "createApiKey",
  "createInvitation",
  "createPersona",
  "createProject",
  "createTest",
  "deactivateUser",
  "deleteAgent",
  "deletePersona",
  "deleteTest",
  "editPersona",
  "editTest",
  "failSimulation",
  "getAgent",
  "getConnection",
  "getPersona",
  "getPersonaVersion",
  "getRun",
  "getSimulation",
  "getTest",
  "getTestVersion",
  "listAgents",
  "listApiKeys",
  "listConnections",
  "listMembers",
  "listPendingInvitations",
  "listPersonas",
  "listProjects",
  "listRuns",
  "listSimulations",
  "listTests",
  "listTraces",
  "markSimulationCanceled",
  "readOrganization",
  "readOrganizationSettings",
  "readProject",
  "readTrace",
  "recordDeviceAuthorization",
  "recordSimulationHeartbeat",
  "registerAgent",
  "removeConnection",
  "removeMember",
  "resolveConnectionCredentials",
  "revokeApiKey",
  "startRun",
  "startSimulation",
  "sweepOrphanedSimulations",
  "updateAgent",
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
  // The agent factory's own refusal, carrying which of its three rules turned
  // a write away: an HTTP layer answers the three differently and must not
  // have to read the sentence to tell them apart.
  "AgentWriteRefusedError",
  "AlreadyBelongsToAnOrganizationError",
  "LastAdminError",
  "NotPermittedError",
  "PersonaNamedByTestsError",
  "ProjectOutsideOrganizationError",
  // The store's answer to a batch it will never take, told apart from a store
  // that is merely unreachable — a door has to answer those two differently,
  // and only the module that owns the client can tell them apart.
  "TraceStoreRefusedError",
  // And the read surface's own refusal: a window that cannot be served, or a
  // page token that was not issued here. Both are 400s, and neither is a fault.
  "UnreadableTraceQueryError",
  "VIA",
  "VOICE_PROVIDERS",
  "schema",
];

/**
 * The read surface's own limits, exported because the endpoints that enforce
 * them have to say what they are in a refusal, and a cap named in two places is
 * a cap that will one day disagree with itself. Each is a number; none of them
 * reaches a store or names a customer.
 */
const READ_LIMITS = [
  "LARGEST_PAGE_SIZE",
  "MAXIMUM_LIST_LIMIT",
  "MAXIMUM_SPANS_PER_TRACE",
  "MAXIMUM_WINDOW_MILLISECONDS",
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
        ...READ_LIMITS,
      ].sort(),
    );
  });

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
