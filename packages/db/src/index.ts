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
  verdictLanes,
  VERDICTS,
  type Diagnostics,
  type FoldableVerdict,
  type FoldedOutcome,
  type GraderOutcome,
  type Verdict,
  type VerdictCounts,
  type VerdictLanes,
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

export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
