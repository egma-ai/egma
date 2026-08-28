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
 * It takes no argument and returns whether signup is claimed. The build rule
 * pins its exact return type and refuses it if it grows an argument.
 */
const INSTANCE_SCOPED = ["instanceIsClaimed"];

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
 * Every name is deliberate. None takes
 * an argument by which a caller could name a customer, and a build rule refuses
 * one that grows one; the only rows any of them reaches are egma's own queues —
 * grading jobs, and the simulations egma itself wrote and claimed. A claim
 * arrives carrying the `AuthContext` narrowed to that row's own organization
 * and project, which is what all of the work afterwards goes through; the
 * heartbeat can stamp only a row already claimed under the caller's own name
 * and answers one boolean egma wrote; the sweep ends orphaned simulations and
 * answers identifiers and no content; `resolveSimulationStanding` is the claim's context derived
 * again, by the id the claim handed out, for every call that comes back
 * about a row — the report door's lifecycle claims and the ingest door's
 * arriving spans alike — lifecycle stamps and filing pins, and no content.
 */
const WORK_DISPATCHING = [
  "claimGradingJobs",
  "claimSimulations",
  "recordSimulationHeartbeat",
  "resolveSimulationStanding",
  // The mock endpoint's own context, derived the same way and for the same
  // reason: the caller is the customer's agent platform, holding no credential
  // of egma's, so the run and simulation the URL names are the whole authority.
  // It answers the three gates and the answers this simulation is served, and
  // nothing else about the customer.
  "resolveMockToolCall",
  "sweepOrphanedSimulations",
  "watchGradingWork",
  // The poller names no customer. It claims the next due pulled agent and
  // receives the context narrowed to that row. Every later update and trace
  // write requires that context.
  "claimDueMonitoringPull",
  // One claim per deployment drains the shared durable-ingestion prefix.
  "openDrainOwnership",
];

/**
 * Everything that touches a customer's data. All of it needs the context.
 *
 * The trace store's are `appendSpans`, which writes, and `listTraces` and
 * `readTrace`, which arrived with the two v1 endpoints that call them — an
 * exported read with no caller would be a hole in the boundary that nothing is
 * watching, which is the same objection as a permission row nothing enforces.
 * Both reads take a required time window on top of the context, so neither can
 * be called in a way that scans the whole table.
 *
 * `committedSpans` and `committedTraces` are the write path's own two questions
 * about the same store, and they take the window for the reads' reason: the
 * partition key is the month a span started in, so a probe with no window is a
 * scan of every month the customer ever had. Neither returns evidence — one
 * answers fingerprints, the other answers which ids exist — which is why they
 * are a pair of their own rather than a third and fourth read.
 *
 * Grades are append-only ClickHouse rows. A trace read returns their complete
 * history, its current row per project grader, and the display-only combined
 * score. Regrading reopens the whole frozen trace plan; it never edits history.
 */
const CONTEXT_REQUIRING = [
  "addConnection",
  // Taking a persona out of every list and picker. It removes no row: the
  // stamp is all it writes, so a run that pinned one of their versions stays
  // interpretable forever.
  "deletePersona",
  "archiveProjectGrader",
  "appendSpans",
  "appendGrades",
  "applicableGraders",
  "applyRepositoryChangeSet",
  "cancelRun",
  "changeRole",
  "completeSimulation",
  // The kind of one connection, by its id alone — the only connection read
  // that does not name an agent. It exists for the deployment gate in front of
  // run creation, which is handed a connection id and no agent id and has to
  // know whether a phone call is what this run would place. It answers a kind
  // and nothing else, so what this widening lets out is a word from a closed
  // set and never a config or a credential.
  "connectionTypeOf",
  // What the trace store already holds, asked about a batch at a time and
  // answered without any evidence in it: which spans are committed and what
  // each of their fingerprints is, and which of a list of trace ids exist.
  // They take a window they cannot be called without, on the read surface's
  // terms, and they answer nothing a caller did not already name.
  "committedSpans",
  "committedTraces",
  "createAgent",
  "createApiKey",
  "createInvitation",
  "createCustomLlmGrader",
  "createMockTool",
  "createPersona",
  // A predefined definition grades nothing until a project has a
  // `project_grader` policy for it. Project creation adds the fixed Expected
  // behaviors project grader; the catalog definition itself names no customer.
  "createProject",
  "createTest",
  "createTestSuite",
  "archiveAgent",
  "archiveConnection",
  "deactivateUser",
  // The library's delete, which in v0 exists to refuse: every entry on the
  // shelf is one egma ships, and egma's are undeletable because the next boot
  // writes them again.
  "deleteMockTool",
  "deleteTest",
  "deleteTestSuite",
  "editProjectGrader",
  "editMockTool",
  "editPersona",
  "forkPersona",
  "editTest",
  "failSimulation",
  // The claim path's own landing, for a claimed simulation the platform could
  // not hand over. It writes a failed-class reason no simulator may report,
  // so it is a door of its own rather than a word added to `failSimulation` —
  // and it refuses every context that did not come from a claim, because
  // dispatch failure is the platform's confession, not a report anybody
  // files.
  "failSimulationDispatch",
  "failMonitoringPull",
  "finishGradingJob",
  "finishMonitoringScan",
  "getAgent",
  "getConnection",
  "getExecutableGraderDefinition",
  // The shelf: one entry, and one page of it. Both answer egma's entries
  // beside the caller's own, with owner derived from tenancy rather than
  // stored — which is the whole reason that one table's tenancy is nullable.
  "getGraderLibraryEntry",
  "getGraderDefinitionVersion",
  "getGradingJob",
  "getGradingJobForTrace",
  "getPersona",
  "getPersonaVersion",
  "getProjectGrader",
  "getRun",
  "getSimulation",
  "getSimulationExecutionEvidence",
  "getSimulationTestVersion",
  "getTest",
  "getTestSuite",
  "getTestVersion",
  "listAgents",
  "listApiKeys",
  "listConnections",
  "listGraderLibrary",
  "listGradingJobsForSimulation",
  "listMembers",
  "listTestVersions",
  "listMockTools",
  "listPendingInvitations",
  "listPersonas",
  "listPersonaVersions",
  "listProjectGraders",
  "listProjects",
  // Everything that has changed about one run since a point, in the order it
  // changed. The read a follower resumes from after a crash, and the reason
  // the events are a record rather than a rendering of the mutable rows.
  "listRunEvents",
  "listRuns",
  // One bounded page of simulations with lifecycle and grading state. Grade
  // rows stay on the trace-grade reads rather than being folded into this list.
  "listSimulations",
  "listTests",
  "listTestSuites",
  "listTraces",
  "useGraderInProject",
  "markSimulationCanceled",
  "readOrganization",
  "readOrganizationSettings",
  "readAgentPullState",
  "isProjectOfOrganization",
  "projectOfOrganizationState",
  // The immutable plan receipt recorded for one production trace.
  "readProductionGradingPlan",
  "readProject",
  "readRunGradingProgress",
  "readSimulationGradingStates",
  "readTrace",
  "readTraceGrades",
  "readTraceGrading",
  "reconcileGraderCatalog",
  "recordDeviceAuthorization",
  "recordGradingHeartbeat",
  "recordProductionGradingPlan",
  // The durable drainer's grading handoffs after evidence is query-visible.
  // A completed simulation row authorizes one; a supported explicit production
  // end authorizes the other. Neither infers completion from an ordinary span.
  "recordProductionTraces",
  "recordSimulationTraces",
  // Poll progress belongs to the pulled agent, never to a
  // simulation connection.
  "checkpointMonitoringPage",
  "deleteRetellCallRetry",
  "disablePullProductionCalls",
  "dueRetellCallRetries",
  "enablePullProductionCalls",
  // Custody without an observation: the key a person pastes when they connect
  // an agent is sealed on the agent whether or not they also start pulling,
  // and every later listing for that agent spends the sealed copy.
  "sealAgentMonitoringKey",
  "agentMonitoringKey",
  "recordPulledCallReceived",
  "recordRetellCallAttempt",
  "sweepExpiredRetellCallMarkers",
  "transientRetellCallState",
  // Register one provider-backed agent and its first connection as one write.
  "registerAgent",
  "registerAgentPullingProductionCalls",
  "regradeTrace",
  "requestGrading",
  "releaseMonitoringLease",
  "releaseGradingJob",
  "releaseSimulationClaim",
  "removeMember",
  // Archive's other half, for an agent and for one way of reaching it. They
  // are separate verbs and deliberately not one: restoring an agent must never
  // reactivate a child credential, so each connection comes back on its own
  // shape's terms.
  "restoreAgent",
  "restoreConnection",
  "renameTestSuite",
  "renewMonitoringLease",
  "runAlreadyStartedFor",
  // The same translation for a mock tool's scope: names off a reviewed file
  // turned into the agents it applies to. It reads agents and nothing else, and
  // only ones the context already reaches.
  "resolveMockToolAgents",
  // Names off a reviewed file turned into the identity a version names. It
  // reads personas and nothing else, and only ones the context already reaches.
  "resolvePersonaNames",
  "resolvePersonaVersions",
  // Which active tests currently name a persona — what a sheet shows under
  // *used by*, and what somebody about to press Delete wants to know.
  "testsUsingPersona",
  "traceEvidenceStartedAt",
  "resolveProductionGraders",
  // The dispatch path's door to a connection's plaintext. It takes the context
  // like everything else — and then refuses every one that did not come from a
  // simulation claim, because conducting is the only thing egma does with a
  // connection's credentials at this seam.
  "resolveSimulationConnection",
  "revokeApiKey",
  // egma's own graders, written onto the shelf from egma's own catalog at
  // start-up. The deployment configuring itself again, one table over: no
  // user, no customer — a predefined entry belongs to none — and an upsert, so
  // running it on every boot writes only what a release changed.
  "seedPersonaLibrary",
  // What a run built on the agent's platform, written for the teardown that has
  // to put it back and readable by the landing that stamps a simulation's
  // coverage from it.
  "recordMockedWorld",
  // What one agent's runs still owe somebody's platform account: a temporary
  // version that was never deleted, a pinned number that was never put back.
  // The sweep's whole input, read inside the project like any other run read.
  "outstandingMockedWorlds",
  "simulationMockedWorld",
  "simulationStatusCountsOfRuns",
  "startRun",
  "startSimulation",
  // What a run froze at start. Every run this surface can read has one
  // recorded plan.
  "getGradingPlan",
  // The exact definition versions one simulation froze. The grading worker
  // uses these instead of following today's current-version pointers.
  "pinnedSimulationGraders",
  "pinnedSimulationGradersOn",
  "updateAgent",
  "updateConnection",
  // A project's live name, slug and description, written against the revision
  // the edit was read at. Its counterpart `createProject` above is the one
  // factory signup uses too, so a project made from Settings is born with the
  // same shared default-persona pointer and fixed Expected behaviors project
  // grader.
  "updateProject",
  // No `testsNamingGrader`, and it was here. It counted the live tests naming a
  // grader so an archive could be refused and the blocking tests named. A test
  // names no graders now — the `test_grader` junction is dropped — so there is
  // no such use to block on and nothing left for the verb to count.
  // The customer's own name, changed. The slug is deliberately not offered:
  // it is unique across the deployment, and invitation links were sent under
  // it, so it is a different decision with a different blast radius.
  "updateOrganization",
  "updateOrganizationSettings",
  // The run-start write that freezes the matching project graders and their
  // definition versions. Future policy edits cannot change that recorded plan.
  "writeGradingPlan",
  "yieldMonitoringLease",
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
 * What egma ships on the shelf, and the vocabulary a library entry is written
 * in.
 *
 * One catalog owns predefined definitions. Its closed type and modality lists
 * keep the schema, resolver, and public contract on the same vocabulary.
 */
const THE_GRADER_LIBRARY = [
  "GRADER_DEFINITION_CATALOG",
  "GRADER_DEFINITION_TYPES",
  "GRADER_MODALITIES",
  "MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER",
  // The identifiers of the entries egma ships, by the name a person calls
  // them. Exported because three things outside this module point at one — the
  // copy every project is seeded with, the engine's roster of what it can
  // execute, and the tests that press Use — and a repeated literal is an
  // identifier somebody can mistype into a pointer at nothing.
  "PREDEFINED_GRADERS",
];

const THE_PERSONA_LIBRARY = [
  "PERSONA_LIBRARY_CATALOG",
  "EGMA_PROVIDED_PERSONAS",
];

/** One executable provider/model catalog shared by persona and grader writes. */
const THE_MODELS = [
  "MODEL_ADAPTERS",
  "MODEL_JOBS",
  "MODEL_PROVIDERS",
  "PROVIDERS_BY_JOB",
  "PROVIDER_CATALOG",
  "RECOMMENDED_ENTRY",
  "RECOMMENDED_GRADER_MODEL",
  "RECOMMENDED_PERSONA_MODELS",
  "SPEED_RANGE",
  "graderModelFromRow",
  "catalogEntry",
  "isModelProvider",
  "personaModelsFromRow",
  "sameGraderModel",
  "samePersonaModels",
  "validGraderModel",
  "validPersonaModels",
];

/** Vocabulary: the table definitions, how a caller proved who they are, and the refusals. */
const VALUES = [
  // A guarded key creation found a living key under its reserved name prefix.
  // It carries no row metadata because the conflicting key can belong to a
  // colleague whose keys the caller cannot list.
  "ActiveApiKeyNameConflictError",
  // One egma agent binds to one platform agent. A second, different one is
  // refused by name — its own class, and a subclass of the unprocessable-input
  // refusal, because the sentence is the whole of the answer and the two ids
  // beside it are what lets a caller say something else instead.
  "AgentAlreadyBoundError",
  // The agent factory's own refusal, carrying which of its three rules turned
  // a write away: an HTTP layer answers the three differently and must not
  // have to read the sentence to tell them apart.
  "AgentWriteRefusedError",
  "AlreadyBelongsToAnOrganizationError",
  // A connection could not be brought back on the terms its own shape sets.
  // Four rules, four codes, and the reason travels beside the sentence.
  "ConnectionRestoreRefusedError",
  // The grader factory has no refusal of its own any more. A copy's delete used
  // to be turned away while a live test named it; a test names no graders, so
  // switching one off is a decision about the project with nothing in its way.
  "LastAdminError",
  // A second answer for a tool this project already answers for. Its own class
  // because nothing about the body is wrong and something is already there,
  // which is a different answer in kind.
  "MockToolTakenError",
  "NotPermittedError",
  // A record naming a field longer than the column it would be filed in. Its
  // own class because it is about the evidence rather than about the store:
  // nothing failed and trying again will not help, and it carries the field,
  // the bound and the size so that whoever sent the record is told all three.
  "OversizeRecordError",
  // The persona factory's one refusal, and it used to have three. Archiving
  // the persona a project pointed at without naming a successor went with the
  // pointer itself; refusing to archive one that live tests named went with
  // the guard, because Delete is one verb with one confirmation now. What is
  // left is the shelf: Egma builds a Predefined persona and no project edits
  // or deletes one.
  "EgmaProvidedPersonaError",
  // An identity write that named the revision it was written against, after
  // somebody else moved the row. `TestMovedOnError` below is the same refusal
  // one level down, about content rather than identity.
  // A start action that reused an idempotency key over a different request.
  // Its own class because the answer is neither the original run nor a second
  // one: telling somebody their new selection had started when it had not is
  // the one failure the key exists to prevent.
  "IdempotencyConflictError",
  "IdentityConflictError",
  "ProductionGradingPlanConflictError",
  "ProjectOutsideOrganizationError",
  // A slug an admin typed that a living project of the same organization
  // already holds. Its own class because the slug is the one project field
  // that has to be unique, and the refusal names the word to change.
  "ProjectSlugTakenError",
  // A run turned away, carrying which rule turned it away: a connection
  // nobody can see, one that is not on the agent that was named, a connection
  // kind no simulator adapter has shipped for, a selection that cannot be conducted,
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
  // A persona named by a name two living personas answer to. The same subclass
  // arrangement, and its own code because the reader is usually a repository
  // file: the fix is to put the stable identifier in the file, which is an
  // instruction no browser form would ever be given.
  "PersonaNameAmbiguousError",
  "UnprocessableInputError",
  // The store rolling a write back because another one got in its way. Its own
  // class because it is the one refusal about nothing the caller did: the
  // request was valid, nothing was written, and sending it again is the fix.
  "WriteAbortedError",
  // The store's answer to a batch it will never take, told apart from a store
  // that is merely unreachable — a door has to answer those two differently,
  // and only the module that owns the client can tell them apart.
  "TraceStoreRefusedError",
  "UnstorableInstantError",
  // And the read surface's own refusal: a window that cannot be served, or a
  // page token that was not issued here. Both are 400s, and neither is a fault.
  "UnreadableTraceQueryError",
  "GRADING_WORK_CHANNEL",
  "VIA",
  // The simulation options a browser may be told about — the five connection facts,
  // field shapes, credential rule, and the adapter facts. Never a gate, a hint
  // function, refusal sentence, or credential.
  "connectionOptionMetadata",
  "connectionTypeUsesPlatformCarrier",
  // Which connection lanes a run over them builds a mocked world for. Two
  // names and no gate: the gate itself is a condition inside the claim, where
  // nothing outside this package has a query to put it in.
  "connectionTypeTakesMockedWorld",
  "MOCKABLE_CONNECTION_TYPES",
  "credentialRuleOf",
  "productLabelOf",
  "accessVariantById",
  // A run's four machinery words, exported so the door that filters a history
  // by one refuses anything else by name rather than from a second copy of the
  // list.
  "RUN_STATUSES",
  // No `GRADER_TYPE_REGISTRY` and no `EXPECTED_BEHAVIORS_GRADER`. The first
  // held what each of four authorable grader types read and could score; the
  // second described the built-in that was never a row. `GRADER_LIBRARY_CATALOG`
  // above replaces both — the shelf egma ships, with the expected-behaviors
  // grader an entry on it like any other and a real seeded copy per project.
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

const THE_AGENT_PLATFORMS = ["AGENT_PLATFORMS"];
const THE_GRADING_BUDGET = ["MOST_GRADING_ATTEMPTS"];
const THE_RETELL_BUDGET = ["MOST_RETELL_CALL_ATTEMPTS", "DRAIN_ADVISORY_LOCK"];

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
  // The coverage stamp's vocabulary and its serialization, and the record of
  // the temporary world a run built. Pure both ways: a stored value or a set of
  // classes goes in, a checked shape comes out, and no store is touched. They
  // cross the boundary because both halves of each are in two packages — a
  // platform read produces the classes and this module stores them — and a
  // second implementation of either would be a second answer about how isolated
  // a simulation was.
  "NO_MOCK_TOOL_COVERAGE",
  "NO_TOOL_COVERAGE_CLASSES",
  "TOOL_COVERAGE_CLASSES",
  "coverageFromClasses",
  "mockToolCoverageFrom",
  "mockToolCoverageRow",
  "mockedWorldFrom",
  "mockedWorldRow",
  "toolCoverageClassesFrom",
];

/**
 * Pure grading rules. Rows already read under a tenant boundary go in; current
 * rows, a display-only mean, and selector decisions come out. There is no fold
 * that creates a trace-, test-, suite-, or run-level pass/fail result.
 */
const THE_FOLD = [
  "combinedGradeScore",
  "currentGrades",
  "planGroupsFor",
  "productionSampleSelected",
  "resolveSimulationGraders",
  "validatePassThreshold",
  "validateProjectGraderScope",
];

/**
 * The two decisions about one span's evidence, taken on the fold's terms and
 * for the fold's reason: a record goes in, a fingerprint or a refusal comes
 * out, and neither reaches a store. There is no tenancy to stamp because there
 * is nothing to stamp it on.
 *
 * They cross the boundary because each has to be worked out in exactly one
 * place, and each has two halves in two packages. An acceptance path refuses an
 * oversize record before it is staged; this module refuses it again at the
 * write, and a second implementation of the bound is one of them storing a cut
 * value as if it were whole. An acceptance path fingerprints what it stages;
 * this module fingerprints the row and compares it against what is stored, and
 * a second implementation of the fingerprint is one of them calling a conflict
 * a replay.
 */
const THE_EVIDENCE_RULES = [
  "LARGEST_BOUNDED_RECORD_BYTES",
  "refuseOversizeRecord",
  "refuseUnstorableInstant",
  "spanContentHash",
];

describe("the data-access module's surface", () => {
  it("is exactly this, so widening it cannot happen by accident", () => {
    expect(Object.keys(dataAccess).sort()).toEqual(
      [
        ...THE_EVIDENCE_RULES,
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
        ...THE_AGENT_PLATFORMS,
        ...THE_GRADING_BUDGET,
        ...THE_RETELL_BUDGET,
        ...THE_FOLD,
        ...THE_MOCKED_WORLD,
        ...THE_GRADER_LIBRARY,
        ...THE_PERSONA_LIBRARY,
        ...THE_MODELS,
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
