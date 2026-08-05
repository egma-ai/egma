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
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  AlreadyBelongsToAnOrganizationError,
  LastAdminError,
  NotPermittedError,
  PersonaNamedByTestsError,
  ProjectOutsideOrganizationError,
  TraceStoreRefusedError,
  UnreadableTraceQueryError,
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
  addConnection,
  createAgent,
  deleteAgent,
  getAgent,
  getConnection,
  listAgents,
  listConnections,
  removeConnection,
  resolveConnectionCredentials,
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
  type NewTest,
  type Test,
  type TestChanges,
  type TestPage,
  type TestPersona,
  type TestVersion,
} from "./tests.ts";

export {
  cancelRun,
  claimSimulations,
  completeSimulation,
  failSimulation,
  getRun,
  getSimulation,
  listRuns,
  listSimulations,
  markSimulationCanceled,
  recordSimulationHeartbeat,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  type CompletedEndingReason,
  type ConnectionSnapshot,
  type FailedEndingReason,
  type NewRun,
  type Run,
  type RunPage,
  type Simulation,
  type SimulationFailure,
  type SimulationReport,
  type StartedRun,
} from "./runs.ts";
export type {
  RunStatus,
  RunTrigger,
  SimulationEndingReason,
  SimulationStatus,
} from "../schema/runs.ts";
