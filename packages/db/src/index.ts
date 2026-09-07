export { connect, disconnect, ping, type ConnectOptions } from "./client.ts";
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
  PERSONA_PARAMETER_CONTRACT,
  personaParameterContract,
  personaParametersOfModels,
  personaModelsOfParameters,
  validatePersonaParameterContract,
  validatePersonaParameterValues,
  type PersonaParameterValues,
} from "./persona-library/parameters.ts";
export type { ProjectPersonaSettings } from "./access/project-personas.ts";
