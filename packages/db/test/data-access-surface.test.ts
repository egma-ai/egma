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
 * None takes an argument. One returns whether signup is claimed, and one
 * returns what this deployment has been configured with, with every secret in
 * it reduced to `null`. The build rule pins both exact return types and refuses
 * either if it grows an argument.
 */
const INSTANCE_SCOPED = ["instanceIsClaimed", "platformFacts"];

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
  // The poller names no customer. It claims the next due selected agent and
  // receives the context narrowed to that row. Every later update and trace
  // write requires that context.
  "claimDueRetellMonitoringAgent",
  // Which process, out of however many are running, drains the pending prefix.
  // One claim per deployment rather than one per customer: the prefix holds
  // every project's evidence, so there is no customer to name.
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
 * `regrade` and `reopenGradingJob` are the one way a judgment is ever revisited,
 * and neither is an edit: they reopen the queue so the engine judges again at
 * a simulation's pinned versions or a production trace's current versions,
 * narrowed to one grader identity when the ask names one.
 */
const CONTEXT_REQUIRING = [
  "addConnection",
  "advanceProductionSampling",
  // Taking a persona out of a project's authoring lists, and putting them
  // back. Neither removes a row: a run that pinned a version stays
  // interpretable, and a removal somebody regrets stays undoable.
  "archivePersona",
  "appendSpans",
  "appendVerdicts",
  "applyRepositoryChangeSet",
  "cancelRun",
  "changeRole",
  "completeSimulation",
  "configureLiveKitMonitoring",
  "configureRetellMonitoring",
  // The kind of one connection, by its id alone — the only connection read
  // that does not name an agent. It exists for the deployment gate in front of
  // run creation, which is handed a connection id and no agent id and has to
  // know whether a phone call is what this run would place. It answers a kind
  // and nothing else, so what this widening lets out is a word from a closed
  // set and never a config or a credential.
  "connectionKindOf",
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
  "createMockTool",
  "createPersona",
  "createProject",
  "createTest",
  "createTestSuite",
  "archiveAgent",
  "archiveConnection",
  "deactivateUser",
  "deleteGrader",
  // The library's delete, which in v0 exists to refuse: every entry on the
  // shelf is one egma ships, and egma's are undeletable because the next boot
  // writes them again.
  "deleteGraderLibraryEntry",
  "deleteMockTool",
  "deleteTest",
  "deleteTestSuite",
  "setDefaultPersona",
  "editGrader",
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
  "failRetellMonitoringTarget",
  "finishGradingJob",
  "finishRetellMonitoringScan",
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
  "getPersona",
  "getPersonaVersion",
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
  "listGraders",
  "listGradingJobsForSimulation",
  "listMembers",
  "listMonitoringSetups",
  "listTestVersions",
  "listMockTools",
  "listPendingInvitations",
  "listPersonas",
  "listPersonaVersions",
  "listProjects",
  // Everything that has changed about one run since a point, in the order it
  // changed. The read a follower resumes from after a crash, and the reason
  // the events are a record rather than a rendering of the mutable rows.
  "listRunEvents",
  "listRuns",
  // The same list with its judgment folded in: a page of runs, each carrying
  // its machinery counts and its verdict, read from both stores at once so a
  // row and the page it opens can never disagree.
  "listRunHistory",
  "readRunFold",
  "listSimulations",
  "listTests",
  "listTestSuites",
  "listTraces",
  "markSimulationCanceled",
  "readOrganization",
  "readOrganizationSettings",
  // Safe carrier-setting metadata and secret hints. Model-provider credentials
  // have their own runtime source and never enter this store.
  "readPlatformSettings",
  // Hosted egma has no organization owner who may configure its shared carrier
  // route. Startup reconciles that deployment-owned route from a complete
  // environment bundle and can name no organization or project.
  "reconcileDeploymentCarrierSettings",
  // The other half of a key-only verdict row: what a page shows a person, read
  // from the versions the conversation was pinned to rather than from the live
  // test.
  "readAssertionShelf",
  "readAssertionWords",
  // Asks one question and answers it about the acting customer: does this
  // project belong to them. The drainer holds a scope it read out of a sealed
  // object and must not write under a pair Postgres has never agreed to.
  "isProjectOfOrganization",
  "readProject",
  "readRunVerdicts",
  "readTrace",
  "readVerdicts",
  // The one writer for "evidence for this platform reached the store". Its
  // merge is monotone, because the instant it is given comes from the evidence
  // and a replay therefore carries an older one than the row already holds.
  "recordProductionEvidenceReceived",
  "recordDeviceAuthorization",
  "recordGradingHeartbeat",
  "recordProductionTraces",
  // Poll progress belongs to the selected Monitoring agent, never to a
  // simulation connection. A call that lands writes nothing here at all; only
  // one that did not leaves a short-lived retry row behind it.
  "checkpointRetellMonitoringPage",
  "deleteRetellCallRetry",
  "dueRetellCallRetries",
  "recordRetellCallAttempt",
  "sweepExpiredRetellCallMarkers",
  "transientRetellCallState",
  // Register one provider-backed agent and its first connection as one write.
  "registerAgent",
  "regrade",
  "recoverRetellMonitoringSetup",
  "releaseRetellMonitoringLease",
  "releaseGradingJob",
  "releaseSimulationClaim",
  "reopenGradingJob",
  "removeMember",
  // Archive's other half, for an agent and for one way of reaching it. They
  // are separate verbs and deliberately not one: restoring an agent must never
  // reactivate a child credential, so each connection comes back on its own
  // shape's terms.
  "restoreAgent",
  "restoreConnection",
  "removeMonitoringSetup",
  "renameTestSuite",
  "renewRetellMonitoringLease",
  "runAlreadyStartedFor",
  // No `listGraderVersions` and no `restoreGrader`, and both were here. A
  // running copy has no version history a person browses and no archive to come
  // back from: it is made by pressing **Use** and deleted whole. Internally each
  // grader version pins the exact immutable library-definition revision it runs.
  // The same translation for a mock tool's scope: names off a reviewed file
  // turned into the agents it applies to. It reads agents and nothing else, and
  // only ones the context already reaches.
  "resolveMockToolAgents",
  // Names off a reviewed file turned into the identity a version names. It
  // reads personas and nothing else, and only ones the context already reaches.
  "resolvePersonaNames",
  "restorePersona",
  // Which active tests currently name a persona — the same question their
  // Archive asks, so a page and a refusal can never disagree about it.
  "testsUsingPersona",
  // The dispatch path's door to the deployment's carrier route in the clear.
  // A credential-auth route may contain its SIP pair; model-provider keys do
  // not use this table or this door. It takes the context like everything else
  // and refuses every one that did not come from a simulation claim, because
  // conducting a phone simulation is the only thing egma does with this route.
  "resolvePlatformSettings",
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
  "seedGraderLibrary",
  "seedPersonaLibrary",
  "seedPlatformSettings",
  // The other half of the library seeding, one table down: a shelf full of
  // definitions judges nothing until a project is running a copy of one, so
  // every project that has never had the expected-behaviors copy is given it.
  // It names no customer and takes no argument at all.
  "seedRunningGraders",
  "startRun",
  "startSimulation",
  // What a run froze at start. Pre-cutover run history is reset, so every run
  // this surface can read has one recorded plan.
  "getGradingPlan",
  // The exact grader versions one simulation froze. The grading worker uses
  // this rather than following today's current-version pointers.
  "pinnedSimulationGraders",
  "updateAgent",
  "updateConnection",
  // A project's live name, slug and description, written against the revision
  // the edit was read at. Its counterpart `createProject` above is the one
  // factory signup uses too, so a project made from Settings is born with the
  // same shared default-persona pointer and mandatory grader.
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
  // The one door that makes a running grader: a pointer at a library entry
  // and the answers to whatever that entry's form asked.
  "useLibraryEntry",
  "writePlatformSettings",
  "yieldRetellMonitoringLease",
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

const THE_PERSONA_LIBRARY = [
  "PERSONA_LIBRARY_CATALOG",
  "EGMA_PROVIDED_PERSONAS",
];

/** One executable provider/model catalog shared by persona and grader writes. */
const THE_MODELS = [
  "MODEL_JOBS",
  "MODEL_PROVIDERS",
  "PROVIDERS_BY_JOB",
  "PROVIDER_CATALOG",
  "RECOMMENDED_ENTRY",
  "RECOMMENDED_GRADER_MODEL",
  "RECOMMENDED_PERSONA_MODELS",
  "SPEED_RANGE",
  "graderModelFromRow",
  "isModelProvider",
  "personaModelsFromRow",
  "sameGraderModel",
  "samePersonaModels",
  "validGraderModel",
  "validPersonaModels",
];

/** Vocabulary: the table definitions, how a caller proved who they are, and the refusals. */
const VALUES = [
  // The agent factory's own refusal, carrying which of its three rules turned
  // a write away: an HTTP layer answers the three differently and must not
  // have to read the sentence to tell them apart.
  "AgentWriteRefusedError",
  "AlreadyBelongsToAnOrganizationError",
  // A connection could not be brought back on the terms its own shape sets.
  // Four rules, four codes, and the reason travels beside the sentence.
  "ConnectionRestoreRefusedError",
  // A library entry cannot leave the shelf while graders point at it. Their
  // immutable versions reference exact definition revisions owned by that
  // identity, so removing it would break old judgment history — refusal, never
  // `set null`, never orphaned.
  "GraderLibraryEntryInUseError",
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
  "EgmaProvidedPersonaError",
  // The persona factory's other refusal: archiving the persona a project
  // points at, without saying who takes the pointer. A project always has a
  // default persona, and this is what keeps that true.
  "DefaultPersonaReplacementError",
  // An identity write that named the revision it was written against, after
  // somebody else moved the row. `TestMovedOnError` below is the same refusal
  // one level down, about content rather than identity.
  // A start action that reused an idempotency key over a different request.
  // Its own class because the answer is neither the original run nor a second
  // one: telling somebody their new selection had started when it had not is
  // the one failure the key exists to prevent.
  "IdempotencyConflictError",
  "IdentityConflictError",
  "PersonaNamedByTestsError",
  // A delete that named one of egma's own graders. Its own class because
  // nothing about the request is wrong and nothing is in the way — the entry
  // simply is not anybody's to remove.
  "PredefinedGraderError",
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
  // Use named an entry this caller cannot see, or none at all. One refusal for
  // both, because telling them apart would answer a question about somebody
  // else's shelf.
  "UnknownGraderLibraryEntryError",
  // A write refused for what it says, told apart from a fault so that a layer
  // above can relay the factory's sentence instead of answering with a stack.
  // A persona named by a name two living personas answer to. The same subclass
  // arrangement, and its own code because the reader is usually a repository
  // file: the fix is to put the stable identifier in the file, which is an
  // instruction no browser form would ever be given.
  "PersonaNameAmbiguousError",
  "UnprocessableInputError",
  // A versioned write that named the version it was written against, for every
  // versioned resource reached by identifier rather than by filename.
  "VersionConflictError",
  // The store rolling a write back because another one got in its way. Its own
  // class because it is the one refusal about nothing the caller did: the
  // request was valid, nothing was written, and sending it again is the fix.
  "WriteAbortedError",
  // The store's answer to a batch it will never take, told apart from a store
  // that is merely unreachable — a door has to answer those two differently,
  // and only the module that owns the client can tell them apart.
  "TraceStoreRefusedError",
  // And the read surface's own refusal: a window that cannot be served, or a
  // page token that was not issued here. Both are 400s, and neither is a fault.
  "UnreadableTraceQueryError",
  "VIA",
  // The simulation options a browser may be told about — the five connection facts,
  // field shapes, credential rule, and the adapter facts. Never a gate, a hint
  // function, refusal sentence, or credential.
  "connectionOptionMetadata",
  "connectionKindUsesPlatformCarrier",
  "credentialRuleOf",
  "productLabelOf",
  "accessVariantById",
  // The settled vocabulary of a running copy's scope, exported so that a form
  // and a refusal read the same list the schema is checked against. `GRADER_READS`
  // stood beside it and does not exist: a copy declares no evidence reads.
  "GRADER_SCOPES",
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

/**
 * The shipped list of agent platforms Monitoring keeps a setup for, beside the
 * type spelled from it.
 *
 * Deciding whether a word names one is a question about that list, and a list
 * written out a second time somewhere else is a list that will one day disagree
 * with itself — quietly, as a platform whose bookkeeping stopped being written.
 */
const THE_MONITORED_PLATFORMS = ["MONITORING_PLATFORMS"];

/**
 * How many times one conversation is handed out before egma stops trying.
 *
 * Exported for the same reason the read limits are: the service that judges
 * decides on its own last attempt to answer with what it can see rather than
 * decline again, and a bound named in two places is a bound that will one day
 * disagree with itself.
 */
const THE_GRADING_BUDGET = ["MOST_GRADING_ATTEMPTS"];

/**
 * The bounded budget one listed Retell call gets, and the lock that decides
 * which process drains.
 *
 * The ceiling is exported for the reason every other number here is: the poller
 * has to schedule against the same bound the table's own check enforces, and a
 * bound written out twice is a bound that will one day disagree with itself.
 * The lock's key is exported so an operator reading `pg_locks` can tell egma's
 * two advisory locks apart without reading the source.
 */
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
  // The two halves of one assertion key's round trip: the engine writes a
  // verdict row with the first, a page reads the words back with the second.
  // Here for the fold's own reason — they reach nothing — and together, because
  // a format known in two packages is a format free to fork in one of them.
  "behaviorAssertionAt",
  "behaviorAssertionKey",
  // `foldVerdicts` is deliberately absent, and its absence is the guard. It
  // answers about whatever pile of rows it is handed and never asks whose they
  // are — right inside `verdicts/`, and a loaded gun outside it, because a
  // caller that hands it every row of a run has folded a diagnostic's failure
  // into the headline with nothing about the call saying so. What crosses this
  // boundary is the pair below, neither of which can be called without
  // answering which copies only report.
  "foldVerdictsByGrader",
  "speakingVerdicts",
  // Which rows decide and which only report, split before anything is folded so
  // that the one algebra never has to ask whose rows it was handed.
  "verdictLanes",
  "VERDICTS",
  // The same algebra one grain up, where a run's machinery meets its judgment.
  // It is here rather than in the context-requiring group for the reason the
  // three above are: it is handed what two stores already answered and reaches
  // nothing itself. It exists so that no page decides for itself that a failed
  // execution is a failed verdict, or that grading nobody has finished is one.
  "foldRun",
  "foldSimulation",
];

/**
 * The shared measure module, on the fold's exact terms: spans a caller already
 * read go in, the measure catalog's numbers come out, and it reaches nothing.
 *
 * Exported for the fold's reason too. A measure has to be worked out in exactly
 * one place — the metrics display reads through this and so does the grader that
 * bounds one — because no number is stored anywhere that a disagreement between
 * two readers could be settled against. `worstSampleOf` is on the surface for
 * the same reason as the arithmetic above it: the reduction to the one number a
 * bound is held against is part of the answer, not a caller's business.
 *
 * `everySpanIn` rides with them because the grading engine walks the same tree
 * for a conversation's tool calls, and two implementations of "every span, once"
 * is one of them quietly missing a list.
 */
const THE_MEASURES = [
  "everySpanIn",
  "measuresFromSpans",
  "worstSampleOf",
  // The reported-measurements block: the one neutral shape between every
  // platform's normalizer and the measure module. The writer half and the
  // reader half cross this surface together because they are one contract —
  // a normalizer embeds what `reportedMeasurementsOf` reads back — and the
  // constants ride along so neither side ever spells the version or the
  // payload path for itself.
  "REPORTED_MEASUREMENTS_PAYLOAD_KEY",
  "REPORTED_MEASUREMENTS_PAYLOAD_PATH",
  "REPORTED_MEASUREMENTS_VERSION",
  "reportedMeasurementsOf",
  "reportedMeasurementsPayload",
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
const THE_EVIDENCE_RULES = ["refuseOversizeRecord", "spanContentHash"];

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
        ...THE_MONITORED_PLATFORMS,
        ...THE_GRADING_BUDGET,
        ...THE_RETELL_BUDGET,
        ...THE_FOLD,
        ...THE_MEASURES,
        ...THE_MOCKED_WORLD,
        ...THE_PLATFORMS_SETTINGS,
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
