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
  // Production watching's three, on the grading claim's own terms: a poller
  // has no user, a provider's delivery has proved nothing, and each of these
  // hands back the context narrowed to the connection's own tenancy — which is
  // what every write that follows goes through.
  "countRetellWebhookRefusal",
  "resolveRetellWatch",
  "sweepStaleProductionClaims",
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
 * `regrade` and `reopenGradingJob` are the one way a judgment is ever revisited,
 * and neither is an edit: they reopen the queue so the engine judges again at
 * today's grader versions, narrowed to one grader when the ask names one. There
 * are no routes above them yet, so this surface is the altitude re-grading is
 * reachable at.
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
  "createAgent",
  "createApiKey",
  "createInvitation",
  // An organization's judge credential: created and labelled, listed, read as
  // a label and a hint, and relabelled or rotated whole. Five doors and none
  // that answers with a key — the plaintext has one reader, the grading
  // engine, and it reaches it through `resolveJudgeKey` alone.
  "createJudgeCredential",
  "createMockTool",
  "createPersona",
  "createProject",
  "createTest",
  "archiveAgent",
  "archiveConnection",
  "deactivateUser",
  "deleteGrader",
  // The library's delete, which in v0 exists to refuse: every entry on the
  // shelf is one egma ships, and egma's are undeletable because the next boot
  // writes them again.
  "deleteGraderLibraryEntry",
  "deleteMockTool",
  // Archive and Restore, never a delete: a test a run pinned has to stay
  // interpretable forever, and a removal somebody regrets at four o'clock has
  // to be undoable at five.
  "archiveTest",
  "restoreTest",
  // Which agents a test applies to. Its own door because it moves its own
  // revision and mints no version — target coverage is not test content.
  "setTestAgents",
  "editGrader",
  "editJudgeCredential",
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
  "getJudgeCredential",
  "getPersona",
  "getPersonaVersion",
  "getRun",
  "getSimulation",
  "getProjectJudge",
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
  // A new run derived from an earlier one, under today's conditions. It is a
  // verb of its own rather than a flag on `startRun` because everything it uses
  // comes off the earlier run and nothing a caller sends can name any of it —
  // which is what makes the link a retry writes worth trusting.
  "retryRun",
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
  // The other half of a key-only verdict row: what a page shows a person, read
  // from the versions the conversation was pinned to rather than from the live
  // test.
  "readAssertionShelf",
  "readAssertionWords",
  "readProject",
  "readRunVerdicts",
  "readTrace",
  "readVerdicts",
  "recordDeviceAuthorization",
  "recordGradingHeartbeat",
  "recordProductionTraces",
  // The ledger that makes a Retell conversation land exactly once however it
  // arrived: the claim a transport takes on an identity, and the mark that
  // moves the connection's cursor once the spans are stored. Both take the
  // context the watch resolver handed out.
  "advanceProductionCursor",
  "claimProductionTrace",
  "finishProductionTrace",
  "recordRetellWebhookDelivery",
  "recordRetellWebhookRegistration",
  // The measurement door: it asks this connection's adapter what its target
  // can do and writes down what came back. Its own verb rather than a flag on
  // an edit, because a measurement is not an authored change and must not be
  // able to arrive with one.
  "refreshConnectionCapabilities",
  "registerAgent",
  "regrade",
  "releaseGradingJob",
  "reopenGradingJob",
  "removeMember",
  // Archive's other half, for an agent and for one way of reaching it. They
  // are separate verbs and deliberately not one: restoring an agent must never
  // reactivate a child credential, so each connection comes back on its own
  // shape's terms.
  "restoreAgent",
  "restoreConnection",
  // No `listGraderVersions` and no `restoreGrader`, and both were here. A
  // running copy has no version history a person browses and no archive to come
  // back from: it is made by pressing **Use** and deleted whole, and what it
  // judges by is read through its library entry at judging time.
  "listJudgeCredentials",
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
  "restorePersona",
  // Which active tests currently name a persona — the same question their
  // Archive asks, so a page and a refusal can never disagree about it.
  "testsUsingPersona",
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
  "setProjectJudge",
  "startRun",
  "startSimulation",
  // What a run would freeze, answered before anybody starts it — and the same
  // resolver `startRun` uses, so a review step and the run it produces can
  // never disagree about which tests are skipped or which graders judge.
  "planRun",
  // What a run actually froze, including the honest `not_recorded` state for
  // history that predates frozen plans.
  "getGradingPlan",
  // Taking a judge credential out of use, and asking what is stopping that.
  // Both refuse and answer from one read, so a settings page and the refusal
  // can never give two different reasons.
  "archiveJudgeCredential",
  "judgeCredentialUses",
  "updateAgent",
  "updateConnection",
  // A project's live name, slug and description, written against the revision
  // the edit was read at. Its counterpart `createProject` above is the one
  // factory signup uses too, so a project made from Settings is born with the
  // same starter persona, default pointer and judge state.
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
  // A link edit written against an applicability revision the test has moved
  // past. The third of three conflicts, and genuinely a third thing: it guards
  // a set that is neither the live identity nor the versioned content.
  "ApplicabilityConflictError",
  // Egma was asked to measure a target and the adapter could not establish
  // anything. Its own class beside the one below, because "the target did not
  // answer, try again" and "there is nothing here to try" are different next
  // moves and a caller that could not tell them apart would retry forever.
  "CapabilityCheckFailedError",
  "NoCapabilityAdapterError",
  // A connection could not be brought back on the terms its own shape sets.
  // Four rules, four codes, and the reason travels beside the sentence.
  "ConnectionRestoreRefusedError",
  // A library entry cannot leave the shelf while graders point at it. A copy
  // reads its definition through that pointer every time it judges, so an entry
  // taken away underneath one would leave a grader that judges nothing while
  // still appearing on screen — refusal, never `set null`, never orphaned.
  "GraderLibraryEntryInUseError",
  // The grader factory has no refusal of its own any more. A copy's delete used
  // to be turned away while a live test named it; a test names no graders, so
  // switching one off is a decision about the project with nothing in its way.
  // A project's judge pointed at a credential issued by somebody else's
  // provider. Its own class because the fix is specific and nameable.
  "JudgeProviderMismatchError",
  "LastAdminError",
  // A second answer for a tool this project already answers for. Its own class
  // because nothing about the body is wrong and something is already there,
  // which is a different answer in kind.
  "MockToolTakenError",
  "NotPermittedError",
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
  // A judge credential something still needs — a project pointing at it, a run
  // whose frozen plan names it while a conversation is still moving, or a
  // grading job about to resolve its secret. It carries every blocking use,
  // because the fix for each is somewhere different.
  "JudgeCredentialInUseError",
  // A run refused before anything was dialed, because its plan holds a grader
  // that judges by asking a model and the project has configured none.
  "JudgeNotConfiguredError",
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
  // nobody can see, one that is not on the agent that was named, a type no
  // simulator adapter has shipped for, a selection that cannot be conducted,
  // and a cancel that arrived after the run had already finished. Five rules,
  // four codes between them, and a sentence apiece — which is why the reason
  // travels as a value rather than being read back out of the prose.
  // A Retry that could not be derived, because something the earlier run used is
  // no longer active or no longer applies. Its own class beside the one below
  // because it never refuses a request somebody composed — it refuses to
  // silently substitute, and it names the resource that stopped it.
  "RunRetryRefusedError",
  "RunWriteRefusedError",
  // An edit refused because somebody moved the test since it was written. It
  // carries both versions and the test's identity, because the caller's next
  // move is to go and read the test as it now stands.
  // A test with no agent to run against, refused; and a Restore refused
  // because the current version names an archived persona or grader.
  "TestAgentRefusedError",
  "TestDependencyInactiveError",
  "TestMovedOnError",
  // Use named an entry this caller cannot see, or none at all. One refusal for
  // both, because telling them apart would answer a question about somebody
  // else's shelf.
  "UnknownGraderLibraryEntryError",
  // A write refused for what it says, told apart from a fault so that a layer
  // above can relay the factory's sentence instead of answering with a stack.
  // A capability nothing offered. A subclass of the general refusal, so every
  // relay of that one is right about this one too, with a code of its own for
  // a form that wants to point at the capability list.
  "UnknownCapabilityError",
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
  "VOICE_PROVIDERS",
  // The capability catalog, and the two readers that hold a key to it. Pure
  // values: they reach no store, take no context, and are the one list a test
  // requirement and a connection measurement are both written from.
  "CAPABILITY_CATALOG",
  "CAPABILITY_KEYS",
  "admittedCapabilities",
  "isCapabilityKey",
  // The three answers a capability record gives, and the door an adapter's
  // report goes through to become one. `unsupported` and `not_measured` are a
  // settled fact and an unasked question; collapsing them puts a false skip
  // reason on every simulation an adapter's blind spot touched.
  "capabilityStanding",
  "CAPABILITY_STANDINGS",
  "measuredCapabilities",
  "unknownCapabilityMessage",
  "capabilityCheckFailedMessage",
  "noCapabilityAdapterMessage",
  // Whether egma ships something that can measure a type's targets, and the
  // door a deployment installs one through.
  "hasCapabilityDiscovery",
  "registerCapabilityDiscovery",
  // The one shipped adapter, registered for every type egma can reach. It
  // answers only what egma's own transport settles — whether a simulation
  // carries audio, and that nothing can send a digit over any of them — so it
  // states no fact about a provider, which is the rule it had to be written
  // against. Exported so a deployment can put it back after standing another
  // one in its place.
  "transportCapabilities",
  // The connection registry, as a browser may be told about it — labels, field
  // shapes, the credential rule, and the two adapter facts. Never a gate, a
  // hint function, a refusal sentence or a credential.
  "connectionTypeMetadata",
  "credentialRuleOf",
  "variantById",
  "variantIdOf",
  // The settled vocabulary of a running copy's scope, exported so that a form
  // and a refusal read the same list the schema is checked against. `GRADER_READS`
  // stood beside it and does not exist: a copy declares no evidence reads.
  "GRADER_SCOPES",
  // A run's four machinery words, exported so the door that filters a history
  // by one refuses anything else by name rather than from a second copy of the
  // list.
  "RUN_STATUSES",
  "JUDGE_PROVIDERS",
  "JUDGE_SOURCES",
  "PLATFORM_JUDGE",
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
        ...THE_MEASURES,
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
