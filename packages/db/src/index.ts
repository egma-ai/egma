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
/**
 * The fold, and the vocabulary it is written in.
 *
 * It is here rather than on the data-access surface because it reaches nothing:
 * it is handed verdict rows a caller already holds and returns arithmetic over
 * them, so there is no tenancy for it to stamp and no `AuthContext` for it to
 * take. Exported all the same, and from the same entry point, because it is the
 * **one** place a grader's, a conversation's or a run's outcome is worked out.
 * A second implementation anywhere — in a query, in a page, in the grading
 * service — is a second answer that can disagree with this one, and no row is
 * ever written that a disagreement could be settled against.
 */
export {
  foldVerdicts,
  foldVerdictsByGrader,
  speakingVerdicts,
  JUDGED_BY_HUMAN,
  PRIORITIES,
  VERDICTS,
  type FoldableVerdict,
  type FoldedOutcome,
  type GraderOutcome,
  type Priority,
  type Verdict,
  type VerdictCounts,
  type VerdictSource,
} from "./verdicts/fold.ts";
/**
 * The mocked world a simulation runs in, worked out from what its run froze.
 * It is here beside the verdict fold and for the fold's reason: it reaches no
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

/**
 * The two catalogs a form is drawn from, and the readers that hold a key to
 * them.
 *
 * They are here beside the verdict fold and for the fold's reason: they reach
 * no store, take no context, and have no tenancy to stamp. The connection
 * registry decides what a connection type is made of and the capability catalog
 * decides which capability names exist; both are code rather than tables,
 * because a table could claim a type no adapter can run or a capability no test
 * could require.
 *
 * Exported all the same, and from this entry point, because a browser form has
 * to be drawn from them. **What crosses is labels, field shapes, the credential
 * rule and the adapter facts** — never a gate, a hint function, a refusal
 * sentence or a credential. A second handwritten copy of any of it in a web
 * application would be a second opinion able to disagree with the gate.
 */
export {
  connectionTypeMetadata,
  credentialRuleOf,
  variantById,
  variantIdOf,
  type ConfigFieldKind,
  type ConfigFieldMetadata,
  type ConnectionTypeMetadata,
  type CredentialFieldKind,
  type CredentialFieldMetadata,
  type CredentialRuleName,
  type VariantMetadata,
} from "./access/connection-registry.ts";
export {
  admittedCapabilities,
  capabilityCheckFailedMessage,
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  hasCapabilityDiscovery,
  isCapabilityKey,
  noCapabilityAdapterMessage,
  registerCapabilityDiscovery,
  unknownCapabilityMessage,
  type CapabilityDiscovery,
  type CapabilityEntry,
  type ConnectionCapabilities,
  type DiscoveryTarget,
} from "./access/capabilities.ts";
export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
