export {
  connect,
  disconnect,
  fencedDatabase,
  ping,
  type ConnectOptions,
  type Database,
  type Queryable,
  type Transaction,
} from "./client.ts";
export {
  MIGRATIONS_DIRECTORY,
  readMigrations,
  runMigrations,
  type Migration,
  type MigrationResult,
} from "./migrate.ts";
export {
  connectClickHouse,
  disconnectClickHouse,
  pingClickHouse,
  type ClickHouseConnectOptions,
} from "./clickhouse/client.ts";
export {
  CLICKHOUSE_MIGRATIONS_DIRECTORY,
  runClickHouseMigrations,
} from "./clickhouse/migrate.ts";
export {
  identityId,
  identityStore,
  IDENTITY_MODELS,
  type IdentityModel,
} from "./identity-store.ts";
export {
  PERSONA_LIBRARY_CATALOG,
  EGMA_PROVIDED_PERSONAS,
  type EgmaProvidedPersona,
  type EgmaProvidedPersonaVersion,
} from "./persona-library/catalog.ts";
export {
  seedPersonaLibrary,
  type SeededPersona,
} from "./persona-library/seed.ts";
export {
  upsertRateCard,
  type UpsertedRateCard,
} from "./rate-card/seed.ts";
/**
 * What a month of platform usage is, and the seam billing plugs into.
 *
 * Neither reaches a store. The first is arithmetic over a simulation row's own
 * frozen facts, and it crosses the boundary because the page that shows a
 * month, the read that sums it and any adapter that limits it have to be
 * counting the same thing. The second is two interfaces and the answers a
 * deployment with no billing gives; the process that boots chooses the adapter
 * once, from its settings, and every seam that asks reaches it from inside
 * this package.
 */
export {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  SHORTEST_BILLABLE_SECONDS,
  allowanceKindOf,
  allowanceKindsAmong,
  allowancePeriodAt,
  allowanceUsedBy,
  billableSecondsOf,
  minutesFromSeconds,
  type AllowanceKind,
  type AllowancePeriod,
} from "./billing/allowance.ts";
/**
 * A month of usage as one query, and the period arithmetic under it.
 *
 * It reaches no store: predicates and aggregate expressions go out, and
 * whoever runs them supplies the tenancy and the connection. It crosses the
 * boundary for the reason the pure arithmetic beside it does — the page that
 * shows a month and the adapter that limits one must be counting the same
 * thing, and a second copy of the SQL is a second answer a customer would find
 * before a test did.
 */
export {
  allowanceTotalsSelection,
  begunInThePeriod,
  organizationInThePeriod,
  periodAt,
  periodUsageFrom,
  voiceSecondsSelection,
  type AllowanceTotals,
  type PeriodUsage,
  type VoiceSeconds,
} from "./billing/period-usage.ts";
export {
  billing,
  billingIsConfigured,
  faultTolerantEntitlements,
  discardingUsageSink,
  installBillingPlugIn,
  openBillingPlugIn,
  openEntitlementSource,
  type AllowanceRefusal,
  type BillingPlugIn,
  type BillingSettings,
  type EntitlementSource,
  type FundingDecision,
  type FundingRequest,
  type StartDecision,
  type StartRequest,
  type StoredUsageRecord,
  type UsageSink,
} from "./billing/ports.ts";
export {
  entitlementSourceContract,
  usageSinkContract,
  type AdapterFactory,
  type PortCheck,
  type PortWorld,
} from "./billing/contract.ts";
/**
 * The rate card's vocabulary and its coverage rule. No store is reached: a
 * catalog and a parsed file go in, and the usage types Egma measures, the unit
 * each is counted in, and the models with no price come out. It crosses the
 * boundary because the simulator's ingest, the grader and the tests all have
 * to write the same words, and a second list of them is a second answer to
 * what a token is.
 */
export {
  USAGE_TYPES,
  USAGE_UNITS,
  billableUsageTypesOf,
  catalogModelsMissingAPrice,
  isUsageType,
  readRateCard,
  unitOfQuantities,
  unitOfUsageType,
  type RateCardEntry,
  type RateCardPrice,
  type UsageType,
  type UsageUnit,
} from "./models/rate-card.ts";
export {
  MODEL_ADAPTERS,
  MODEL_JOBS,
  MODEL_PROVIDERS,
  PROVIDER_CATALOG,
  PROVIDERS_BY_JOB,
  RECOMMENDED_ENTRY,
  catalogEntry,
  isModelProvider,
  type ModelAdapter,
  type ModelAdapterByJob,
  type ModelJob,
  type ModelProvider,
  type ProviderCatalogEntry,
  type ReasoningEffort,
} from "./models/catalog.ts";
export {
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  graderModelFromRow,
  personaModelsFromRow,
  providersNeededBy,
  sameGraderModel,
  samePersonaModels,
  validGraderModel,
  validPersonaModels,
  type GraderModel,
  type LlmSelection,
  type ModelSelection,
  type PersonaModels,
  type SpeechSelection,
} from "./models/selections.ts";
export { fromOnePov, povOf, type SpanPov } from "./models/pov.ts";
/**
 * The put-it-back note a mocked run leaves behind, and its serialization. Pure:
 * it reads and writes no store.
 */
export {
  mockMetadataAsPublished,
  mockMetadataFrom,
  mockMetadataRow,
  type MockEngineNote,
  type MockMetadata,
  type MockToolVariable,
} from "./mock-tools/record.ts";
/**
 * Which connection lanes serve a test's mock tools, and which of them branch a
 * temporary copy to do it. The gate beside them is not exported: it is a
 * condition inside the claim, and nothing outside this package has a query to
 * put it in.
 */
export {
  connectionTypeBranchesMockDraft,
  DRAFT_MOCK_CONNECTION_TYPES,
  LANES_SERVING_MOCK_TOOLS,
  type DraftMockConnectionType,
} from "./mock-tools/lanes.ts";
/** Pure grader policy parsing and validation; no store is read or written. */
export {
  validatePassThreshold,
  validateProjectGraderScope,
} from "./grader-library/policy.ts";

/** Shared connection capability check for agent POV ingestion and grading waits. */
export { laneProducesAnAgentPov } from "./schema/agents.ts";

/**
 * Pure grading decisions over policy or rows that a tenant-scoped read already
 * returned. These helpers do not create a quality verdict above one grader.
 */
export {
  planGroupsFor,
  productionSampleSelected,
  resolveSimulationGraders,
  type ExecutableProjectGrader,
  type PlanGroup,
  type PlanItem,
} from "./grading/plan.ts";
export {
  combinedGradeScore,
  currentGrades,
  type CurrentGradeOf,
  type GradeForCurrentResult,
  type GradeResult,
} from "./grading/results.ts";

/**
 * Pure connection registry lookups and browser-safe catalog projections.
 * Send connectionOptionMetadata to clients, not raw access variant descriptors.
 */
export {
  connectionTypeReadsPlatformAtRunStart,
  connectionTypeUsesPlatformCarrier,
  connectionOptionMetadata,
  credentialRuleOf,
  productLabelOf,
  accessVariantById,
  type ConfigFieldKind,
  type ConfigFieldMetadata,
  type ConnectionOptionMetadata,
  type CredentialFieldKind,
  type CredentialFieldMetadata,
  type CredentialRuleName,
  type AccessVariantMetadata,
} from "./access/connection-registry.ts";
/** Shared pure evidence limits, validation, and hashing for ingestion and storage. */
export {
  LARGEST_BOUNDED_RECORD_BYTES,
  refuseOversizeRecord,
  refuseUnstorableInstant,
  spanContentHash,
} from "./access/spans.ts";
/** Shared mock reply limits and dispatch serialization for authoring and execution. */
export {
  LARGEST_JOB_DISPATCH_METADATA_BYTES,
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  RESERVED_ENV_VARIABLE_PREFIX,
  serializedJobDispatchMetadata,
} from "./access/tests.ts";
export * from "./access/index.ts";
export * as schema from "./schema/index.ts";

export { defaultGraderParameterValues, LLM_GRADER_PARAMETER_CONTRACT, graderModelOfParameters, validateExecutableGraderParameters, validateGraderParameterContract, validateGraderParameterValues, type GraderParameterValues } from "./grader-library/parameters.ts";
export { usePersona, PersonaVersionConflictError } from "./access/personas.ts";
export {
  defaultPersonaParameterValues,
  legacyPersonaParameterContract,
  PERSONA_EMOTIONS,
  PERSONA_EXECUTION_POLICY_VERSION,
  PERSONA_PARAMETER_CONTRACT,
  SPEECH_VOLUME_RANGE,
  personaControlsOfParameters,
  personaParameterContract,
  personaParametersOfModels,
  personaParametersOfSettings,
  personaModelsOfParameters,
  personaSettingsOfParameters,
  speechProvidersOfParameters,
  validPersonaControls,
  validatePersonaParameterContract,
  validatePersonaParameterValues,
  type PersonaControls,
  type PersonaEmotion,
  type PersonaParameterValues,
  type PersonaSettings,
} from "./persona-library/parameters.ts";
export type { ProjectPersonaSettings } from "./access/project-personas.ts";

export { readPlatformUsageTotal } from "./billing/usage.ts";
export { providerUsageSpan } from "./models/provider-usage.ts";

export {listCustomerFundedProviders} from './billing/provider-keys.ts';
