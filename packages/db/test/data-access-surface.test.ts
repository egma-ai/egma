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
 * What hands egma's own engine its work. The grader service stands behind every
 * organization on the deployment at once and holds no credential, because there
 * is no honest one to give it — so it is handed work rather than asked for one.
 *
 * Two names, and a third is a decision somebody makes on purpose. Neither takes
 * an argument by which a caller could name a customer, and a build rule refuses
 * one that grows one; the only table either reaches is egma's own grading queue;
 * and every claim arrives carrying the `AuthContext` narrowed to that job's own
 * organization and project, which is what all of the grading afterwards goes
 * through.
 */
const WORK_DISPATCHING = ["claimGradingJobs", "watchGradingWork"];

/**
 * Everything that touches a customer's data. All of it needs the context.
 *
 * The trace store's three are `appendSpans`, which writes, and `listTraces` and
 * `readTrace`, which arrived with the two v1 endpoints that call them — an
 * exported read with no caller would be a hole in the boundary that nothing is
 * watching, which is the same objection as a permission row nothing enforces.
 * Both reads take a required time window on top of the context, so neither can
 * be called in a way that scans the whole table.
 *
 * `appendVerdicts` and `readVerdicts` are the same two halves for the store's
 * other table. They need no window because a verdict is filed under the
 * conversation it judges, so naming the conversation is already the bound.
 * `readRunVerdicts` is that read one grain up — a run's outcome and each of its
 * conversations', both from the same fold over the same rows — and it is a door
 * of its own because a run's verdicts are filed under the run and not under any
 * one conversation.
 *
 * `recordProductionTraces` is here rather than among the work-dispatching pair,
 * and that is the whole shape of production grading: the door that already knows
 * whose spans these are writes the queue row, with the tenancy it already
 * resolved, so nothing on the judging side ever has to ask across customers what
 * has finished.
 *
 * `regrade`, `reopenGradingJob` and `correctVerdict` are the two ways a judgment
 * is ever revisited, and neither is an edit — one reopens the queue so the
 * engine judges again at today's grader versions, narrowed to one grader when
 * the ask names one, the other writes a person's disagreement as a row of its
 * own. There are no routes above them yet, so this surface is the altitude
 * re-grading and correcting are reachable at.
 */
const CONTEXT_REQUIRING = [
  "addConnection",
  "advanceProductionSampling",
  "appendSpans",
  "appendVerdicts",
  "cancelRun",
  "changeRole",
  "claimSimulations",
  "clonePersona",
  "cloneTest",
  "completeSimulation",
  "correctVerdict",
  "createAgent",
  "createApiKey",
  "createGrader",
  "createInvitation",
  "createPersona",
  "createProject",
  "createTest",
  "deactivateUser",
  "deleteAgent",
  "deleteGrader",
  "deletePersona",
  "deleteTest",
  "editGrader",
  "editPersona",
  "editTest",
  "failSimulation",
  "finishGradingJob",
  "getAgent",
  "getConnection",
  "getGrader",
  "getGraderVersion",
  "getGradingJob",
  "getGradingJobForTrace",
  "getJudgeConfiguration",
  "getPersona",
  "getPersonaVersion",
  "getRun",
  "getSimulation",
  "getSimulationTestVersion",
  "getTest",
  "getTestVersion",
  "listAgents",
  "listApiKeys",
  "listConnections",
  "listGraders",
  "listGradingJobsForSimulation",
  "listMembers",
  "listPendingInvitations",
  "listPersonas",
  "listProjects",
  // Everything that has changed about one run since a point, in the order it
  // changed. The read a follower resumes from after a crash, and the reason
  // the events are a record rather than a rendering of the mutable rows.
  "listRunEvents",
  "listRuns",
  "listSimulations",
  "listTests",
  "listTraces",
  "markSimulationCanceled",
  "readOrganization",
  "readOrganizationSettings",
  "readProject",
  "readRunVerdicts",
  "readTrace",
  "readVerdicts",
  "recordDeviceAuthorization",
  "recordGradingHeartbeat",
  "recordProductionTraces",
  "recordSimulationHeartbeat",
  "registerAgent",
  "regrade",
  "releaseGradingJob",
  "removeConnection",
  "reopenGradingJob",
  "removeMember",
  "resolveConnectionCredentials",
  // The second secret egma holds, on the first one's terms: the read answers a
  // reference and a hint, and this is the one door to the plaintext behind it.
  "resolveJudgeKey",
  // Names off a reviewed file turned into the identity a version names. It
  // reads personas and nothing else, and only ones the context already reaches.
  "resolvePersonaNames",
  "revokeApiKey",
  "setJudgeConfiguration",
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
  // The grader factory's one refusal, beside the persona factory's: a delete
  // that would leave a live test checking one thing fewer than it says it does.
  "GraderNamedByTestsError",
  "LastAdminError",
  "NotPermittedError",
  "PersonaNamedByTestsError",
  "ProjectOutsideOrganizationError",
  // A run turned away, carrying which rule turned it away: a connection
  // nobody can see, one that is not on the agent that was named, a type no
  // simulator adapter has shipped for, a selection that cannot be conducted,
  // and a cancel that arrived after the run had already finished. Five rules,
  // four codes between them, and a sentence apiece — which is why the reason
  // travels as a value rather than being read back out of the prose.
  "RunWriteRefusedError",
  // An edit refused because somebody moved the test since it was written. It
  // carries both versions and the test's identity, because the caller's next
  // move is to go and read the test as it now stands.
  "TestMovedOnError",
  // A write refused for what it says, told apart from a fault so that a layer
  // above can relay the factory's sentence instead of answering with a stack.
  "UnprocessableInputError",
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
  "MAXIMUM_LIST_LIMIT",
  "MAXIMUM_SPANS_PER_TRACE",
  "MAXIMUM_WINDOW_MILLISECONDS",
];

/**
 * The fold, and the vocabulary it is written in.
 *
 * These take no `AuthContext` and are the only exports that reach nothing at
 * all: rows a caller already holds go in, arithmetic over them comes out. There
 * is no store to name a customer in, so there is no tenancy to stamp — the rows
 * were fetched by a call that stamped it already. (The other exports that take
 * no context do reach a store; each of the three groups above says on what
 * terms.)
 *
 * They are exported because the algebra has to live in exactly one place. A
 * grader's outcome, a conversation's and a run's are all this computation, no
 * row is written anywhere that records the answer, and a second implementation
 * in a query or a page would be a second answer with nothing to settle it
 * against.
 */
const THE_FOLD = [
  "foldVerdicts",
  "foldVerdictsByGrader",
  "speakingVerdicts",
  "JUDGED_BY_HUMAN",
  "PRIORITIES",
  "VERDICTS",
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
        ...WORK_DISPATCHING,
        ...CONTEXT_REQUIRING,
        ...PERMISSION,
        ...VALUES,
        ...READ_LIMITS,
        ...THE_FOLD,
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
