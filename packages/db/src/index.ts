export { connect, disconnect, ping, type ConnectOptions } from "./client.ts";
/**
 * What kind of deployment this is, and how its own connections to the Egma
 * model gateway are signed.
 *
 * Here beside `connect` rather than on the data-access surface because it
 * reaches no store and takes no context: it is deployment configuration handed
 * in at boot, and the format of the internal gateway credential, which the
 * gateway's verifier reads at the other end of the wire. Exported because it is
 * the **one** place that format is written down on this side; a second spelling
 * of it anywhere would be a credential one half of Egma could mint and the
 * other half could not read.
 */
export {
  holdManagedDeployment,
  INTERNAL_GATEWAY_CREDENTIAL_PREFIX,
  INTERNAL_GATEWAY_CREDENTIAL_SECONDS,
  managedDeployment,
  managedDeploymentFrom,
  securely,
  signInternalGatewayCredential,
  type ManagedDeployment,
} from "./managed-deployment.ts";
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
 *
 * **`foldVerdicts` itself is deliberately not on this list.** It answers about
 * whatever pile of rows it is handed and never asks whose they are, which is
 * exactly right inside `verdicts/` and a loaded gun outside it: a caller that
 * hands it every row of a run has folded a diagnostic's failure into the
 * headline, and nothing about the call says so. What crosses this boundary is
 * `verdictLanes`, which cannot be called without answering which copies only
 * report, and `foldVerdictsByGrader`, which takes the same answer. Everything
 * beyond the package folds a lane it was given by the read that produced it.
 */
export {
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
 * The fold one grain up, where execution meets judgment — and where the two are
 * kept apart.
 *
 * It is here beside `foldVerdicts` and for exactly its reason: it reaches no
 * store, takes no context, and is handed what two stores already answered. And
 * it is exported for the fold's other reason, more sharply. A run holds four
 * separate facts — the run's machinery, each conversation's machinery, whether
 * anybody has judged yet, and what they decided — and every surface that shows
 * one of them has to show it as itself. A page working that out for itself is a
 * second opinion, and the way it goes wrong is always the same: an execution
 * failure drawn as a failed verdict tells a team their agent is broken when egma
 * is, and pending grading drawn as a failure tells them something failed when
 * nobody has looked.
 */
export {
  foldRun,
  foldSimulation,
  type GradingStanding,
  type RunFold,
  type SimulationFold,
  type SimulationStatusCounts,
} from "./verdicts/read-fold.ts";
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
/**
 * Where each provider-job pair is reached **through the Egma model gateway**.
 *
 * Here beside the fold and on the fold's exact terms: it reaches no store, takes
 * no context, and is arithmetic over release catalog data. Exported for the
 * fold's other reason, sharply — three things have to agree about these paths,
 * and two of them are in this repository. The grader's judge makers read this;
 * the simulator's speech legs mirror it in Python; the gateway's own route table
 * is the authority, and a deterministic test holds the lists against each other.
 * A second copy written into the grading engine or the claim path would be a
 * leg quietly pointed at a path the gateway answers `404` for, read by whoever
 * sees it as the provider being wrong.
 */
export {
  GATEWAY_ROUTE,
  gatewayAddressFor,
} from "./models/catalog.ts";
export {
  everySpanIn,
  measuresFromSpans,
  worstSampleOf,
  type MeasuredFromSpans,
  type Sample,
  type SpannedConversation,
} from "./measures/from-spans.ts";
export {
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  REPORTED_MEASUREMENTS_PAYLOAD_PATH,
  REPORTED_MEASUREMENTS_VERSION,
  reportedMeasurementsOf,
  reportedMeasurementsPayload,
  type ReportedMeasurement,
  type ReportedMeasurements,
} from "./measures/reported.ts";

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
  capabilityStanding,
  measuredCapabilities,
  CAPABILITY_STANDINGS,
  capabilityCheckFailedMessage,
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  hasCapabilityDiscovery,
  isCapabilityKey,
  noCapabilityAdapterMessage,
  registerCapabilityDiscovery,
  transportCapabilities,
  unknownCapabilityMessage,
  type CapabilityDiscovery,
  type CapabilityEntry,
  type CapabilityStanding,
  type ConnectionCapabilities,
  type Discovered,
  type DiscoveryTarget,
} from "./access/capabilities.ts";
export * from "./access/index.ts";
export * as schema from "./schema/index.ts";
