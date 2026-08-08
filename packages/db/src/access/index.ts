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
 * **Instance-scoped.** `instanceIsClaimed`, and only it. It takes nothing and
 * returns a boolean, so it can neither name a customer nor carry a row out. It
 * is asked by the one caller with no credential at all — somebody looking at a
 * signup form — and the same test names it.
 *
 * **Work-dispatching.** `claimGradingJobs`, `watchGradingWork` and
 * `claimSimulations`, and only those three. They are asked by egma's own two
 * services — the grader and the simulator — each of which stands behind every
 * organization on the deployment at once and holds no credential, because
 * there is no honest one to give it. The exemption is narrow and each half of
 * it is enforced: none takes an argument by which a caller could name a
 * customer, and a build rule refuses one that grows one; the only rows any of
 * them reaches are egma's own queues — grading jobs, and the simulations egma
 * itself wrote as queued; a claim carries out identifiers and tenancy and
 * never anything a customer wrote; and every claim arrives with the
 * `AuthContext` narrowed to that row's own organization and project, which is
 * what all of the work afterwards goes through. `grading.ts` writes the
 * reasoning out in full and `runs.ts` inherits it whole. A fourth name in this
 * category is a deliberate act: a test names all three and fails when another
 * appears.
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
 * The two ways a judgment is ever revisited are exported beside them, and
 * neither is an edit: `regrade` reopens the queue so the engine judges a run or
 * a window again at each grader's current version — narrowed to one grader when
 * the ask names one, which is a decision about judge spend rather than about
 * what the rows come to say — and `correctVerdict` writes one person's
 * disagreement as a row of its own with the machine's still underneath it. Both
 * take the context like everything else, and both are the whole API for
 * revisiting a verdict today — there are no routes above them yet, and this
 * surface is the altitude the product is reachable at.
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  AgentWriteRefusedError,
  AlreadyBelongsToAnOrganizationError,
  GraderNamedByTestsError,
  LastAdminError,
  NotPermittedError,
  PersonaNamedByTestsError,
  ProjectOutsideOrganizationError,
  RunWriteRefusedError,
  TestMovedOnError,
  TraceStoreRefusedError,
  UnprocessableInputError,
  UnreadableTraceQueryError,
  type AgentWriteRefusal,
  type RunWriteRefusal,
  type TestNamingGrader,
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

export {
  readOrganization,
  readOrganizationSettings,
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
  type NewProject,
  type Project,
} from "./projects.ts";

export {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  resolveApiKey,
  type ApiKey,
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
  correctVerdict,
  readRunVerdicts,
  readVerdicts,
  type AppendedVerdicts,
  type NewVerdict,
  type ReadVerdictsOptions,
  type RecordedVerdict,
  type RunVerdicts,
  type SimulationVerdicts,
  type TraceVerdicts,
  type VerdictCorrection,
} from "./verdicts.ts";

export {
  addConnection,
  createAgent,
  deleteAgent,
  getAgent,
  getConnection,
  listAgents,
  listConnections,
  registerAgent,
  removeConnection,
  updateAgent,
  updateConnection,
  type Agent,
  type AgentChanges,
  type AgentPage,
  type Connection,
  type ConnectionChanges,
  type CreatedAgent,
  type DeletedAgent,
  type NewAgent,
  type NewConnection,
  type Registration,
  type RegistrationResult,
  type RemovedConnection,
} from "./agents.ts";
export type {
  ConnectionType,
  Modality,
  Topology,
} from "../schema/agents.ts";

export {
  clonePersona,
  createPersona,
  deletePersona,
  editPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  resolvePersonaNames,
  VOICE_PROVIDERS,
  type DeletedPersona,
  type NewPersona,
  type Persona,
  type PersonaChanges,
  type PersonaPage,
  type PersonaTraits,
  type PersonaVersion,
  type VoiceProvider,
} from "./personas.ts";

export {
  cloneTest,
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
  type DeletedTest,
  type ExpectedBehavior,
  type ExpectedBehaviorInput,
  type NewTest,
  type Test,
  type TestChanges,
  type TestGrader,
  type TestPage,
  type TestPersona,
  type TestVersion,
} from "./tests.ts";

export {
  advanceProductionSampling,
  createGrader,
  deleteGrader,
  editGrader,
  getGrader,
  getGraderVersion,
  listGraders,
  type DeletedGrader,
  type Grader,
  type GraderChanges,
  type GraderConfig,
  type GraderConfigInput,
  type GraderJudgment,
  type GraderPage,
  type GraderVersion,
  type JudgeModel,
  type JudgeProvider,
  type LlmRubricConfig,
  type MeasureAggregation,
  type MetricThresholdConfig,
  type NewGrader,
  type NewGraderJudgment,
  type Phrase,
  type PhraseInput,
  type PhraseMatch,
  type PhraseMatchConfig,
  type PhraseMatchConfigInput,
  type PhraseSpeaker,
  type ThresholdComparator,
  type ToolCallsConfig,
  type ToolCallsConfigInput,
  type ToolExpectation,
  type ToolExpectationInput,
} from "./graders.ts";
export type {
  GraderScope,
  GraderType,
  Priority,
} from "../schema/graders.ts";

/**
 * The project's default judge. `resolveJudgeKey` is the one door to the
 * plaintext of a judge key and it takes the context like everything else — and
 * then refuses every context that did not come from a grading claim, because
 * judging is the only thing egma does with one.
 */
export {
  getJudgeConfiguration,
  resolveJudgeKey,
  setJudgeConfiguration,
  type JudgeConfiguration,
  type NewJudgeConfiguration,
} from "./judges.ts";

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
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  type CompletedEndingReason,
  type ConductedSimulation,
  type ConnectionSnapshot,
  type FailedEndingReason,
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
