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
  type AllowanceTotals,
  type PeriodUsage,
} from "./billing/period-usage.ts";
export {
  billingIsConfigured,
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
  graderJudgeProviders,
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
/**
 * What a test's own world may cost the wire that carries it, and the one
 * serialization the dispatch is measured on.
 *
 * Here beside the span limits above for the span limits' own reason: none of
 * them reaches a store, and each has to be said in a refusal by whoever
 * enforces it. **The same rules are applied twice by design** — once at
 * authoring time, where the person who can fix a refusal is reading, and once
 * where the value is actually carried — so a second copy of a number, or a
 * second serializer with different spacing, would be two caps measuring two
 * different things and calling both the limit.
 */
export {
  LARGEST_JOB_DISPATCH_METADATA_BYTES,
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  RESERVED_ENV_VARIABLE_PREFIX,
  serializedJobDispatchMetadata,
} from "./access/tests.ts";
export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
