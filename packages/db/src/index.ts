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
/**
 * The mocked world a simulation runs in, worked out from what its run froze.
 * It is here beside other shared pure helpers for the same reason: it reaches no
 * store, takes no context, and is the one place a project default and a test
 * override are merged.
 */
export {
  isErrorAnswer,
  resolveMockTools,
  NO_MOCK_TOOLS,
  type MockToolAnswer,
  type MockToolSnapshot,
  type ResolvedMockTool,
  type SnapshotDefault,
  type SnapshotEntry,
} from "./mock-tools/resolve.ts";
/** Pure grader policy parsing and validation; no store is read or written. */
export {
  validatePassThreshold,
  validateProjectGraderScope,
} from "./grader-library/policy.ts";

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
 * The two catalogs a form is drawn from, and the readers that hold a key to
 * them.
 *
 * They are here beside other shared product catalogs because they reach
 * no store, take no context, and have no tenancy to stamp. The connection
 * registry decides what a connection type is made of in code rather than a
 * table, so stored rows cannot name a kind no adapter can run.
 *
 * Exported all the same, and from this entry point, because a browser form has
 * to be drawn from them. **What crosses is labels, field shapes, the credential
 * rule and the adapter facts** — never a gate, a hint function, a refusal
 * sentence or a credential. A second handwritten copy of any of it in a web
 * application would be a second opinion able to disagree with the gate.
 */
export {
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
/**
 * The two pure decisions about one span's evidence, taken before it is stored
 * and again by whoever stores it.
 *
 * Here rather than on the data-access surface, and for that surface's own
 * reason: neither reaches a store. A record goes in, a fingerprint or a refusal
 * comes out, and there is no tenancy to stamp because there is nothing to stamp
 * it on. Exported all the same, and from the same entry point as the folds,
 * because each has to be worked out in exactly one place. The acceptance path
 * refuses an oversize record before it is staged and fingerprints what it
 * stages; this package fingerprints the row and compares it against what is
 * already stored. Two implementations of either is one of them deciding that a
 * conflict is a replay, or that a cut value is a whole one.
 */
export {
  LARGEST_BOUNDED_RECORD_BYTES,
  refuseOversizeRecord,
  refuseUnstorableInstant,
  spanContentHash,
} from "./access/spans.ts";
export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
