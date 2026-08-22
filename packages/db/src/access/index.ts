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
 * **Instance-scoped.** `instanceIsClaimed` takes nothing, so it cannot name a
 * customer. It returns only whether signup has been claimed.
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
 * the other half of what the drainer does with a segment. It is handed the very
 * same spans, and only after they are query-visible: the trace store gets the
 * rows, and the grader-owned boundary gets one row per conversation saying when
 * egma last heard about it and whether a span the platform said ends it has
 * arrived. Taking the spans rather than a summary of them is what keeps "when is
 * a conversation over" written down once. It is a bookkeeping row and a
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
 * not an edit: `regrade` reopens the queue. A simulation keeps the grader
 * versions its run pinned; a production window has no run plan and uses current
 * versions. Either can be narrowed to one grader identity when the ask names
 * one, which is a decision about judge spend rather than about what the rows
 * come to say. A person's disagreement is not a door here at all:
 * corrections leave v0 with the `judged_by` column that carried them, and return
 * as the reserved `human` grader type, which writes ordinary verdict rows under
 * a grader id of its own.
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  AgentWriteRefusedError,
  AlreadyBelongsToAnOrganizationError,
  ConnectionRestoreRefusedError,
  DefaultPersonaReplacementError,
  GraderLibraryEntryInUseError,
  IdempotencyConflictError,
  IdentityConflictError,
  LastAdminError,
  MockToolTakenError,
  NotPermittedError,
  OversizeRecordError,
  PersonaNameAmbiguousError,
  PersonaNamedByTestsError,
  EgmaProvidedPersonaError,
  PredefinedGraderError,
  ProjectOutsideOrganizationError,
  ProjectSlugTakenError,
  RunWriteRefusedError,
  TestMovedOnError,
  TraceStoreRefusedError,
  UnknownGraderLibraryEntryError,
  UnprocessableInputError,
  UnreadableTraceQueryError,
  UnstorableInstantError,
  VersionConflictError,
  WriteAbortedError,
  type AgentWriteRefusal,
  type ConnectionRestoreRefusal,
  type GraderUsingLibraryEntry,
  type RunWriteRefusal,
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
  type NewOrganization,
  type ProvisionedOrganization,
} from "./provisioning.ts";
export { instanceIsClaimed } from "./instance.ts";

/**
 * The non-model settings this deployment holds. Carrier credentials are sealed
 * with the deployment's own key, hinted rather than handed back, seeded from
 * the environment at start and never over a value somebody chose.
 * `platformFacts` is another instance-scoped export: it takes nothing,
 * so there is no customer to name, and it answers only what is not secret. The
 * API uses it to enforce the carrier precondition before it creates phone work.
 *
 * The read and the write take the deployment's own tenancy beside the context,
 * because who may be here depends on it: an organization owner may, and only
 * while this deployment serves one organization.
 *
 * `reconcileDeploymentCarrierSettings` is the hosted deployment's explicit
 * carrier path. Its environment is the source of truth, so it replaces only a
 * differing complete carrier route. It takes no context because startup has no
 * user or customer; like seeding, it is the deployment configuring itself.
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
  reconcileDeploymentCarrierSettings,
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
  isProjectOfOrganization,
  listProjects,
  projectOfOrganizationState,
  projectsOf,
  readProject,
  createProject,
  updateProject,
  type NewProject,
  type Project,
  type ProjectChanges,
  type ProjectTenancyState,
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
  type AppendSpansOptions,
  type AppendedSpans,
  type NewSpan,
  type SpanEmitter,
  type SpanSource,
} from "./spans.ts";

/**
 * The two identity probes, beside the write they exist for.
 *
 * Neither reads evidence: one answers which spans the store already holds and
 * what each of them says as a fingerprint, the other answers which of a list of
 * traces exist. They take the context like every other call here and stamp the
 * tenancy from it, and each takes a window it cannot be called without.
 */
export {
  committedSpans,
  committedTraces,
  type CommittedSpan,
  type CommittedSpansOptions,
  type CommittedTracesOptions,
  type SpanIdentity,
} from "./span-identity.ts";

export {
  listTraces,
  readTrace,
  MAXIMUM_LIST_LIMIT,
  MAXIMUM_SPANS_PER_TRACE,
  MAXIMUM_WINDOW_MILLISECONDS,
  type ListTracesOptions,
  type ReadTraceOptions,
  type ReportedOnTrace,
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
  registerAgent,
  restoreAgent,
  restoreConnection,
  updateAgent,
  updateConnection,
  type Agent,
  type AgentChanges,
  type AgentPage,
  type AgentWithConnections,
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
  AccessVariant,
  AgentPlatform,
  ConnectionType,
  Modality,
  Topology,
} from "../schema/agents.ts";
// The list beside the type, because a caller deciding whether a word names an
// agent platform has to ask the shipped list rather than write two names out
// again — the drainer does exactly that before it moves an agent's
// last-received state.
export { AGENT_PLATFORMS } from "../schema/agents.ts";

export {
  checkpointMonitoringPage,
  claimDueMonitoringAgent,
  deleteProductionCallFailure,
  dueProductionCallRetries,
  failMonitoringTarget,
  finishMonitoringScan,
  MOST_PRODUCTION_CALL_ATTEMPTS,
  recordProductionCallAttempt,
  recordProductionEvidenceReceived,
  renewMonitoringLease,
  startPullingProductionCalls,
  stopPullingProductionCalls,
  sweepExpiredProductionCallMarkers,
  transientProductionCallState,
  yieldMonitoringLease,
  type MonitoringFailureKind,
  type MonitoringTarget,
  type ProductionCallAttemptOutcome,
  type PullSwitch,
  type TransientProductionCall,
} from "./production-monitoring.ts";
export type { MonitoringScanKind } from "../schema/production.ts";


export {
  archivePersona,
  createPersona,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  listPersonaVersions,
  resolvePersonaNames,
  restorePersona,
  setDefaultPersona,
  testsUsingPersona,
  type ArchiveRequest,
  type NewPersona,
  type Persona,
  type PersonaChanges,
  type PersonaListRequest,
  type PersonaPage,
  type PersonaOwner,
  type PersonaTraits,
  type PersonaVersion,
  type PersonaVersionPage,
  type RestoreRequest,
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
  createTestSuite,
  deleteTestSuite,
  getTestSuite,
  listTestSuites,
  renameTestSuite,
  type NewTestSuite,
  type RenameTestSuite,
  type TestSuite,
  type TestSuitePage,
} from "./suites.ts";

export {
  applyRepositoryChangeSet,
  type AppliedRepositoryChangeSet,
  type RepositoryChangeSet,
} from "./repository-change-set.ts";

export {
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
  listTestVersions,
  type ExpectedBehavior,
  type MockOverride,
  type MockOverrideInput,
  type NewTest,
  type Test,
  type TestChanges,
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
  type ExecutableGrader,
  type FilledInForm,
  type Grader,
  type GraderAssertion,
  type GraderChanges,
  type GraderConfig,
  type GraderConfigInput,
  type GraderDefinitionSnapshot,
  type GraderPage,
  type GraderVersion,
  type JudgeModel,
  type UseLibraryEntry,
} from "./graders.ts";
export {
  seedRunningGraders,
  type SeededGraderCopy,
} from "./seeded-graders.ts";
export type { GraderScope } from "../schema/graders.ts";
export {
  GRADER_SCOPES,
} from "../schema/graders.ts";

export {
  cancelRun,
  claimSimulations,
  completeSimulation,
  failSimulation,
  failSimulationDispatch,
  getRun,
  getSimulation,
  getSimulationExecutionEvidence,
  getSimulationTestVersion,
  listRunEvents,
  listRuns,
  listSimulations,
  markSimulationCanceled,
  recordSimulationHeartbeat,
  releaseSimulationClaim,
  resolveSimulationConnection,
  resolveSimulationStanding,
  runAlreadyStartedFor,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  type CompletedEndingReason,
  type ConductedSimulation,
  type ConnectionSnapshot,
  type FailedEndingReason,
  type ExpectedTestVersion,
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
  type SimulationExecutionEvidence,
  type SimulationFailure,
  type SimulationHeartbeat,
  type SimulationPage,
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
 * A project's run history.
 *
 * The history is where a run's machinery and its judgment are read together —
 * two stores, one answer, and the fold below is what keeps the four facts apart.
 */
export {
  listRunHistory,
  readRunFold,
  type RunHistoryEntry,
  type RunHistoryPage,
  type RunHistoryRequest,
} from "./run-history.ts";
export type { RunFilter } from "./runs.ts";

/**
 * What a run froze for grading.
 */
export {
  getGradingPlan,
  pinnedSimulationGraders,
  type GradingPlan,
  type PlanGroup,
  type PlanItem,
} from "./run-plans.ts";
export type { GradingPlanState } from "../schema/plans.ts";

export {
  claimGradingJobs,
  finishGradingJob,
  getGradingJob,
  getGradingJobForTrace,
  listGradingJobsForSimulation,
  recordGradingHeartbeat,
  MOST_GRADING_ATTEMPTS,
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

export {
  DRAIN_ADVISORY_LOCK,
  openDrainOwnership,
  type DrainOwnership,
} from "./drain-ownership.ts";
