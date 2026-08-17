/**
 * The data-access module.
 *
 * One module owns the Postgres pool, and this is the only way anything reads or
 * writes. The pool is never exported; the package's `exports` map offers this
 * entry point and nothing else; and a lint rule fails the build if any file
 * outside `packages/db/src` imports a datastore driver. A cross-tenant leak
 * therefore takes adding a new export here, rather than forgetting a `WHERE`
 * clause somewhere nobody is looking.
 *
 * Three categories of export, and the third reaches no store at all:
 *
 * **Context-requiring.** Everything that touches a customer's data takes an
 * `AuthContext` as its first argument and the module builds the organization
 * and project predicates from it. No exported function accepts a filter, so
 * none can be widened and none can be omitted.
 *
 * **Context-establishing.** `membershipsOf`, `projectsOf`,
 * `provisionOrganization`, `resolveApiKey`, `resolveDeviceAuthorization`,
 * `readInvitation` and `acceptInvitation`, and only those seven. The first two
 * are the two halves of what an `AuthContext` is made of — which organization a
 * person is in, and which projects are in it — and the third brings a new
 * organization into existence. The rest each take a credential and answer what
 * it resolves to: an API key's hash becomes the whole context a programmatic
 * request acts in, a device code becomes the organization and project a terminal
 * was let into, and an invitation's token hash becomes the organization somebody
 * with no account yet is being asked to join. None of the seven can return, or
 * reach, a row belonging to anybody else — each is handed the thing the
 * credential already names and can see nothing outside it. Anything added to
 * this category is a deliberate act: a test names them all and fails when an
 * eighth appears.
 *
 * **Instance-scoped.** `instanceIsClaimed` and `platformInstanceId`. Both take
 * nothing, so neither can name a customer. They return only one platform fact:
 * whether signup has been claimed, or the platform's own non-secret identity.
 *
 * **Work-dispatching.** `claimGradingJobs`, `watchGradingWork`,
 * `claimSimulations`, `recordSimulationHeartbeat`, `sweepOrphanedSimulations`
 * and `resolveSimulationStanding`, and only those six. They are asked by
 * egma's own two services — the grader and the simulator — each of which
 * stands behind every organization on the deployment at once and holds no
 * credential, because there is no honest one to give it: the claims hand the
 * work out, and the simulator's heartbeat, orphan sweep and standing resolver
 * stand on the same ground for every call that comes back about a dispatched
 * row — its beats, its silence, its lifecycle claims and its arriving spans.
 * The exemption is narrow and each half of it is enforced: none takes an
 * argument by which a caller could name a customer, and a build rule refuses
 * one that grows one; the only rows any of them reaches are egma's own —
 * grading jobs, and the simulations egma itself wrote and claimed; an answer
 * carries identifiers and tenancy and never anything a customer wrote; and
 * every answer arrives with the `AuthContext` narrowed to that row's own
 * organization and project, which is what all of the work afterwards goes
 * through. `grading.ts` writes the reasoning out in full and `runs.ts`
 * inherits it whole. A seventh name in this category is a deliberate act: a
 * test names all six and fails when another appears.
 *
 * **Deciding.** The role list, the action list, and the one function every
 * action in the product passes through. They take an `AuthContext` like
 * everything else and then read nothing: a permission is decided from the role
 * the context already carries, which is what keeps the answer current rather
 * than remembered. They are here, beside the context they read, because the
 * context is the only input they have.
 *
 * The ClickHouse client sits behind this same boundary on these same terms:
 * `appendSpans` writes and `listTraces` and `readTrace` read, all three are
 * files beside these, all three take the same `AuthContext` and stamp the same
 * tenancy, and the driver was already named in the lint rule's list before any
 * of them existed. The two reads also take a **required time window** and a
 * project to narrow to — a narrowing argument, never a filter — because the
 * trace store is filed by time and a read that named none would be the one
 * unfiltered scan this boundary exists to make unreachable.
 *
 * `recordProductionTraces` sits beside `appendSpans` on that same path and is
 * the other half of what the ingest door does with an export. It is handed the
 * very same spans: the trace store gets the rows, and the grading queue gets one
 * row per conversation saying when egma last heard about it and whether its root
 * span closed. Taking the spans rather than a summary of them is what keeps
 * "when is a conversation over" written down once. It is a queue write and a
 * notification and never a judgment — grading happens in a service that holds no
 * request open.
 *
 * `appendVerdicts` and `readVerdicts` are the same two halves for the store's
 * other table. They need no window, because a verdict is filed under the
 * conversation it judges rather than under the minute it was written in, so
 * naming the conversation is already the bound. The read hands back the rows and
 * the folded answer over them; nothing writes an overall row anywhere, and the
 * fold that computes one is a pure function exported from the package's entry
 * point rather than from here, because it reaches no store at all.
 *
 * `readRunVerdicts` is that read one grain up, and it is a third door rather
 * than an option on the second because a run's verdicts are filed under the run
 * and not under any one conversation. It answers a run's outcome and each of its
 * conversations', both from the same fold over the same rows, which is what
 * fills the run header's verdict counts at read time and keeps them incapable of
 * disagreeing with the page beneath.
 *
 * The one way a judgment is ever revisited is exported beside them, and it is
 * not an edit: `regrade` reopens the queue so the engine judges a run or a
 * window again at each grader's current version — narrowed to one grader when
 * the ask names one, which is a decision about judge spend rather than about
 * what the rows come to say. A person's disagreement is not a door here at all:
 * corrections leave v0 with the `judged_by` column that carried them, and return
 * as the reserved `human` grader type, which writes ordinary verdict rows under
 * a grader id of its own.
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  AgentWriteRefusedError,
  AlreadyBelongsToAnOrganizationError,
  ApplicabilityConflictError,
  CapabilityCheckFailedError,
  ConnectionRestoreRefusedError,
  DefaultPersonaReplacementError,
  GraderLibraryEntryInUseError,
  IdempotencyConflictError,
  IdentityConflictError,
  JudgeCredentialInUseError,
  JudgeNotConfiguredError,
  JudgeProviderMismatchError,
  LastAdminError,
  ManagedAccessBoundElsewhereError,
  ManagedAccessNotConnectedError,
  ManagedAccessUnavailableError,
  MockToolTakenError,
  ModelProviderCredentialMissingError,
  NoCapabilityAdapterError,
  NotPermittedError,
  PersonaNameAmbiguousError,
  PersonaNamedByTestsError,
  PredefinedGraderError,
  ProjectOutsideOrganizationError,
  ProjectSlugTakenError,
  RunRetryRefusedError,
  RunWriteRefusedError,
  TestAgentRefusedError,
  TestDependencyInactiveError,
  TestMovedOnError,
  TraceStoreRefusedError,
  UnknownCapabilityError,
  UnknownGraderLibraryEntryError,
  UnprocessableInputError,
  UnreadableTraceQueryError,
  VersionConflictError,
  WriteAbortedError,
  type AgentWriteRefusal,
  type ArchivedDependency,
  type ConnectionRestoreRefusal,
  type GraderUsingLibraryEntry,
  type JudgeCredentialUse,
  type RetryBlocker,
  type RunWriteRefusal,
  type TestAgentRefusal,
  type TestNamingPersona,
} from "./errors.ts";

export {
  ACTIONS,
  authorize,
  permits,
  permitsApiKeyMintedBy,
  type Action,
  type ActionScope,
} from "./permissions.ts";

export {
  changeRole,
  deactivateUser,
  listMembers,
  membershipsOf,
  removeMember,
  type Member,
  type Membership,
  type RemovedMember,
  type ResolvedMembership,
} from "./memberships.ts";

export {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
  readInvitation,
  type Acceptance,
  type Invitation,
  type InvitationState,
  type NewInvitation,
  type ResolvedInvitation,
} from "./invitations.ts";
export {
  provisionOrganization,
  type NewPlatformJudge,
  type NewOrganization,
  type ProvisionedOrganization,
} from "./provisioning.ts";
export { instanceIsClaimed, platformInstanceId } from "./instance.ts";

/**
 * The settings this deployment holds — the judge configuration's idiom, one
 * scope up. Sealed with the deployment's own key, hinted rather than handed
 * back, seeded from the environment at start and never over a value somebody
 * chose. `platformFacts` is the third instance-scoped export: it takes nothing,
 * so there is no customer to name, and it answers only what is not secret,
 * because the readiness answer it feeds is read before anybody has logged in.
 *
 * The read and the write take the deployment's own tenancy beside the context,
 * because who may be here depends on it: an organization owner may, and only
 * while this deployment serves one organization.
 *
 * `resolvePlatformSettings` is the one door to the plaintext, and it takes the
 * context like everything else — and then refuses every context that did not
 * come from a simulation claim, because conducting is the only thing egma does
 * with these. It is `resolveSimulationConnection`'s guard, word for word, over
 * the settings that ride the same work order.
 */
export {
  platformFacts,
  readPlatformSettings,
  resolvePlatformSettings,
  seedPlatformSettings,
  writePlatformSettings,
  type DeploymentTenancy,
  type PlatformFacts,
  type PlatformSetting,
} from "./platform-settings.ts";
export {
  PLATFORM_SETTINGS,
  type PlatformSettingDefinition,
  type PlatformSettingName,
  type PlatformSettingValues,
} from "../schema/platform.ts";

export {
  readOrganization,
  readOrganizationSettings,
  updateOrganization,
  updateOrganizationSettings,
  type Organization,
  type OrganizationSettings,
  type OrganizationSettingsChanges,
} from "./organizations.ts";

export {
  listProjects,
  projectsOf,
  readProject,
  createProject,
  updateProject,
  type NewProject,
  type Project,
  type ProjectChanges,
} from "./projects.ts";

export {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  resolveApiKey,
  type ApiKey,
  type ListedApiKey,
  type NewApiKey,
  type ResolvedApiKey,
} from "./api-keys.ts";

export {
  recordDeviceAuthorization,
  resolveDeviceAuthorization,
  type DeviceAuthorization,
  type DeviceAuthorizationTarget,
} from "./device-authorizations.ts";

export {
  appendSpans,
  type AppendedSpans,
  type NewSpan,
  type SpanEmitter,
  type SpanSource,
} from "./spans.ts";

export {
  listTraces,
  readTrace,
  MAXIMUM_LIST_LIMIT,
  MAXIMUM_SPANS_PER_TRACE,
  MAXIMUM_WINDOW_MILLISECONDS,
  type ListTracesOptions,
  type ReadTraceOptions,
  type TimeWindow,
  type TraceDetail,
  type TraceFacts,
  type TraceList,
  type TraceSpan,
  type TraceSummary,
} from "./traces.ts";

export {
  appendVerdicts,
  readRunVerdicts,
  readVerdicts,
  type AppendedVerdicts,
  type NewVerdict,
  type ReadVerdictsOptions,
  type RecordedVerdict,
  type RunVerdicts,
  type SimulationVerdicts,
  type TraceVerdicts,
} from "./verdicts.ts";

/**
 * The other half of a verdict row: a key is what the store keeps, and this is
 * how a page turns one back into the words somebody wrote.
 */
export {
  readAssertionShelf,
  readAssertionWords,
  type AssertionShelf,
  type AssertionWords,
} from "./assertions.ts";

export {
  addConnection,
  archiveAgent,
  archiveConnection,
  connectionTypeOf,
  createAgent,
  getAgent,
  getConnection,
  listAgents,
  listConnections,
  refreshConnectionCapabilities,
  registerAgent,
  restoreAgent,
  restoreConnection,
  updateAgent,
  updateConnection,
  type Agent,
  type AgentChanges,
  type AgentPage,
  type ArchivedAgent,
  type ArchivedConnection,
  type Connection,
  type ConnectionChanges,
  type CreatedAgent,
  type NewAgent,
  type NewConnection,
  type Registration,
  type RegistrationResult,
  type RestoreCredential,
} from "./agents.ts";
export type {
  CapabilityState,
  ConnectionType,
  Modality,
  Topology,
} from "../schema/agents.ts";

/**
 * Watching a customer's production traffic on somebody else's platform.
 *
 * The first three take no `AuthContext` and cannot be given one — see the file
 * they live in. Every one of them hands back the narrowed context the work is
 * then done under, and the four below take one.
 */
export {
  advanceProductionCursor,
  claimProductionTrace,
  countRetellWebhookRefusal,
  finishProductionTrace,
  recordRetellWebhookDelivery,
  recordRetellWebhookRegistration,
  resolveRetellWatch,
  sweepStaleProductionClaims,
  type ProductionTraceClaim,
  type ProductionTraceOffer,
  type RetellWatchQuery,
  type RetellWatchTarget,
} from "./production-watch.ts";
export type {
  ProductionTransport,
  RetellWebhookRefusal,
} from "../schema/production.ts";


export {
  archivePersona,
  clonePersona,
  createPersona,
  editPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  listPersonaVersions,
  resolvePersonaNames,
  restorePersona,
  testsUsingPersona,
  VOICE_PROVIDERS,
  type ArchiveRequest,
  type NewPersona,
  type Persona,
  type PersonaChanges,
  type PersonaListRequest,
  type PersonaPage,
  type PersonaTraits,
  type PersonaVersion,
  type PersonaVersionPage,
  type RestoreRequest,
  type VoiceProvider,
} from "./personas.ts";

/**
 * Mock tools: what egma answers with when the agent calls one of its tools
 * during a simulation. Project-owned, one answer per tool name, and the one
 * authored thing with no version chain behind it — `editMockTool` overwrites,
 * and the schema file argues the exemption out in full.
 *
 * `resolveMockToolAgents` is the scope's name-to-identity translation, the
 * persona resolver's shape: a folder a team reads in pull requests names agents
 * rather than identifiers.
 */
export {
  createMockTool,
  deleteMockTool,
  editMockTool,
  listMockTools,
  resolveMockToolAgents,
  type DeletedMockTool,
  type MockTool,
  type MockToolAgent,
  type MockToolChanges,
  type MockToolPage,
  type NewMockTool,
} from "./mock-tools.ts";
export {
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
} from "../schema/mock-tools.ts";

export {
  archiveTest,
  cloneTest,
  createTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
  listTestVersions,
  restoreTest,
  setTestAgents,
  type ApplicabilityChange,
  type ArchiveTestRequest,
  type ExpectedBehavior,
  type MockOverride,
  type MockOverrideInput,
  type NewTest,
  type RestoreTestRequest,
  type Test,
  type TestAgent,
  type TestChanges,
  type TestListRequest,
  type TestPage,
  type TestPersona,
  type TestVersion,
  type TestVersionPage,
} from "./tests.ts";

/**
 * The grader library: the shelf of definitions, one level above the running
 * copies below.
 *
 * `seedGraderLibrary` is the third deployment-configuring export, on
 * `seedPlatformSettings`' exact terms: it writes egma's own graders from egma's
 * own catalog in the same breath as applying migrations, names no customer
 * because a predefined entry belongs to none, and is an upsert — so a second
 * boot writes nothing at all and a release that improved a judge prompt
 * refreshes the row and bumps its version.
 *
 * The reads take the context like everything else and answer egma's entries
 * beside the caller's own. **Owner is derived from tenancy** rather than stored,
 * which is why null tenancy is a state this one table has at all.
 */
export {
  deleteGraderLibraryEntry,
  getGraderLibraryEntry,
  listGraderLibrary,
  seedGraderLibrary,
  type DeletedLibraryEntry,
  type LibraryEntry,
  type LibraryOutputDefinition,
  type LibraryOwner,
  type LibraryPage,
  type LibraryParameter,
  type PredefinedGrader,
  type SeededGrader,
} from "./grader-library.ts";
export {
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  type LibraryParameterKind,
  type LibraryParameterOption,
} from "../grader-library/catalog.ts";
export type { LibraryType, ReservedLibraryType } from "../schema/graders.ts";
export {
  LARGEST_GRADER_SOURCE_CODE_BYTES,
  LIBRARY_TYPES,
  RESERVED_LIBRARY_TYPES,
} from "../schema/graders.ts";

/**
 * The running copies. **`useLibraryEntry` is the only door that makes one** —
 * there is no create taking a type and criteria, because a grader with no
 * library entry behind it would be a check with no words behind it. The rest is
 * the shape every other factory here has: read, edit, list, soft-delete.
 *
 * `seedRunningGraders` is the fourth deployment-configuring export, and it is
 * the other half of the library seeding above: egma's `expected_behaviors`
 * grader has to be *running* in a project for that project's tests to be judged
 * at all, so a deployment that shipped the change writes the copy into every
 * project that has never had one. It names no customer and takes no argument,
 * and it asks whether a project ever had a copy rather than whether it has one
 * now — so somebody who switched theirs off is not overruled at the next boot.
 */
export {
  advanceProductionSampling,
  deleteGrader,
  editGrader,
  getGrader,
  getGraderVersion,
  listGraders,
  useLibraryEntry,
  type DeletedGrader,
  type FilledInForm,
  type Grader,
  type GraderAssertion,
  type GraderChanges,
  type GraderConfig,
  type GraderConfigInput,
  type GraderPage,
  type GraderVersion,
  type JudgeModel,
  type JudgeProvider,
  type UseLibraryEntry,
} from "./graders.ts";
export {
  seedRunningGraders,
  type SeededGraderCopy,
} from "./seeded-graders.ts";
export type { GraderScope } from "../schema/graders.ts";
export {
  GRADER_SCOPES,
  JUDGE_PROVIDERS,
  JUDGE_SOURCES,
} from "../schema/graders.ts";

/**
 * The project's default judge. `resolveJudgeKey` is the one door to the
 * plaintext of a judge key and it takes the context like everything else — and
 * then refuses every context that did not come from a grading claim, because
 * judging is the only thing egma does with one.
 */
export {
  getJudgeConfiguration,
  getProjectJudge,
  resolveJudgeKey,
  seedDefaultJudge,
  setJudgeConfiguration,
  setProjectJudge,
  PLATFORM_JUDGE,
  type JudgeConfiguration,
  type NewJudgeConfiguration,
  type ProjectJudge,
  type ProjectJudgeChoice,
} from "./judges.ts";

/**
 * The organization's judge credentials. Write-only by construction: nothing
 * exported here can answer with a stored key, and the one door to a plaintext
 * one lives behind the grading engine's own context.
 */
export {
  archiveJudgeCredential,
  createJudgeCredential,
  editJudgeCredential,
  getJudgeCredential,
  judgeCredentialUses,
  listJudgeCredentials,
  type JudgeCredential,
  type JudgeCredentialChanges,
  type NewJudgeCredential,
} from "./judge-credentials.ts";
export type { JudgeSource } from "../schema/graders.ts";

/**
 * The organization's model access, and its own provider keys.
 *
 * Write-only by construction on the same terms as the judge credentials above:
 * nothing exported here can answer with a stored key, and the one door to a
 * plaintext one — `resolveModelProviderKeys` — refuses every context that did
 * not come from a simulation or a grading claim.
 */
export {
  GRADING_CAPABILITIES,
  type GradingCapability,
} from "./grading.ts";

export {
  DEFAULT_MODEL_ACCESS,
  readModelAccess,
  resolveModelProviderKeys,
  setModelAccess,
  type ModelAccess,
  type ResolvedProviderKeys,
} from "./model-access.ts";
export {
  listModelProviderCredentials,
  removeModelProviderCredential,
  storeModelProviderCredential,
  type ModelProviderCredential,
  type ModelProviderCredentialInput,
} from "./model-provider-credentials.ts";
/**
 * Managed model access: the inference keys hosted Egma mints, the one a
 * self-hosted deployment connects, and the credential Egma's own two services
 * present at the gateway.
 *
 * The same rule the provider credentials keep, one table over: **nothing
 * exported here can answer with a key.** `listInferenceKeys` answers a name, a
 * safe hint and four times; `readManagedAccessConnection` answers Connected and
 * a hint; and the one door to a usable credential —
 * `resolveManagedAccess` — refuses every context that did not come from a
 * simulation or a grading claim.
 */
export {
  createInferenceKey,
  listInferenceKeys,
  resolveInferenceKey,
  revokeInferenceKey,
  type InferenceKey,
  type NewInferenceKey,
  type ResolvedInferenceKey,
} from "./inference-keys.ts";
export {
  connectManagedAccess,
  disconnectManagedAccess,
  managedAccessAvailable,
  readManagedAccessConnection,
  resolveManagedAccess,
  type ConnectManagedAccess,
  type ManagedAccessConnection,
  type ResolvedManagedAccess,
} from "./managed-access.ts";
export {
  MODEL_ACCESS_MODES,
  type ModelAccessMode,
} from "../schema/models.ts";
export { ENDING_REPAIRS, type EndingRepair } from "../schema/runs.ts";

/**
 * The provider catalog and the selections made from it — release data and pure
 * shapes, reaching no store and taking no context, exactly as the grader
 * library's catalog beside it does.
 */
export {
  MODEL_JOBS,
  MODEL_PROVIDERS,
  PROVIDER_CATALOG,
  PROVIDERS_BY_JOB,
  RECOMMENDED_ENTRY,
  RESERVED_PROVIDER_JOBS,
  type ModelJob,
  type ModelProvider,
  type ProviderCatalogEntry,
} from "../models/catalog.ts";
export {
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  type GraderModel,
  type ModelSelection,
  type PersonaModels,
  type SpeechSelection,
} from "../models/selections.ts";

export {
  cancelRun,
  claimSimulations,
  completeSimulation,
  failSimulation,
  failSimulationDispatch,
  getRun,
  getSimulation,
  getSimulationTestVersion,
  listRunEvents,
  listRuns,
  listSimulations,
  markSimulationCanceled,
  recordSimulationHeartbeat,
  resolveSimulationConnection,
  resolveSimulationStanding,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  type CompletedEndingReason,
  type ConductedSimulation,
  type ConnectionSnapshot,
  type FailedEndingReason,
  type MockToolCoverage,
  type NewRun,
  type Run,
  type RunEvent,
  type RunEventPage,
  type RunPage,
  type Simulation,
  type SimulationClaim,
  type SimulationClaimRequest,
  type SimulationConnection,
  type SimulationFailure,
  type SimulationHeartbeat,
  type SimulationReport,
  type SimulationStanding,
  type SimulationSummaryFacts,
  type StartedRun,
  type SweptSimulation,
} from "./runs.ts";
export type {
  RunEventKind,
  RunStatus,
  RunTrigger,
  SimulationEndingReason,
  SimulationSkipReason,
  SimulationStatus,
  Verdict,
} from "../schema/runs.ts";
/**
 * The four words a run's machinery can be in, exported because the door that
 * filters a history by one has to refuse anything else by name — and a list
 * written a second time at that door is a list that will one day disagree with
 * the check on the table.
 */
export { RUN_STATUSES } from "../schema/runs.ts";

/**
 * A project's run history, and Retry.
 *
 * The history is where a run's machinery and its judgment are read together —
 * two stores, one answer, and the fold below is what keeps the four facts apart
 * inside it. Retry is here rather than beside `startRun` because it must never
 * become a second way to start one: it derives everything from an earlier run
 * and then goes through `startRun` like every other caller.
 */
export {
  listRunHistory,
  readRunFold,
  retryRun,
  type RetryRequest,
  type RunHistoryEntry,
  type RunHistoryPage,
  type RunHistoryRequest,
} from "./run-history.ts";
export type { RunFilter } from "./runs.ts";

/**
 * What a run would freeze, and what one already froze.
 *
 * `planRun` is the review step's read and `startRun`'s own resolver, which is
 * the whole point of it being one function: what the review showed is what
 * starts. `getGradingPlan` answers with what a run actually froze, including
 * the honest `not_recorded` state for history that predates plans.
 */
export {
  getGradingPlan,
  planRun,
  type CapabilityDecision,
  type GradingPlan,
  type JudgeChoice,
  type PlanGroup,
  type PlanItem,
  type PlanJudge,
  type PlannedSimulationGroup,
  type RunPlan,
  type RunPlanRequest,
} from "./run-plans.ts";
export type { GradingPlanState } from "../schema/plans.ts";

export {
  claimGradingJobs,
  finishGradingJob,
  getGradingJob,
  getGradingJobForTrace,
  listGradingJobsForSimulation,
  recordGradingHeartbeat,
  recordProductionTraces,
  regrade,
  releaseGradingJob,
  reopenGradingJob,
  watchGradingWork,
  type GradingClaim,
  type GradingClaimRequest,
  type GradingJob,
  type Regraded,
  type RegradeTarget,
  type RegradeWindow,
} from "./grading.ts";
export type { GradingJobStatus, GradingSource } from "../schema/grading.ts";
export type { Listening } from "../client.ts";

/**
 * The upgrade onto model selections, and what it left behind.
 *
 * `upgradeModelSetup` is the fifth deployment-configuring export, on
 * `seedRunningGraders`' exact terms: it names no customer, takes no
 * `AuthContext`, and runs in the same breath as the migrations because it
 * finishes a change the release shipped. What it will not do is as important as
 * what it does — it never invents a provider, never compares two secrets, and
 * never copies deployment-wide configuration into more than one organization.
 * Where the answer is ambiguous it writes an action instead, and those *are*
 * customer-facing: `listModelUpgradeActions` and `listCredentialCandidates`
 * take the context like every other read, and `activateCredentialCandidate` is
 * the admin-only door that settles a provider with two stored keys.
 *
 * `readModelUpgradeCompletion` is the marker the later removal of the legacy
 * paths is gated on. It writes nothing and takes nothing, because whether this
 * *installation* has finished is a fact about the deployment rather than about
 * anybody on it.
 */
export {
  upgradeModelSetup,
  type ModelUpgradeReport,
} from "./model-upgrade.ts";
export {
  readModelUpgradeCompletion,
  recordModelUpgradeCompletion,
  UPGRADE_CONDITIONS,
  type ModelUpgradeCompletion,
  type UpgradeCondition,
} from "./model-upgrade-completion.ts";
export {
  activateCredentialCandidate,
  listCredentialCandidates,
  listModelUpgradeActions,
  type CredentialCandidate,
  type ModelUpgradeAction,
} from "./model-upgrade-actions.ts";
export type {
  CredentialCandidateSource,
  CredentialEnvelopeShape,
  ModelUpgradeActionKind,
} from "../schema/upgrade.ts";
export {
  CREDENTIAL_CANDIDATE_SOURCES,
  CREDENTIAL_ENVELOPE_SHAPES,
  MODEL_UPGRADE_ACTIONS,
} from "../schema/upgrade.ts";
