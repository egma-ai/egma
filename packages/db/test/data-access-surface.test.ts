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
 * None takes an argument. One returns whether signup is claimed; one returns
 * the platform's own public, non-secret id; and the third returns what this
 * deployment has been configured with, with every secret in it reduced to
 * `null`. The build rule pins all three exact return types and refuses any of
 * them if it grows an argument.
 */
const INSTANCE_SCOPED = [
  "instanceIsClaimed",
  "platformFacts",
  "platformInstanceId",
];

/**
 * What hands egma's own services their work, and what keeps a dispatch honest
 * afterwards. The grader and the simulator each stand behind every
 * organization on the deployment at once and hold no credential, because
 * there is no honest one to give them — so each is handed work rather than
 * asked for one, and the simulator's heartbeat, orphan sweep and standing
 * resolver stand on the same ground: a beat arrives bearing a token that
 * resolves to nobody, silence is noticed by nobody in particular, and a
 * report about a held row is answered from the row.
 *
 * Six names, and a seventh is a decision somebody makes on purpose. None takes
 * an argument by which a caller could name a customer, and a build rule refuses
 * one that grows one; the only rows any of them reaches are egma's own queues —
 * grading jobs, and the simulations egma itself wrote and claimed. A claim
 * arrives carrying the `AuthContext` narrowed to that row's own organization
 * and project, which is what all of the work afterwards goes through; the
 * heartbeat can stamp only a row already claimed under the caller's own name
 * and answers one boolean egma wrote; the sweep files each orphan's grading
 * work under the tenancy the row itself carries and answers identifiers and
 * no content; `resolveSimulationStanding` is the claim's context derived
 * again, by the id the claim handed out, for every call that comes back
 * about a row — the report door's lifecycle claims and the ingest door's
 * arriving spans alike — lifecycle stamps and filing pins, and no content.
 */
const WORK_DISPATCHING = [
  "claimGradingJobs",
  "claimSimulations",
  "recordSimulationHeartbeat",
  "resolveSimulationStanding",
  "sweepOrphanedSimulations",
  "watchGradingWork",
];

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
  "clonePersona",
  "cloneTest",
  "completeSimulation",
  // The type of one connection, by its id alone — the only connection read
  // that does not name an agent. It exists for the deployment gate in front of
  // run creation, which is handed a connection id and no agent id and has to
  // know whether a phone call is what this run would place. It answers a type
  // and nothing else, so what this widening lets out is a word from a closed
  // set and never a config or a credential.
  "connectionTypeOf",
  "correctVerdict",
  "createAgent",
  "createApiKey",
  "createInvitation",
  "createMockTool",
  "createPersona",
  "createProject",
  "createTest",
  "deactivateUser",
  "deleteAgent",
  "deleteGrader",
  // The library's delete, which in v0 exists to refuse: every entry on the
  // shelf is one egma ships, and egma's are undeletable because the next boot
  // writes them again.
  "deleteGraderLibraryEntry",
  "deleteMockTool",
  "deletePersona",
  "deleteTest",
  "editGrader",
  "editMockTool",
  "editPersona",
  "editTest",
  "failSimulation",
  // The claim path's own landing, for a claimed simulation the platform could
  // not hand over. It writes a failed-class reason no simulator may report,
  // so it is a door of its own rather than a word added to `failSimulation` —
  // and it refuses every context that did not come from a claim, because
  // dispatch failure is the platform's confession, not a report anybody
  // files.
  "failSimulationDispatch",
  "finishGradingJob",
  "getAgent",
  "getConnection",
  "getGrader",
  // The shelf: one entry, and one page of it. Both answer egma's entries
  // beside the caller's own, with owner derived from tenancy rather than
  // stored — which is the whole reason that one table's tenancy is nullable.
  "getGraderLibraryEntry",
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
  "listGraderLibrary",
  "listGraders",
  "listGradingJobsForSimulation",
  "listMembers",
  "listMockTools",
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
  // The deployment's own settings, on the judge configuration's exact terms:
  // an owner writes them, a read answers a hint and never a stored secret, and
  // the environment seeds what the platform does not already hold.
  "readPlatformSettings",
  "readProject",
  "readRunVerdicts",
  "readTrace",
  "readVerdicts",
  "recordDeviceAuthorization",
  "recordGradingHeartbeat",
  "recordProductionTraces",
  "registerAgent",
  "regrade",
  "releaseGradingJob",
  "removeConnection",
  "reopenGradingJob",
  "removeMember",
  // The second secret egma holds, on the first one's terms: the read answers a
  // reference and a hint, and this is the one door to the plaintext behind it.
  "resolveJudgeKey",
  // The same translation for a mock tool's scope: names off a reviewed file
  // turned into the agents it applies to. It reads agents and nothing else, and
  // only ones the context already reaches.
  "resolveMockToolAgents",
  // Names off a reviewed file turned into the identity a version names. It
  // reads personas and nothing else, and only ones the context already reaches.
  "resolvePersonaNames",
  // The dispatch path's door to the deployment's own settings in the clear —
  // the third secret egma holds, and the same door the connection's
  // credentials below come through. It takes the context like everything else
  // and then refuses every one that did not come from a simulation claim,
  // because conducting is the only thing egma does with these.
  "resolvePlatformSettings",
  // The dispatch path's door to a connection's plaintext. It takes the context
  // like everything else — and then refuses every one that did not come from a
  // simulation claim, because conducting is the only thing egma does with a
  // connection's credentials at this seam.
  "resolveSimulationConnection",
  "revokeApiKey",
  "seedDefaultJudge",
  // egma's own graders, written onto the shelf from egma's own catalog at
  // start-up. The deployment configuring itself again, one table over: no
  // user, no customer — a predefined entry belongs to none — and an upsert, so
  // running it on every boot writes only what a release changed.
  "seedGraderLibrary",
  "seedPlatformSettings",
  // The other half of the library seeding, one table down: a shelf full of
  // definitions judges nothing until a project is running a copy of one, so
  // every project that has never had the expected-behaviors copy is given it.
  // It names no customer and takes no argument at all.
  "seedRunningGraders",
  "setJudgeConfiguration",
  "startRun",
  "startSimulation",
  "updateAgent",
  "updateConnection",
  "updateOrganizationSettings",
  // The one door that makes a running grader: a pointer at a library entry
  // and the answers to whatever that entry's form asked.
  "useLibraryEntry",
  "writePlatformSettings",
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

/**
 * Every setting this deployment can hold, and the words a person meets each one
 * by. Exported because a readiness answer and a setup interview both have to
 * name them, and a list written in two places is a list that will one day
 * disagree with itself.
 */
const THE_PLATFORMS_SETTINGS = ["PLATFORM_SETTINGS"];

/**
 * What egma ships on the shelf, and the vocabulary a library entry is written
 * in.
 *
 * The catalog is exported because it is the source of truth for what a
 * predefined grader *is* — the seeding writes from it, and a test that wants to
 * watch a version move hands in an edited copy of it. The two type lists are
 * exported for the reason every closed vocabulary in this schema is: the words
 * a refusal names have to be the words the constraint takes, and a list written
 * twice is a list that will one day disagree with itself. `RESERVED_LIBRARY_TYPES`
 * is the other half of that — the words that are spoken for and refused, so a
 * refusal can say "not yet" rather than "never heard of it".
 */
const THE_GRADER_LIBRARY = [
  "GRADER_LIBRARY_CATALOG",
  "LARGEST_GRADER_SOURCE_CODE_BYTES",
  "LIBRARY_TYPES",
  // The identifiers of the entries egma ships, by the name a person calls
  // them. Exported because three things outside this module point at one — the
  // copy every project is seeded with, the engine's roster of what it can
  // execute, and the tests that press Use — and a repeated literal is an
  // identifier somebody can mistype into a pointer at nothing.
  "PREDEFINED_GRADERS",
  "RESERVED_LIBRARY_TYPES",
];

/** Vocabulary: the table definitions, how a caller proved who they are, and the refusals. */
const VALUES = [
  // The agent factory's own refusal, carrying which of its three rules turned
  // a write away: an HTTP layer answers the three differently and must not
  // have to read the sentence to tell them apart.
  "AgentWriteRefusedError",
  "AlreadyBelongsToAnOrganizationError",
  // A library entry cannot leave the shelf while graders point at it. A copy
  // reads its definition through that pointer every time it judges, so an entry
  // taken away underneath one would leave a grader that judges nothing while
  // still appearing on screen — refusal, never `set null`, never orphaned.
  "GraderLibraryEntryInUseError",
  // The grader factory's one refusal, beside the persona factory's: a delete
  // that would leave a live test checking one thing fewer than it says it does.
  "GraderNamedByTestsError",
  "LastAdminError",
  // A second answer for a tool this project already answers for. Its own class
  // because nothing about the body is wrong and something is already there,
  // which is a different answer in kind.
  "MockToolTakenError",
  "NotPermittedError",
  "PersonaNamedByTestsError",
  // A delete that named one of egma's own graders. Its own class because
  // nothing about the request is wrong and nothing is in the way — the entry
  // simply is not anybody's to remove.
  "PredefinedGraderError",
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
  // Use named an entry this caller cannot see, or none at all. One refusal for
  // both, because telling them apart would answer a question about somebody
  // else's shelf.
  "UnknownGraderLibraryEntryError",
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
 * What a mock tool's answer may cost the exchange that carries it, and the two
 * pure functions that read one.
 *
 * The two numbers are exported for the reason the read limits above are: a
 * refusal has to say what the cap is, and a cap named in two places is a cap
 * that will one day disagree with itself. `resolveMockTools` is the fold's
 * shape exactly — a snapshot a caller already holds goes in, the answers one
 * simulation is served come out — and it is exported because merging a project
 * default with a test override has to happen in exactly one place.
 */
const THE_MOCKED_WORLD = [
  "LARGEST_MOCK_TOOL_ANSWER_BYTES",
  "LONGEST_MOCK_TOOL_DELAY_MILLISECONDS",
  "NO_MOCK_TOOLS",
  "isErrorAnswer",
  "resolveMockTools",
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
        ...THE_MOCKED_WORLD,
        ...THE_PLATFORMS_SETTINGS,
        ...THE_GRADER_LIBRARY,
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
