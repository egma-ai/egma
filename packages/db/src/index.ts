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
 * The shape of an assertion key, on the fold's own terms and for the fold's own
 * reason: it reaches nothing, so there is no tenancy to stamp and no
 * `AuthContext` to take, and it is exported all the same because it is the
 * **one** place the format is written down.
 *
 * The two halves are one round trip made in two processes — the engine writes a
 * verdict row with the first, a page reads the words back with the second — and
 * a format each half knew for itself would be a format one of them could
 * improve alone. A verdict row is permanent, so that fork would show up not as a
 * bug but as a page that quietly stopped resolving last month's rows.
 */
export {
  behaviorAssertionAt,
  behaviorAssertionKey,
} from "./grader-library/assertion-keys.ts";
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
 * The shared measure module: the catalog's numbers, computed from a
 * conversation's spans.
 *
 * Here for the fold's reason and on the fold's terms — it reaches nothing, takes
 * no context, and is handed spans a caller already read. Exported because it is
 * the **one** place a measure is worked out: the metrics display reads through
 * it and so does the grader that bounds one, for a simulation and a production
 * trace alike, so the number on a page and the number a verdict was decided by
 * are the same arithmetic. A second implementation in a query, in a page or in
 * the grading service would be a second answer about one conversation with
 * nothing stored to settle it against.
 */
export {
  everySpanIn,
  measuresFromSpans,
  worstSampleOf,
  type MeasuredFromSpans,
  type Sample,
  type SpannedConversation,
} from "./measures/from-spans.ts";

export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
