/**
 * The data-access boundary.
 *
 * Customer reads and writes take an `AuthContext`. This module builds tenancy
 * predicates from that context. The Postgres pool and ClickHouse driver stay
 * private, and lint rules prevent other packages from importing either driver.
 *
 * A small set of context-establishing calls resolves credentials or membership.
 * A second small set dispatches platform work across all tenants. Those worker
 * calls return an `AuthContext` narrowed to the row they claimed, so every later
 * read and write uses the normal tenant boundary.
 *
 * ClickHouse has two product records behind the same boundary. Spans are the
 * trace evidence. Grades are append-only results tied to one trace and one
 * project grader. Trace reads require a bounded time window. Grade reads require
 * the exact trace and frozen plan. Regrading reopens whole-trace work; it never
 * edits or removes prior grade rows.
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  AgentWriteRefusedError,
  AlreadyBelongsToAnOrganizationError,
  ConnectionRestoreRefusedError,
  DefaultPersonaReplacementError,
  IdempotencyConflictError,
  IdentityConflictError,
  LastAdminError,
  MockToolTakenError,
  NotPermittedError,
  OversizeRecordError,
  PersonaNameAmbiguousError,
  PersonaNamedByTestsError,
  EgmaProvidedPersonaError,
  ProjectOutsideOrganizationError,
  ProjectSlugTakenError,
  RunWriteRefusedError,
  TestMovedOnError,
  TraceStoreRefusedError,
  UnprocessableInputError,
  UnreadableTraceQueryError,
  UnstorableInstantError,
  VersionConflictError,
  WriteAbortedError,
  type AgentWriteRefusal,
  type ConnectionRestoreRefusal,
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
  appendGrades,
  readProductionGradingPlan,
  readTraceGrades,
  recordProductionGradingPlan,
  ProductionGradingPlanConflictError,
  type AppendedGrades,
  type CurrentGrade,
  type GradeAssertion,
  type GradeDetails,
  type GradeSource,
  type NewGrade,
  type NewProductionGradingPlan,
  type ProductionGradingPlan,
  type ProductionGradingPlanEntry,
  type RecordedGrade,
  type TraceGrades,
} from "./grades.ts";

export {
  addConnection,
  archiveAgent,
  archiveConnection,
  connectionKindOf,
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
  ConnectionKind,
  Modality,
  Topology,
} from "../schema/agents.ts";

export {
  checkpointRetellMonitoringPage,
  claimDueRetellMonitoringAgent,
  configureLiveKitMonitoring,
  configureRetellMonitoring,
  deleteRetellCallRetry,
  dueRetellCallRetries,
  failRetellMonitoringTarget,
  finishRetellMonitoringScan,
  listMonitoringSetups,
  MOST_RETELL_CALL_ATTEMPTS,
  recordProductionEvidenceReceived,
  recordRetellCallAttempt,
  recoverRetellMonitoringSetup,
  releaseRetellMonitoringLease,
  removeMonitoringSetup,
  renewRetellMonitoringLease,
  sweepExpiredRetellCallMarkers,
  transientRetellCallState,
  yieldRetellMonitoringLease,
  type MonitoringFailureKind,
  type MonitoringSetup,
  type RetellCallAttemptOutcome,
  type RetellMonitoredAgent,
  type RetellMonitoringTarget,
  type SelectedRetellAgent,
  type TransientRetellCall,
} from "./production-monitoring.ts";
// The list beside the type, because a caller deciding whether a word names a
// platform Monitoring keeps a setup for has to ask the shipped list rather than
// write two names out again — the drainer does exactly that before it moves a
// customer's last-received state.
export { MONITORING_PLATFORMS } from "../schema/production.ts";
export type {
  MonitoringHealthState,
  MonitoringPlatform,
  MonitoringStrategy,
  RetellMonitoredAgentState,
  RetellScanKind,
} from "../schema/production.ts";


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

export {
  getGraderDefinition,
  getGraderDefinitionVersion,
  listGraderDefinitions,
  reconcileGraderCatalog,
  type GraderDefinition,
  type ReconciledGraderCatalog,
  type ReconciledGraderDefinition,
} from "./grader-library.ts";
export {
  GRADER_DEFINITION_CATALOG,
  PREDEFINED_GRADERS,
  type GraderOutputContract,
  type GraderParameter,
  type PredefinedGraderDefinition,
} from "../grader-library/catalog.ts";
export {
  GRADER_DEFINITION_TYPES,
  GRADER_MODALITIES,
  type GraderDefinitionType,
  type GraderJudgeModel,
  type GraderModality,
  type ProjectGraderScope,
  type SimulationScopeSelector,
} from "../schema/graders.ts";

export {
  archiveProjectGrader,
  editProjectGrader,
  getExecutableGraderDefinition,
  getProjectGrader,
  listProjectGraders,
  type GraderDefinitionSnapshot,
  type ProjectGrader,
  type ProjectGraderChanges,
} from "./graders.ts";
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
  simulationStatusCountsOfRuns,
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
} from "../schema/runs.ts";
/**
 * The four words a run's machinery can be in, exported because the door that
 * filters a history by one has to refuse anything else by name — and a list
 * written a second time at that door is a list that will one day disagree with
 * the check on the table.
 */
export { RUN_STATUSES } from "../schema/runs.ts";

export type { RunFilter } from "./runs.ts";

/**
 * What a run froze for grading.
 */
export {
  applicableGraders,
  getGradingPlan,
  pinnedSimulationGradersOn,
  pinnedSimulationGraders,
  resolvePersonaVersions,
  resolveProductionGraders,
  writeGradingPlan,
  type GradingPlan,
} from "./run-plans.ts";
export type { GradingPlanState } from "../schema/plans.ts";

export {
  GRADING_WORK_CHANNEL,
  claimGradingJobs,
  finishGradingJob,
  getGradingJob,
  getGradingJobForTrace,
  listGradingJobsForSimulation,
  recordGradingHeartbeat,
  MOST_GRADING_ATTEMPTS,
  recordProductionTraces,
  readRunGradingProgress,
  readSimulationGradingStates,
  readTraceGrading,
  regradeTrace,
  requestGrading,
  releaseGradingJob,
  traceEvidenceStartedAt,
  watchGradingWork,
  type GradingClaim,
  type GradingClaimRequest,
  type GradingJob,
  type GradingRequest,
  type GradingRequestResult,
  type RegradeTraceResult,
  type NamedCurrentGrade,
  type NamedRecordedGrade,
  type TraceGrading,
  type TraceGradingRef,
  type TraceGradingState,
} from "./grading.ts";
export type {
  FrozenGradingEntry,
  GradingJobStatus,
  GradingSource,
} from "../schema/grading.ts";
export type { Listening } from "../client.ts";

export {
  DRAIN_ADVISORY_LOCK,
  openDrainOwnership,
  type DrainOwnership,
} from "./drain-ownership.ts";
