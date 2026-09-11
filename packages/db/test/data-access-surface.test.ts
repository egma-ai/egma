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
 *
 * `fencedDatabase` is the seventh, and it is the one door out of the pool.
 * `ee/` is a separate package holding the cloud billing tables' reads and
 * writes — they cannot live here, because no shared code may read a `cloud_`
 * table — so it needs a query interface and this is the only way it gets one.
 * What keeps that from being a loophole is a build rule rather than this list:
 * `only-a-fenced-home-holds-the-query-interface` fails the build for any file
 * outside `packages/db/src/` or `ee/src/access/` that imports it.
 */
const CONNECTION = [
  "connect",
  "disconnect",
  "fencedDatabase",
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
 * Service operations derive organization and project scope from stored work.
 * This list keeps those operations separate from caller-scoped data access.
 */
const WORK_DISPATCHING = [
  "claimGradingJobs",
  "claimSimulations",
  "estimateVoiceSimulationDemand",
  "recordSimulationHeartbeat",
  "recordOrphanedSimulationExecution",
  "resolveSimulationStanding",
  // The mock endpoint's own context, derived the same way and for the same
  // reason: the caller is the customer's agent platform, holding no credential
  // of egma's, so the simulation the URL names is the whole authority. It
  // answers the gates and the answers that simulation's pinned test version
  // carries, and nothing else about the customer.
  "resolveMockToolCall",
  "recordMockState",
  "claimMockDraftFor",
  "owedMockCleanups",
  "sweepOrphanedSimulations",
  "sweepPendingRetellSimulationCollections",
  "takeRetellSimulationCollectionLease",
  // The agent-POV bound, read on the same clock and on the same terms: a POV
  // that never arrives sends nothing, so its absence is noticed by nobody in
  // particular. It moves rows egma's own claim machinery stamped and answers
  // identifiers and no content.
  "settleSimulationsPastTheAgentPovBound",
  "watchGradingWork",
  // The poller names no customer. It claims the next due pulled agent and
  // receives the context narrowed to that row. Every later update and trace
  // write requires that context.
  "claimDueMonitoringPull",
  // One claim per deployment drains the shared durable-ingestion prefix.
  "openDrainOwnership",
];

/**
 * Caller-scoped data access requires AuthContext. Trace and committed-span
 * queries also require a time window to bound partition scans. Grades are
 * append-only; regrading retains their history.
 */
const CONTEXT_REQUIRING = [
  "readProviderKeys",
  "putProviderKey",
  "deleteProviderKey",
  "resolveProviderKeysForWork",
  "resolveProviderKeyForAuthoring",
  "createProviderFundingReceipt",
  "readProviderFundingReceipt",
  "cloneGraderInProject",
  "editGraderDefinition",
  "usePersona",
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
  "deleteTest",
  "deleteTestSuite",
  "editProjectGrader",
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
  "listPendingInvitations",
  "listPersonas",
  "listPersonaVersions",
  "listProjectGraders",
  "listProjects",
  // The server-side event boundary captured with one run detail. A browser
  // uses it to tell page history from a failure that landed after it opened.
  "latestRunEventSequence",
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
  // One conversation's spend, by provider and model — what the simulation
  // page shows on every deployment. A read like any other: it is answered
  // inside the context's own project and returns no provider credential.
  "readOrganizationUsage",
  "priceUsageSpans",
  "readUsageThisPeriod",
  // The measured provider requests of one piece of work, priced at the write
  // against the rate card. It takes the context the work already runs under —
  // a simulation's claim or a grading claim — so the organization and the
  // project come off the row that authorised the work.
  "recordProviderUsage",
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
  "readQueuedWorkProviders",
  "readRunWorkBlock",
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
  // Whether any simulation of one run pins a test version that mocks
  // something — the question the run-start machinery asks before it branches a
  // temporary copy of the customer's agent, asked of the run's own rows.
  "runCarriesMockTools",
  // Names off a reviewed file turned into the identity a version names. It
  // reads personas and nothing else, and only ones the context already reaches.
  "resolvePersonaNames",
  "resolvePersonaVersions",
  // Which active tests currently name a persona — what a sheet shows under
  // *used by*, and what somebody about to press Delete wants to know.
  "testsUsingPersona",
  "traceEvidenceStartedAt",
  "resolveProductionGraders",
  // The second door to a connection's plaintext, for the run start of a kind
  // that reads its agent's platform. Narrower than a role: only for a kind
  // that declares the read, gated on starting a run, and asked with an agent
  // and connection the caller already named. The key it unseals goes to the
  // provider read and nowhere the run header can keep it.
  "resolveRunStartReach",
  // The dispatch path's door to a connection's plaintext. It takes the context
  // like everything else — and then refuses every one that did not come from a
  // simulation claim, because conducting is the only thing egma does with a
  // connection's credentials at this seam.
  "resolveSimulationConnection",
  "registerSimulationProviderReference",
  // The same door one moment later, for the platform that exports nothing of
  // its own: a Retell simulation's record is pulled by egma when the
  // conversation ends, so this unseals the same key to collect the record of
  // what was conducted over it. On the sibling's exact terms — the simulator's
  // own context, refused out loud for any other, and only for a row that has
  // finished conducting.
  "resolveRetellSimulationPull",
  // Which simulation in this project carries one provider reference — how the
  // agent's own POV of a conversation is matched to the simulation it belongs
  // to. It answers inside the caller's project alone, so a reference another
  // customer's simulation carries is as absent here as one nobody carries.
  "resolveSimulationByProviderReference",
  // And the batched form of the same question, which production ingestion asks
  // of one page of provider calls before it files any of them: a conversation
  // egma's own simulator conducted is a simulation, and Monitoring shows
  // production.
  "simulationProviderReferencesIn",
  "revokeApiKey",
  // Upsert the shared Egma-provided persona catalog at startup.
  "seedPersonaLibrary",

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
  // Update project metadata against its expected revision.
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
  "LLM_GRADER_PARAMETER_CONTRACT",
  "defaultGraderParameterValues",
  "graderModelOfParameters",
  "validateExecutableGraderParameters",
  "validateGraderParameterContract",
  "validateGraderParameterValues",
  "GRADER_DEFINITION_CATALOG",
  "GRADER_DEFINITION_TYPES",
  "GRADER_MODALITIES",
  "MAXIMUM_RESPONSE_TIME_PARAMETER",
  // The identifiers of the entries egma ships, by the name a person calls
  // them. Exported because three things outside this module point at one — the
  // copy every project is seeded with, the engine's roster of what it can
  // execute, and the tests that press Use — and a repeated literal is an
  // identifier somebody can mistype into a pointer at nothing.
  "PREDEFINED_GRADERS",
];

/**
 * The rate card: the vocabulary its file is written in, its coverage rule, and
 * the boot upsert that writes it.
 *
 * The vocabulary and the coverage rule reach no store and name no customer —
 * a catalog and a parsed file go in, and the usage types Egma measures come
 * out — and they cross the boundary because the ingest, the grader and the
 * tests all have to write the same words. `upsertRateCard` is the deployment
 * configuring itself, exactly as the persona shelf's seed is: no user, no
 * customer, and an insert that writes only what a release added.
 */
const THE_RATE_CARD = [
  "USAGE_TYPES",
  "USAGE_UNITS",
  "billableUsageTypesOf",
  "catalogModelsMissingAPrice",
  "isUsageType",
  "readRateCard",
  "unitOfQuantities",
  "unitOfUsageType",
  "upsertRateCard",
];

/**
 * What a month of platform usage is: the three allowances, which one a
 * conversation is counted against, how many seconds it counts, when the month
 * turns over — and the same arithmetic written once in SQL.
 *
 * None of it reaches a store and none of it names a customer. The pure half
 * takes a simulation row's own frozen facts and answers a quantity; the SQL
 * half hands back predicates and aggregate expressions, and whoever runs them
 * supplies the tenancy and the connection. It crosses the boundary because the
 * page that shows a month, the read that sums it and the adapter that limits
 * it have to be counting the same thing — and a second copy of the aggregate
 * is a second answer a customer would find before a test did.
 */
const THE_ALLOWANCES = [
  "ALLOWANCE_KINDS",
  "ALLOWANCE_UNITS",
  "SHORTEST_BILLABLE_SECONDS",
  "allowanceKindOf",
  "allowanceKindsAmong",
  "allowancePeriodAt",
  "allowanceTotalsSelection",
  "allowanceUsedBy",
  "begunInThePeriod",
  "billableSecondsOf",
  "minutesFromSeconds",
  "organizationInThePeriod",
  "periodAt",
  "periodUsageFrom",
  // The voice-seconds columns of a period read, narrowed by a predicate, so
  // the hourly meter job in `ee/` counts an hour with the same expressions the
  // settings page counts a month with. A selection, not a query: it reaches no
  // store on its own.
  "voiceSecondsSelection",
];

/**
 * The two ports billing plugs into, the adapters a deployment with no billing
 * runs on, the plain function of settings that selects between them, and the
 * contract every adapter of either port is held to.
 *
 * None of them takes an `AuthContext` and none of them reaches a store: they
 * are interfaces and the answers "yes, unlimited" and "discard". What does
 * reach a store — a run start, a claim, a usage write — asks them from inside
 * this package, so `billing()` itself is deliberately not on this list: a
 * caller who could fetch the plug-in could ask it anything from anywhere.
 */
const THE_BILLING_SEAM = [
  "billing",
  "billingIsConfigured",
  "discardingUsageSink",
  "entitlementSourceContract",
  "installBillingPlugIn",
  "faultTolerantEntitlements",
  "openBillingPlugIn",
  "openEntitlementSource",
  "usageSinkContract",
];

const THE_PERSONA_LIBRARY = [
  "PERSONA_PARAMETER_CONTRACT",
  "BACKGROUND_SOUND_IDS",
  "BACKGROUND_VOLUME_DEFAULT",
  "BACKGROUND_VOLUME_RANGE",
  "PERSONA_EMOTIONS",
  "PERSONA_EXECUTION_POLICY_VERSION",
  "PERSONA_INTERRUPTION_LEVELS",
  "SPEECH_VOLUME_RANGE",
  "defaultPersonaParameterValues",
  "legacyPersonaParameterContract",
  "personaModelsOfParameters",
  "personaControlsOfParameters",
  "personaParameterContract",
  "personaParametersOfModels",
  "personaParametersOfSettings",
  "personaSettingsOfParameters",
  "speechProvidersOfParameters",
  "ticket01PersonaParameterContract",
  "ticket02PersonaParameterContract",
  "validPersonaControls",
  "validatePersonaParameterContract",
  "validatePersonaParameterValues",
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
  "providersNeededBy",
  "sameGraderModel",
  "samePersonaModels",
  "validGraderModel",
  "validPersonaModels",
];

/** Vocabulary: the table definitions, how a caller proved who they are, and the refusals. */
const VALUES = [
  "PersonaVersionConflictError",
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
  // One agent's mocked-world fence would not come free inside its wait. Its own
  // class because it is not a fault and not a bad request: the agent is busy,
  // and the next move is to wait and start again.
  "MockDraftFenceBusyError",
  "NotPermittedError",
  // A record naming a field longer than the column it would be filed in. Its
  // own class because it is about the evidence rather than about the store:
  // nothing failed and trying again will not help, and it carries the field,
  // the bound and the size so that whoever sent the record is told all three.
  "OversizeRecordError",
  // Custom persona behavior and deletion are separate from protected
  // Egma-provided persona content.
  "EgmaProvidedPersonaError",
  // An identity write that named the revision it was written against, after
  // somebody else moved the row. `TestMovedOnError` below is the same refusal
  // one level down, about content rather than identity.
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
  "FundingRefusedError",
  "ProviderKeyUnavailableError",
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
  // Whether a run over this kind reads the agent's own platform before it
  // starts. A word from a closed set, exported so the run route and the one
  // door that unseals a connection for that read agree on which kinds it is
  // for — never a config or a credential.
  "connectionTypeReadsPlatformAtRunStart",
  "connectionTypeBranchesMockDraft",
  "DRAFT_MOCK_CONNECTION_TYPES",
  // The lanes on which Egma is in the tool path at all, so the claim that
  // hands a simulator its answers and the package that decides who branches a
  // copy read one list. A list of connection types, never a config or a
  // credential.
  "LANES_SERVING_MOCK_TOOLS",
  "connectionTypeUsesPlatformCarrier",
  // Which connection lanes a run over them builds a mocked world for. Two
  // names and no gate: the gate itself is a condition inside the claim, where
  // nothing outside this package has a query to put it in.
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

/**
 * Pure POV helpers are shared by trace reads and grading so both use the
 * same agent/persona vocabulary and expectations.
 */
const THE_POV_WORDS = [
  "povOf",
  "fromOnePov",
  "laneProducesAnAgentPov",
];
const THE_GRADING_BUDGET = ["MOST_GRADING_ATTEMPTS", "MAX_GRADING_CLAIM_CAPACITY"];

/**
 * How long grading waits for a simulation's agent POV before it stops waiting.
 *
 * Exported for the reason every other cap here is: the loop that reads the
 * bound on a clock lives in the API, and a number written in two places is a
 * number that will one day disagree with itself.
 */
const THE_AGENT_POV_BOUND = [
  "AGENT_POV_BOUND_SECONDS",
  "SIMULATION_EVIDENCE_COLLECTION_ERROR",
];
const THE_RETELL_BUDGET = ["MOST_RETELL_CALL_ATTEMPTS", "DRAIN_ADVISORY_LOCK"];

/**
 * Shared mock-tool limits, wire serialization, and cleanup-record validation.
 * These exports are pure; API and database code use the same rules.
 */
const THE_MOCKED_WORLD = [
  "LARGEST_MOCK_TOOL_ANSWER_BYTES",
  "LARGEST_JOB_DISPATCH_METADATA_BYTES",
  "RESERVED_ENV_VARIABLE_PREFIX",
  "serializedJobDispatchMetadata",
  "mockMetadataFrom",
  "mockMetadataRow",
  // The note has two readers and two shapes: the run model keeps the routing
  // variables, because the claim fills every one of them on every call it
  // creates, and the API publishes the engine capture alone.
  "mockMetadataAsPublished",
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
 * Shared span-size checks and fingerprints keep ingestion acceptance and
 * database writes consistent. These functions do not access storage.
 */
const THE_EVIDENCE_RULES = [
  "LARGEST_BOUNDED_RECORD_BYTES",
  "refuseOversizeRecord",
  "refuseUnstorableInstant",
  "spanContentHash",
  "providerUsageSpan",
];

describe("the data-access module's surface", () => {
  it("is exactly this, so widening it cannot happen by accident", () => {
    expect(Object.keys(dataAccess).sort()).toEqual(
      [
        ...THE_EVIDENCE_RULES,
        // Deployment settlement reads an explicitly named account, outside user API scope.
        "readPlatformUsageTotal",
        "listCustomerFundedProviders",
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
        ...THE_POV_WORDS,
        ...THE_GRADING_BUDGET,
        ...THE_AGENT_POV_BOUND,
        ...THE_RETELL_BUDGET,
        ...THE_FOLD,
        ...THE_MOCKED_WORLD,
        ...THE_GRADER_LIBRARY,
        ...THE_PERSONA_LIBRARY,
        ...THE_RATE_CARD,
        ...THE_ALLOWANCES,
        ...THE_BILLING_SEAM,
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
