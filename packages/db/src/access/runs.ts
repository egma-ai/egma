import type { PersonaParameterValues } from "../persona-library/parameters.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { isId, newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  db,
  dedicatedConnection,
  type Transaction,
} from "../client.ts";
import { planGroupsFor } from "../grading/plan.ts";
import {
  agent,
  connection,
  laneProducesAnAgentPov,
  type AccessVariant,
  type AgentPlatform,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { persona } from "../schema/personas.ts";
import {
  COMPLETED_ENDING_REASONS,
  FAILED_ENDING_REASONS,
  run,
  runEvent,
  simulation,
  type RunEventKind,
  type RunStatus,
  type RunTrigger,
  type SimulationEndingReason,
  type SimulationStatus,
} from "../schema/runs.ts";
import { test, testPersona, testSuite, testVersion } from "../schema/tests.ts";
import { openCredentials } from "../sealing.ts";
import {
  mockMetadataAsRead,
  mockMetadataFrom,
  mockMetadataRow,
  type MockMetadata,
} from "../mock-tools/record.ts";
import { runIsReadyToConduct } from "../mock-tools/lanes.ts";
import { stringRecordFromRow } from "./agents.ts";
import { validClaimant } from "./claimants.ts";
import {
  connectionIsConductable,
  connectionTypeReadsPlatformAtRunStart,
  noSimulatorAdapterMessage,
  platformOfConnectionType,
} from "./connection-registry.ts";
import type { AuthContext } from "./context.ts";
import { RunWriteRefusedError } from "./errors.ts";
import {
  requestGradingIn,
  simulationEvidenceReadiness,
} from "./grading.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import {
  applicableGraders,
  refuseRun,
  resolvePersonaVersions,
  simulationHasPlannedGradersOn,
} from "./run-plans.ts";
import {
  getTestVersionExecutionContent,
  mockToolsOfVersion,
  type TestEnv,
  type TestExecutionContent,
  type TestMockTool,
} from "./tests.ts";
import { within } from "./within.ts";

export type ExpectedTestVersion = {
  readonly testId: string;
  readonly versionId: string;
};

/** A run always executes one complete suite at its current versions. */
export type NewRun = {
  readonly suiteId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly name?: string | undefined;
  readonly expectedTestVersions?: readonly ExpectedTestVersion[] | undefined;
  /**
   * Agent platform version resolved before the run transaction. Required for
   * connection types that conduct against a named version; omit for other types.
   * Keep the network read outside the transaction to avoid holding locks during it.
   */
  readonly agentVersion?: number | undefined;
  /**
   * Fingerprint of the connection used for the platform version read. startRun
   * compares it under the connection lock and rejects changes made during that read.
   */
  readonly conductedConnectionIdentity?: string | undefined;
};

export type ConnectionSnapshot = {
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly modality: Modality;
  readonly topology: Topology;
  readonly environment: string | null;
  readonly config: unknown;
};

export type Run = {
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly suiteName: string;
  readonly suiteDeleted: boolean;
  readonly agentId: string;
  readonly connectionId: string;
  readonly name: string | null;
  readonly status: RunStatus;
  readonly triggeredVia: RunTrigger;
  readonly triggeredBy: string | null;
  readonly connectionSnapshot: ConnectionSnapshot;
  /** The serving version this run conducted against, or null for no pin. */
  readonly agentVersion: number | null;
  /** The temporary copy this run branched, or null when it branched none. */
  readonly tempMockAgentVersion: number | null;
  /** Null = no copy was made; false = cleanup owed; true = account put back. */
  readonly tempMockAgentVersionCleanup: boolean | null;
  /** The put-it-back note, or null when nothing was put onto the account. */
  readonly mockMetadata: MockMetadata | null;
  readonly expectedSimulationCount: number;
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

export type StartedRun = Run;

export type { MockMetadata };

export type Simulation = {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly position: number;
  readonly modality: Modality;
  readonly status: SimulationStatus;
  readonly endingReason: SimulationEndingReason | null;
  readonly executionFailure: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly recordingReference: string | null;
  readonly turnCount: number | null;
  readonly providerReference: string | null;
  readonly createdAt: Date;
};

export type ConductedSimulation = Simulation & {
  readonly testName: string;
  readonly personaName: string;
};

export type CompletedEndingReason = (typeof COMPLETED_ENDING_REASONS)[number];
export type FailedEndingReason = (typeof FAILED_ENDING_REASONS)[number];

export type SimulationSummaryFacts = {
  readonly turnCount?: number | undefined;
  readonly providerReference?: string | undefined;
  readonly recordingReference?: string | undefined;
  readonly startedAt?: Date | undefined;
  readonly endedAt?: Date | undefined;
};

export type SimulationReport = SimulationSummaryFacts & {
  readonly endingReason: CompletedEndingReason;
};

export type SimulationFailure = SimulationSummaryFacts & {
  readonly reason: Exclude<FailedEndingReason, "orphaned" | "dispatch_failed">;
  /** The credential-redacted sentence the simulator reported. */
  readonly message: string;
};

const RUN_COLUMNS = {
  id: run.id,
  projectId: run.projectId,
  suiteId: run.suiteId,
  agentId: run.agentId,
  connectionId: run.connectionId,
  name: run.name,
  status: run.status,
  triggeredVia: run.triggeredVia,
  triggeredBy: run.triggeredBy,
  connectionSnapshot: run.connectionSnapshot,
  agentVersion: run.agentVersion,
  tempMockAgentVersion: run.tempMockAgentVersion,
  tempMockAgentVersionCleanup: run.tempMockAgentVersionCleanup,
  mockMetadata: run.mockMetadata,
  expectedSimulationCount: run.expectedSimulationCount,
  completedCount: run.completedCount,
  failedCount: run.failedCount,
  canceledCount: run.canceledCount,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdAt: run.createdAt,
} as const;

const SIMULATION_COLUMNS = {
  id: simulation.id,
  runId: simulation.runId,
  projectId: simulation.projectId,
  agentId: simulation.agentId,
  connectionId: simulation.connectionId,
  personaId: simulation.personaId,
  personaVersionId: simulation.personaVersionId,
  testId: simulation.testId,
  testVersionId: simulation.testVersionId,
  position: simulation.position,
  modality: simulation.modality,
  status: simulation.status,
  endingReason: simulation.endingReason,
  executionFailure: simulation.executionFailure,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
  heartbeatAt: simulation.heartbeatAt,
  cancelRequestedAt: simulation.cancelRequestedAt,
  startedAt: simulation.startedAt,
  endedAt: simulation.endedAt,
  recordingReference: simulation.recordingReference,
  turnCount: simulation.turnCount,
  providerReference: simulation.providerReference,
  createdAt: simulation.createdAt,
} as const;

type RunRow = {
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly name: string | null;
  readonly status: string;
  readonly triggeredVia: string;
  readonly triggeredBy: string | null;
  readonly connectionSnapshot: unknown;
  readonly agentVersion: number | null;
  readonly tempMockAgentVersion: number | null;
  readonly tempMockAgentVersionCleanup: boolean | null;
  readonly mockMetadata: unknown;
  readonly expectedSimulationCount: number;
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

type SimulationRow = Omit<Simulation, "status" | "endingReason" | "modality"> & {
  readonly status: string;
  readonly endingReason: string | null;
  readonly modality: string;
};

const LARGEST_CLAIM_CAPACITY = 50;
const DEFAULT_STALE_AFTER_SECONDS = 150;
const SIMULATION_INSERT_BATCH = 500;
const RUN_EVENT_PAGE_SIZE = 200;
const REPORTABLE_FAILURE_REASONS: readonly FailedEndingReason[] =
  FAILED_ENDING_REASONS.filter(
    (reason) => reason !== "orphaned" && reason !== "dispatch_failed",
  );

function summaryFactsWrite(facts: SimulationSummaryFacts): Record<string, unknown> {
  const write: Record<string, unknown> = {};
  if (facts.turnCount !== undefined) {
    if (!Number.isInteger(facts.turnCount) || facts.turnCount < 0) {
      throw new Error("a turn count is a whole number of turns, zero or more");
    }
    write.turnCount = facts.turnCount;
  }
  if (facts.providerReference !== undefined) {
    write.providerReference = facts.providerReference.trim() || null;
  }
  if (facts.recordingReference !== undefined) {
    write.recordingReference = facts.recordingReference.trim() || null;
  }
  if (facts.startedAt !== undefined) write.startedAt = facts.startedAt;
  if (facts.endedAt !== undefined) write.endedAt = facts.endedAt;
  return write;
}

/** One non-empty sentence safe to retain as a simulation execution failure. */
function executionFailureWrite(message: string): string {
  const written = message.trim();
  if (written === "") {
    throw new Error("a failed simulation needs an execution failure message");
  }
  return written;
}

function connectionSnapshotFromRow(value: unknown, runId: string): ConnectionSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new Error(`run ${runId} holds a malformed connection snapshot`);
  }
  const row = value as Record<string, unknown>;
  if (
    (row.agentPlatform !== null && typeof row.agentPlatform !== "string") ||
    typeof row.connectionType !== "string" ||
    typeof row.accessVariant !== "string" ||
    typeof row.modality !== "string" ||
    typeof row.topology !== "string" ||
    (row.environment !== null && typeof row.environment !== "string")
  ) {
    throw new Error(`run ${runId} holds a malformed connection snapshot`);
  }
  return {
    agentPlatform: row.agentPlatform as AgentPlatform | null,
    connectionType: row.connectionType as ConnectionType,
    accessVariant: row.accessVariant as AccessVariant,
    modality: row.modality as Modality,
    topology: row.topology as Topology,
    environment: row.environment as string | null,
    config: row.config,
  };
}

function runFromRow(
  row: RunRow,
  suiteName: string,
  suiteDeleted: boolean,
): Run {
  const { status, triggeredVia, connectionSnapshot, mockMetadata, ...rest } =
    row;
  return {
    ...rest,
    suiteName,
    suiteDeleted,
    status: status as RunStatus,
    triggeredVia: triggeredVia as RunTrigger,
    connectionSnapshot: connectionSnapshotFromRow(connectionSnapshot, row.id),
    // Without the comparison value: the teardown's read keeps it, a reader's
    // does not. See `mockMetadataAsRead`.
    mockMetadata: mockMetadataAsRead(
      mockMetadataFrom(
        mockMetadata,
        () => new Error(`run ${row.id} holds a malformed mock-tool note`),
      ),
    ),
  };
}

function simulationFromRow(row: SimulationRow): Simulation {
  return {
    ...row,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    modality: row.modality as Modality,
  };
}

type NewRunEvent =
  | { readonly kind: "run"; readonly status: RunStatus }
  | {
      readonly kind: "simulation";
      readonly simulationId: string;
      readonly status: SimulationStatus;
      readonly reason?: SimulationEndingReason | null | undefined;
    };

async function appendRunEvents(
  tx: Transaction,
  runId: string,
  at: Date,
  events: readonly NewRunEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const [header] = await tx
    .select({
      organizationId: run.organizationId,
      projectId: run.projectId,
    })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
    .for("update");
  if (header === undefined) {
    throw new Error(`run ${runId} is missing while recording its event`);
  }

  const [latest] = await tx
    .select({ seq: max(runEvent.seq) })
    .from(runEvent)
    .where(eq(runEvent.runId, runId));
  let seq = latest?.seq ?? 0;
  await tx.insert(runEvent).values(
    events.map((event) => {
      seq += 1;
      return {
        runId,
        seq,
        organizationId: header.organizationId,
        projectId: header.projectId,
        kind: event.kind,
        simulationId: event.kind === "simulation" ? event.simulationId : null,
        status: event.status,
        reason: event.kind === "simulation" ? (event.reason ?? null) : null,
        createdAt: at,
      };
    }),
  );
}

function inActingProject(
  auth: AuthContext,
  table: typeof run | typeof simulation | typeof runEvent,
): SQL | undefined {
  return auth.projectId === undefined ? undefined : eq(table.projectId, auth.projectId);
}

function theRun(auth: AuthContext, id: string): SQL {
  return within(auth, run, and(eq(run.id, id), inActingProject(auth, run)));
}

function nothingLeftToCancel(runId: string): string {
  return `run ${runId} has already finished, so there is nothing left to cancel`;
}

function validateExpectedVersions(
  entries: readonly ExpectedTestVersion[] | undefined,
): readonly ExpectedTestVersion[] | undefined {
  if (entries === undefined) return undefined;
  const tests = new Set<string>();
  const versions = new Set<string>();
  for (const entry of entries) {
    if (!isId("tst", entry.testId) || !isId("tstv", entry.versionId)) {
      refuseRun("not_admitted", "expected_test_versions must contain test and test-version ids");
    }
    if (tests.has(entry.testId) || versions.has(entry.versionId)) {
      refuseRun("not_admitted", "expected_test_versions must name each test and version once");
    }
    tests.add(entry.testId);
    versions.add(entry.versionId);
  }
  return entries;
}

/** Start one complete suite under one exact database lock. */
export async function startRun(auth: AuthContext, input: NewRun): Promise<StartedRun> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  const { projectId } = auth;
  if (projectId === undefined) throw new Error("a run happens inside a project");
  if (!isId("ste", input.suiteId)) refuseRun("not_admitted", `"${input.suiteId}" is not a test suite id`);
  if (!isId("agt", input.agentId)) refuseRun("connection_not_on_agent", `"${input.agentId}" is not an agent id`);
  if (!isId("con", input.connectionId)) refuseRun("no_such_connection", `"${input.connectionId}" is not a connection id`);
  const expected = validateExpectedVersions(input.expectedTestVersions);
  const expectedInOrder = expected === undefined
    ? undefined
    : [...expected].sort((a, b) => a.testId.localeCompare(b.testId));

  const runId = newId("run");
  const at = new Date();
  return db().transaction(async (tx) => {
    const [suite] = await tx
      .select({ id: testSuite.id, name: testSuite.name })
      .from(testSuite)
      .where(within(auth, testSuite, and(
        eq(testSuite.id, input.suiteId),
        eq(testSuite.projectId, projectId),
        isNull(testSuite.deletedAt),
      )))
      .limit(1)
      .for("update");
    if (suite === undefined) refuseRun("not_admitted", `there is no active test suite ${input.suiteId} in this project`);

    const readTestPage = (afterId?: string) => tx
      .select({ id: test.id, versionId: test.currentVersionId })
      .from(test)
      .where(and(
        eq(test.suiteId, suite.id),
        eq(test.projectId, projectId),
        isNull(test.deletedAt),
        afterId === undefined ? undefined : gt(test.id, afterId),
      ))
      .orderBy(asc(test.id))
      .limit(SIMULATION_INSERT_BATCH)
      .for("share", { of: test });
    let currentTests = await readTestPage();
    if (currentTests.length === 0) refuseRun("not_admitted", `test suite ${suite.id} is empty`);

    const [reached] = await tx
      .select({
        agentId: connection.agentId,
        // The connection holds no platform of its own: the type answers
        // where it pins one, else the agent's own binding does.
        agentPlatform: agent.agentPlatform,
        connectionType: connection.connectionType,
        accessVariant: connection.accessVariant,
        modality: connection.modality,
        topology: connection.topology,
        environment: connection.environment,
        config: connection.config,
        credentials: connection.credentials,
      })
      .from(connection)
      .innerJoin(agent, eq(connection.agentId, agent.id))
      .where(within(auth, connection, and(
        eq(connection.id, input.connectionId),
        eq(connection.agentId, input.agentId),
        eq(connection.projectId, projectId),
        isNull(connection.archivedAt),
        isNull(agent.archivedAt),
      )))
      .limit(1)
      .for("share");
    if (reached === undefined) refuseRun("no_such_connection", `there is no active connection ${input.connectionId} on agent ${input.agentId}`);
    if (!connectionIsConductable(reached.connectionType, reached.accessVariant, reached.modality)) {
      refuseRun("no_adapter", noSimulatorAdapterMessage(reached.connectionType, reached.modality));
    }
    // A kind whose run start reads the agent's platform carries two demands
    // that a kind reading nothing does not, and both live here so they are
    // properties of the write rather than habits of one caller.
    if (connectionTypeReadsPlatformAtRunStart(reached.connectionType)) {
      // **Never a silent conduct against an unnamed version.** The run cannot
      // begin without what the read produced: the one serving version every
      // request will name and this row will record. The caller does the
      // reading — it is somebody else's API and this is one transaction
      // holding a lock — but arriving here without it is a bug in the caller,
      // not a run to write, and a run written without it would leave a result
      // no reader could tie back to an agent.
      if (input.agentVersion === undefined) {
        throw new Error(
          `a run over a ${reached.connectionType} connection is conducted ` +
            `against a named version, so it cannot be started without the ` +
            `run-start read of the agent's platform`,
        );
      }
      // Check config and encrypted credentials under the share lock against the earlier
        // platform read. Reject changed targets, including edits within the same millisecond,
        // so the run records the connection whose agent version was resolved.
      const identityNow = connectionIdentityToken(
        stringRecordFromRow(
          reached.config,
          () =>
            new Error(
              `connection ${input.connectionId} holds config in a shape ` +
                `Egma never writes`,
            ),
        ),
        reached.credentials,
      );
      if (input.conductedConnectionIdentity !== identityNow) {
        refuseRun(
          "not_admitted",
          `connection ${input.connectionId} was edited while Egma was ` +
            `reading the agent's platform for this run, so the version it ` +
            `read may not be the one this connection now reaches. Nothing ` +
            `was started; read the connection again and retry.`,
        );
      }
    }

    const graderCandidates = await applicableGraders(auth, tx, projectId);
    const plannedTests: {
      suiteId: string;
      testId: string;
      testVersionId: string;
      modality: Modality;
    }[] = [];
    while (currentTests.length > 0) {
      for (const current of currentTests) {
        const expectedCurrent = expectedInOrder?.[plannedTests.length];
        if (expectedInOrder !== undefined &&
          (expectedCurrent?.testId !== current.id || expectedCurrent.versionId !== current.versionId)) {
          refuseRun("not_admitted", "the suite changed after this run request was prepared; read it again and retry");
        }
        plannedTests.push({
          suiteId: suite.id,
          testId: current.id,
          testVersionId: current.versionId,
          modality: reached.modality as Modality,
        });
      }
      if (currentTests.length < SIMULATION_INSERT_BATCH) break;
      const afterTestId = currentTests.at(-1)?.id;
      if (afterTestId === undefined) break;
      currentTests = await readTestPage(afterTestId);
    }
    if (expectedInOrder !== undefined && plannedTests.length !== expectedInOrder.length) {
      refuseRun("not_admitted", "the suite changed after this run request was prepared; read it again and retry");
    }
    const selectedPersonas = await tx.selectDistinct({ id: testPersona.personaId })
      .from(testPersona)
      .innerJoin(test, eq(test.currentVersionId, testPersona.testVersionId))
      .where(and(eq(test.suiteId, suite.id), eq(test.projectId, projectId), isNull(test.deletedAt)))
      .orderBy(asc(testPersona.personaId));
    const personaPins = new Map((await resolvePersonaVersions(
      auth, tx, projectId, selectedPersonas.map((one) => one.id),
    )).map((pin) => [pin.personaId, pin] as const));
    const gradingPlan = {
      capturedAt: at.toISOString(),
      groups: planGroupsFor(graderCandidates, plannedTests),
    };
    const [measured] = await tx
      .select({ total: count() })
      .from(test)
      .innerJoin(testPersona, eq(test.currentVersionId, testPersona.testVersionId))
      .where(and(
        eq(test.suiteId, suite.id),
        eq(test.projectId, projectId),
        isNull(test.deletedAt),
      ));
    const expectedSimulationCount = measured?.total ?? 0;
    if (expectedSimulationCount <= 0) {
      refuseRun("not_admitted", `test suite ${suite.id} is empty`);
    }

    const [header] = await tx.insert(run).values({
      id: runId,
      organizationId: auth.organizationId,
      projectId,
      suiteId: suite.id,
      agentId: reached.agentId,
      connectionId: input.connectionId,
      name: input.name?.trim() || null,
      status: "pending",
      triggeredVia: "manual",
      triggeredBy: auth.userId,
      connectionSnapshot: {
        // Derived exactly as a read derives it: the type answers where it
        // pins one platform, else the agent's own binding does.
        agentPlatform:
          platformOfConnectionType(reached.connectionType) ??
          reached.agentPlatform,
        connectionType: reached.connectionType,
        accessVariant: reached.accessVariant,
        modality: reached.modality,
        topology: reached.topology,
        environment: reached.environment,
        config: reached.config,
      },
      // Read before this transaction opened; written down here so that every
      // request this run makes names the same version, and a concurrent edit
      // on the account cannot move what the suite is testing halfway through.
      ...(input.agentVersion === undefined
        ? {}
        : { agentVersion: input.agentVersion }),
      expectedSimulationCount,
      gradingPlan,
      createdAt: at,
    }).returning(RUN_COLUMNS);
    if (header === undefined) throw new Error("the run was not written");

    let simulationCount = 0;
    for (const current of plannedTests) {
      let personaPosition = 0;
      let namedPersona = false;
      while (true) {
        const personaRows = await tx
          .select({
            personaId: testPersona.personaId,
            position: testPersona.position,
          })
          .from(testPersona)
          .where(and(
            eq(testPersona.testVersionId, current.testVersionId),
            gt(testPersona.position, personaPosition),
          ))
          .orderBy(asc(testPersona.position))
          .limit(SIMULATION_INSERT_BATCH);
        if (personaRows.length === 0) break;
        namedPersona = true;
        const pins = personaRows.map((one) => {
          const pin = personaPins.get(one.personaId);
          if (pin === undefined) throw new Error(`persona ${one.personaId} was not captured`);
          return pin;
        });
        await tx.insert(simulation).values(pins.map((pin, index) => ({
          id: newId("sim"),
          runId,
          organizationId: auth.organizationId,
          projectId,
          agentId: reached.agentId,
          connectionId: input.connectionId,
          personaId: pin.personaId,
          personaVersionId: pin.personaVersionId,
          personaParameterValues: pin.personaParameterValues,
          testId: current.testId,
          testVersionId: current.testVersionId,
          position: simulationCount + index + 1,
          modality: reached.modality,
          status: "queued" as const,
          createdAt: at,
        })));
        simulationCount += pins.length;
        personaPosition = personaRows.at(-1)?.position ?? personaPosition;
        if (personaRows.length < SIMULATION_INSERT_BATCH) break;
      }
      if (!namedPersona) throw new Error(`test version ${current.testVersionId} names no persona`);
    }
    if (simulationCount !== expectedSimulationCount) {
      throw new Error(`test suite ${suite.id} changed while its run was being planned`);
    }
    return runFromRow(header, suite.name, false);
  });
}

/**
 * Run-start platform reads use the connection's config and decrypted key.
 * resolveRunStartReach limits this access to declared connection types, the caller's
 * agent and project, and start_and_cancel_runs permission. Keep the key server-side.
 */
/**
 * Hash sorted config and the encrypted credential envelope to detect changes
 * between a platform read and run creation. Re-encryption counts as a change,
 * even for the same key. No plaintext credential enters the fingerprint.
 */
function connectionIdentityToken(
  config: Readonly<Record<string, string>>,
  credentialsEnvelope: string | null,
): string {
  const canonicalConfig = Object.keys(config)
    .sort()
    .map((key) => `${key}=${config[key]}`)
    .join("\0");
  return createHash("sha256")
    .update(canonicalConfig)
    .update("\0\0")
    .update(credentialsEnvelope ?? "\0none")
    .digest("hex");
}

export type RunStartReach = {
  /** Which reader the run route hands this to. */
  readonly connectionType: ConnectionType;
  readonly config: Readonly<Record<string, string>>;
  readonly apiKey: string;
  /**
   * Connection fingerprint captured for the platform read and checked by startRun
   * under its lock before saving the run snapshot.
   */
  readonly connectionIdentity: string;
};

export async function resolveRunStartReach(
  auth: AuthContext,
  agentId: string,
  connectionId: string,
): Promise<RunStartReach | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  if (auth.projectId === undefined) return undefined;

  const [row] = await db()
    .select({
      connectionType: connection.connectionType,
      config: connection.config,
      credentials: connection.credentials,
    })
    .from(connection)
    .where(
      within(
        auth,
        connection,
        and(
          eq(connection.id, connectionId),
          eq(connection.agentId, agentId),
          eq(connection.projectId, auth.projectId),
          isNull(connection.archivedAt),
        ),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;
  if (!connectionTypeReadsPlatformAtRunStart(row.connectionType)) {
    return undefined;
  }
  if (row.credentials === null) return undefined;

  const apiKey = openedApiKey(row.credentials);
  if (apiKey === null) return undefined;

  const config = stringRecordFromRow(
    row.config,
    () =>
      new Error(
        `connection ${connectionId} holds config in a shape Egma never ` +
          `writes; the row needs repairing before anybody can run over it`,
      ),
  );

  return {
    connectionType: row.connectionType as ConnectionType,
    config,
    apiKey,
    connectionIdentity: connectionIdentityToken(config, row.credentials),
  };
}

const RUN_READ_COLUMNS = {
  ...RUN_COLUMNS,
  suiteName: testSuite.name,
  suiteDeletedAt: testSuite.deletedAt,
} as const;

export async function getRun(auth: AuthContext, id: string): Promise<Run | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select(RUN_READ_COLUMNS)
    .from(run)
    .innerJoin(testSuite, eq(run.suiteId, testSuite.id))
    .where(theRun(auth, id))
    .limit(1);
  if (row === undefined) return undefined;
  const { suiteName, suiteDeletedAt, ...header } = row;
  return runFromRow(header, suiteName, suiteDeletedAt !== null);
}

/**
 * Persist complete temporary-version cleanup state after each platform step so
 * interrupted builds can recover. After run completion, the database guard permits
 * only cleanup-flag and mock-metadata changes.
 */
export type MockRunState = {
  /** The temporary copy that exists right now, or null when none does. */
  readonly tempMockAgentVersion: number | null;
  /** Null = no copy was made; false = cleanup owed; true = account put back. */
  readonly tempMockAgentVersionCleanup: boolean | null;
  readonly mockMetadata: MockMetadata | null;
  /**
   * Optional serving version resolved by the temporary-agent build. Omit to keep
   * the recorded version. Write it before the run header freezes at completion.
   */
  readonly agentVersion?: number | undefined;
};

export async function recordMockState(
  auth: AuthContext,
  runId: string,
  state: MockRunState,
): Promise<Run | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  const [updated] = await db()
    .update(run)
    .set({
      tempMockAgentVersion: state.tempMockAgentVersion,
      tempMockAgentVersionCleanup: state.tempMockAgentVersionCleanup,
      mockMetadata:
        state.mockMetadata === null ? null : mockMetadataRow(state.mockMetadata),
      ...(state.agentVersion === undefined
        ? {}
        : { agentVersion: state.agentVersion }),
    })
    .where(theRun(auth, runId))
    .returning({ id: run.id });
  if (updated === undefined) return undefined;
  return getRun(auth, runId);
}

export type MockDraftClaim =
  | { readonly kind: "claimed" }
  /** Another run of this agent holds the one temporary copy. */
  | { readonly kind: "taken"; readonly byRunId: string };

/**
 * The fence's key: this one agent, of this one customer. Nothing else waits
 * behind it, and it is derived here alone so the claim and the teardown can
 * never end up fencing on two different keys.
 */
function mockDraftFenceKey(auth: AuthContext, agentId: string): string {
  return `egma-mock-draft:${auth.organizationId}:${agentId}`;
}

/**
 * Track locks held by this async call chain. A process-wide set could wrongly
 * authorize an unrelated request while another request holds the same agent lock.
 */
const heldMockDraftFences = new AsyncLocalStorage<ReadonlySet<string>>();

const NO_FENCES: ReadonlySet<string> = new Set();

/** The fences this call chain holds, which is none outside every fence. */
function fencesHeldHere(): ReadonlySet<string> {
  return heldMockDraftFences.getStore() ?? NO_FENCES;
}

/**
 * Refuse work that must not be done outside the fence.
 *
 * Cross-process exclusion is Postgres's job; this catches the one mistake a
 * person makes — writing a new caller that forgets to open the fence — where it
 * is cheap to catch, in the caller's own call chain, rather than as a race a
 * customer finds.
 */
function requireMockDraftFence(
  auth: AuthContext,
  agentId: string,
  doing: string,
): void {
  if (fencesHeldHere().has(mockDraftFenceKey(auth, agentId))) return;
  throw new Error(
    `refusing to ${doing} without this agent's mocked-world fence: open it ` +
      "with owedMockCleanups and do the work inside it",
  );
}

/**
 * Somebody else's process holds this agent's fence and would not let go.
 *
 * **Its own error, because it is not a fault.** The one request that produces
 * it is a second mocked run of an agent whose first run is still building, or
 * whose holder was killed hard enough that Postgres has not yet noticed the
 * socket. Both answer the same way the ordinary collision does: wait, then
 * start again.
 */
export class MockDraftFenceBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockDraftFenceBusyError";
  }
}

/**
 * Bound lock waits so a dead holder's lingering database session cannot block
 * run-start requests until its network timeout.
 */
const FENCE_WAIT_MILLISECONDS = 120_000;

/** Postgres's own code for "the lock_timeout ran out". */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Hold the agent advisory lock on a dedicated session across platform requests.
 * A transaction lock would conflict with the work's separate database transactions.
 * Close the session to release it. Bound acquisition with FENCE_WAIT_MILLISECONDS
 * and reject nested holds of the same key, which use different sessions and deadlock.
 */
async function withMockDraftFence<T>(
  key: string,
  whileHeld: () => Promise<T>,
): Promise<T> {
  const alreadyHeld = fencesHeldHere();
  if (alreadyHeld.has(key)) {
    throw new Error(
      `this work already holds the mocked-world fence ${key}: the lock lives ` +
        "on its own session, so opening it a second time would wait on the " +
        "first one forever. Do the work inside the fence already open.",
    );
  }

  const connection = dedicatedConnection();
  // A connection that dies has to arrive here rather than at an unhandled
  // rejection. The fence goes with it either way.
  connection.on("error", () => undefined);
  try {
    // Inside the try, so a connect that rejects still reaches the end below.
    await connection.connect();
    // The bound, set on this session before the one statement that can wait.
    // Every other statement this session runs is the lock and nothing else.
    await connection.query(`set lock_timeout = ${FENCE_WAIT_MILLISECONDS}`);
    try {
      await connection.query(
        "select pg_advisory_lock(hashtextextended($1::text, 0))",
        [key],
      );
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        (cause as { code?: unknown }).code === LOCK_NOT_AVAILABLE
      ) {
        throw new MockDraftFenceBusyError(
          "Another run of this agent is holding its mocked world and did not " +
            "let go. Egma builds one mocked world per agent at a time, so " +
            "nothing was started. Wait for that run to finish, then start " +
            "this one again.",
        );
      }
      throw cause;
    }
    return await heldMockDraftFences.run(
      new Set([...alreadyHeld, key]),
      whileHeld,
    );
  } finally {
    // Ending the session is the unlock, and it is the one that also runs when
    // the connection has gone bad under us.
    await connection.end().catch(() => undefined);
  }
}

/**
 * Claim one temporary agent version per agent under the lock held by owedMockCleanups.
 * Unfinished, non-stale runs with cleanup owed block the claim. Finished runs and
 * stale pending builds do not block here; the caller must settle their cleanup
 * before branching and refuse to branch if cleanup remains.
 * Persist the claim as cleanup=false so recovery can find an interrupted build.
 */
export async function claimMockDraftFor(
  auth: AuthContext,
  input: {
    readonly runId: string;
    readonly agentId: string;
    /**
     * How long a run may sit pending with no copy before it counts as a build
     * that died. The caller's own sweep window, passed in so the two agree.
     */
    readonly staleBuildMilliseconds: number;
  },
): Promise<MockDraftClaim> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  const staleSeconds = Math.max(0, input.staleBuildMilliseconds) / 1000;
  requireMockDraftFence(auth, input.agentId, "claim this agent's mocked world");

  return db().transaction(async (tx): Promise<MockDraftClaim> => {
    const [held] = await tx
      .select({ id: run.id })
      .from(run)
      .where(
        within(
          auth,
          run,
          and(
            eq(run.agentId, input.agentId),
            sql`${run.id} <> ${input.runId}`,
            eq(run.tempMockAgentVersionCleanup, false),
            // A finished run never blocks: its litter is the sweep's.
            isNull(run.finishedAt),
            // Nor does a build that died — pending, no copy, past the window.
            sql`not (
              ${run.status} = 'pending'
              and ${run.tempMockAgentVersion} is null
              and ${run.createdAt} < now() - make_interval(secs => ${staleSeconds})
            )`,
          ),
        ),
      )
      .orderBy(asc(run.id))
      .limit(1);

    if (held !== undefined) return { kind: "taken", byRunId: held.id };

    await tx
      .update(run)
      .set({ tempMockAgentVersionCleanup: false })
      .where(theRun(auth, input.runId));
    return { kind: "claimed" };
  });
}

/** One run's outstanding obligation to somebody's Retell account. */
export type OwedMockCleanup = {
  readonly runId: string;
  /** The temporary copy still to be deleted, or null once it is gone. */
  readonly tempMockAgentVersion: number | null;
  /** The put-it-back note, or null where the run never wrote one. */
  readonly metadata: MockMetadata | null;
  readonly status: RunStatus;
  readonly createdAt: Date;
  /** Null while the run could still be conducting something. */
  readonly finishedAt: Date | null;
};

/**
 * Read owed cleanup oldest first and run whileHeld under the agent advisory lock.
 * Keep reads, cleanup, claims, and builds inside the callback so another run cannot
 * change the temporary-version state between reading it and acting on it.
 * With take, always lock. With only-when-owed, skip the lock for an empty initial
 * probe; otherwise acquire it and reread. The first probe is only a hint.
 */
export async function owedMockCleanups<T>(
  auth: AuthContext,
  agentId: string,
  options: {
    readonly exceptRunId?: string;
    readonly fence: "take" | "only-when-owed";
  },
  whileHeld: (owed: readonly OwedMockCleanup[]) => Promise<T>,
): Promise<T> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  if (options.fence === "only-when-owed") {
    const hint = await owedMockCleanupRows(auth, agentId, options);
    if (hint.length === 0) return await whileHeld([]);
  }
  return await withMockDraftFence(mockDraftFenceKey(auth, agentId), async () =>
    whileHeld(await owedMockCleanupRows(auth, agentId, options)),
  );
}

/** The indexed read itself. Only ever called with the fence decided above. */
async function owedMockCleanupRows(
  auth: AuthContext,
  agentId: string,
  options: { readonly exceptRunId?: string },
): Promise<readonly OwedMockCleanup[]> {
  const rows = await db()
    .select({
      id: run.id,
      tempMockAgentVersion: run.tempMockAgentVersion,
      mockMetadata: run.mockMetadata,
      status: run.status,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
    })
    .from(run)
    .where(
      within(
        auth,
        run,
        and(
          eq(run.agentId, agentId),
          eq(run.tempMockAgentVersionCleanup, false),
          options.exceptRunId === undefined
            ? undefined
            : sql`${run.id} <> ${options.exceptRunId}`,
        ),
      ),
    )
    .orderBy(asc(run.id));

  return rows.map((row) => ({
    runId: row.id,
    tempMockAgentVersion: row.tempMockAgentVersion,
    metadata: mockMetadataFrom(
      row.mockMetadata,
      () => new Error(`run ${row.id} holds a malformed mock-tool note`),
    ),
    status: row.status as RunStatus,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  }));
}

export type SimulationExecutionEvidence = {
  readonly testVersion: TestExecutionContent;
  /** The pinned version's own mock tools, in the order it named them. */
  readonly mockTools: readonly TestMockTool[];
  /** The pinned version's own env, or null where it asks for none. */
  readonly env: TestEnv | null;
};

/**
 * Read test execution content, mock tools, and environment from the simulation's
 * pinned immutable test version. The simulation already pins its persona, so
 * this read does not load the test's full persona list.
 */
export async function getSimulationExecutionEvidence(
  auth: AuthContext,
  simulationId: string,
): Promise<SimulationExecutionEvidence | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select({
      testVersionId: simulation.testVersionId,
    })
    .from(simulation)
    .where(within(auth, simulation, and(
      eq(simulation.id, simulationId),
      inActingProject(auth, simulation),
    )))
    .limit(1);
  if (row === undefined) return undefined;
  const version = await getTestVersionExecutionContent(auth, row.testVersionId);
  if (version === undefined) {
    throw new Error(`simulation ${simulationId} pins unreadable test version ${row.testVersionId}`);
  }
  return {
    testVersion: version,
    mockTools: version.mockTools,
    env: version.env,
  };
}

/**
 * Whether any simulation of this run pins a test version that mocks something.
 *
 * The question the run-start machinery asks before it decides to branch a
 * temporary copy of the customer's agent, and the same question the claim gate
 * asks in SQL — asked here as one existence check over the run's own
 * simulations, so a suite of a thousand tests costs one read.
 */
export async function runCarriesMockTools(
  auth: AuthContext,
  runId: string,
): Promise<boolean> {
  authorize(auth, "read", here(auth));
  const [found] = await db()
    .select({ id: simulation.id })
    .from(simulation)
    .innerJoin(testVersion, eq(simulation.testVersionId, testVersion.id))
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.runId, runId),
          inActingProject(auth, simulation),
          isNotNull(testVersion.mockTools),
        ),
      ),
    )
    .limit(1);
  return found !== undefined;
}

export type RunPage = {
  readonly items: readonly Run[];
  readonly nextCursor: string | undefined;
};

export type RunFilter = {
  readonly suiteId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly connectionId?: string | undefined;
  readonly testId?: string | undefined;
  readonly status?: RunStatus | undefined;
  readonly since?: Date | undefined;
  readonly until?: Date | undefined;
};

export async function listRuns(
  auth: AuthContext,
  page?: PageRequest,
  filter?: RunFilter,
): Promise<RunPage> {
  authorize(auth, "read", here(auth));
  const { limit, cursor } = pageWindow(page, { singular: "run", plural: "runs", prefix: "run" });
  const pinnedTest = filter?.testId === undefined
    ? undefined
    : inArray(run.id, db().select({ runId: simulation.runId }).from(simulation).where(within(auth, simulation, eq(simulation.testId, filter.testId))));
  const rows = await db()
    .select(RUN_READ_COLUMNS)
    .from(run)
    .innerJoin(testSuite, eq(run.suiteId, testSuite.id))
    .where(within(auth, run, and(
      inActingProject(auth, run),
      cursor === undefined ? undefined : lt(run.id, cursor),
      filter?.suiteId === undefined ? undefined : eq(run.suiteId, filter.suiteId),
      filter?.agentId === undefined ? undefined : eq(run.agentId, filter.agentId),
      filter?.connectionId === undefined ? undefined : eq(run.connectionId, filter.connectionId),
      filter?.status === undefined ? undefined : eq(run.status, filter.status),
      filter?.since === undefined ? undefined : gte(run.createdAt, filter.since),
      filter?.until === undefined ? undefined : lt(run.createdAt, filter.until),
      pinnedTest,
    )))
    .orderBy(desc(run.id))
    .limit(limit + 1);
  const { items, nextCursor } = pageOf(rows, limit);
  return {
    items: items.map(({ suiteName, suiteDeletedAt, ...row }) =>
      runFromRow(row, suiteName, suiteDeletedAt !== null)),
    nextCursor,
  };
}

export async function simulationStatusCountsOfRuns(
  auth: AuthContext,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, Readonly<Partial<Record<SimulationStatus, number>>>>> {
  authorize(auth, "read", here(auth));
  const byRun = new Map<string, Partial<Record<SimulationStatus, number>>>();
  if (runIds.length === 0) return byRun;
  const rows = await db().select({
    runId: simulation.runId,
    status: simulation.status,
    total: count(),
  })
    .from(simulation)
    .where(within(auth, simulation, and(inArray(simulation.runId, [...runIds]), inActingProject(auth, simulation))))
    .groupBy(simulation.runId, simulation.status);
  for (const row of rows) {
    const held = byRun.get(row.runId) ?? {};
    held[row.status as SimulationStatus] = row.total;
    byRun.set(row.runId, held);
  }
  return byRun;
}

export type SimulationPage = {
  readonly items: readonly ConductedSimulation[];
  readonly nextCursor: string | undefined;
};

export async function listSimulations(
  auth: AuthContext,
  runId: string,
  page?: PageRequest,
): Promise<SimulationPage | undefined> {
  authorize(auth, "read", here(auth));
  if ((await getRun(auth, runId)) === undefined) return undefined;
  const { limit, cursor } = pageWindow(page, { singular: "simulation", plural: "simulations", prefix: "sim" });
  const rows = await db()
    .select({ ...SIMULATION_COLUMNS, testName: test.name, personaName: persona.name })
    .from(simulation)
    .innerJoin(test, eq(simulation.testId, test.id))
    .innerJoin(persona, eq(simulation.personaId, persona.id))
    .where(within(auth, simulation, and(
      eq(simulation.runId, runId),
      cursor === undefined ? undefined : gt(simulation.id, cursor),
    )))
    .orderBy(asc(simulation.id))
    .limit(limit + 1);
  const { items, nextCursor } = pageOf(rows, limit);
  return {
    items: items.map(({ testName, personaName, ...row }) => ({
      ...simulationFromRow(row),
      testName,
      personaName,
    })),
    nextCursor,
  };
}

export async function getSimulation(auth: AuthContext, id: string): Promise<Simulation | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db().select(SIMULATION_COLUMNS).from(simulation)
    .where(within(auth, simulation, and(eq(simulation.id, id), inActingProject(auth, simulation))))
    .limit(1);
  return row === undefined ? undefined : simulationFromRow(row);
}

export async function getSimulationTestVersion(
  auth: AuthContext,
  simulationId: string,
) {
  authorize(auth, "read", here(auth));
  const [row] = await db().select({ versionId: simulation.testVersionId }).from(simulation)
    .where(within(auth, simulation, eq(simulation.id, simulationId))).limit(1);
  return row === undefined
    ? undefined
    : getTestVersionExecutionContent(auth, row.versionId);
}

// Worker lifecycle: claim, conduct, report, sweep, and follow.
async function finalizeRunIfDone(
  tx: Transaction,
  runId: string,
  now: Date,
): Promise<RunStatus | undefined> {
  const [header] = await tx
    .select({ id: run.id, status: run.status, finishedAt: run.finishedAt })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1)
    .for("update");

  if (header === undefined || header.finishedAt !== null) return undefined;

  const tallies = await tx
    .select({ status: simulation.status, howMany: count() })
    .from(simulation)
    .where(eq(simulation.runId, runId))
    .groupBy(simulation.status);

  const byStatus = new Map(tallies.map((row) => [row.status, row.howMany]));
  const stillMoving = ["queued", "claimed", "running"].some(
    (status) => (byStatus.get(status) ?? 0) > 0,
  );
  if (stillMoving) return undefined;

  // A canceled run keeps its status; anything else that got every simulation
  // to a terminal state completed, whatever the contents.
  const settled: RunStatus =
    header.status === "canceled" ? "canceled" : "completed";

  await tx
    .update(run)
    .set({
      status: settled,
      completedCount: byStatus.get("completed") ?? 0,
      failedCount: byStatus.get("failed") ?? 0,
      canceledCount: byStatus.get("canceled") ?? 0,
      finishedAt: now,
    })
    .where(eq(run.id, runId));

  return settled === header.status ? undefined : settled;
}

/**
 * Cancel queued simulations immediately and request cancellation for claimed or
 * running simulations at heartbeat. Mark the run canceled now; finalize counts
 * when all simulations finish. Repeated cancellation is a no-op; a completed run
 * returns already_finished.
 */
export async function cancelRun(
  auth: AuthContext,
  id: string,
): Promise<Run | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();

  return db().transaction(async (tx) => {
    const [selected] = await tx
      .select(RUN_READ_COLUMNS)
      .from(run)
      .innerJoin(testSuite, eq(run.suiteId, testSuite.id))
      .where(theRun(auth, id))
      .limit(1);

    if (selected === undefined) return undefined;
    const { suiteName, suiteDeletedAt, ...current } = selected;
    if (current.status === "canceled") {
      return runFromRow(current, suiteName, suiteDeletedAt !== null);
    }
    if (current.status === "completed") {
      throw new RunWriteRefusedError(
        "already_finished",
        nothingLeftToCancel(id),
      );
    }

    // Simulation rows first, the header last — the one lock order every
    // writer keeps. These `where`s narrow by the run id just checked above.
    while (true) {
      const queued = await tx
        .select({ id: simulation.id })
        .from(simulation)
        .where(
          within(
            auth,
            simulation,
            and(eq(simulation.runId, id), eq(simulation.status, "queued")),
          ),
        )
        .orderBy(asc(simulation.id))
        .limit(SIMULATION_INSERT_BATCH)
        .for("update", { of: simulation });
      if (queued.length === 0) break;
      await tx
        .update(simulation)
        .set({
          status: "canceled",
          cancelRequestedAt: now,
          endedAt: now,
        })
        .where(inArray(simulation.id, queued.map((row) => row.id)));
    }

    while (true) {
      const moving = await tx
        .select({ id: simulation.id })
        .from(simulation)
        .where(
          within(
            auth,
            simulation,
            and(
              eq(simulation.runId, id),
              inArray(simulation.status, ["claimed", "running"]),
              isNull(simulation.cancelRequestedAt),
            ),
          ),
        )
        .orderBy(asc(simulation.id))
        .limit(SIMULATION_INSERT_BATCH)
        .for("update", { of: simulation });
      if (moving.length === 0) break;
      await tx
        .update(simulation)
        .set({ cancelRequestedAt: now })
        .where(inArray(simulation.id, moving.map((row) => row.id)));
    }

    const [canceled] = await tx
      .update(run)
      .set({ status: "canceled" })
      .where(
        within(
          auth,
          run,
          and(eq(run.id, id), inArray(run.status, ["pending", "running"])),
        ),
      )
      .returning(RUN_COLUMNS);

    // The guarded update matching nothing means the run moved between the
    // read above and this write: a second cancel got there first, or a
    // reporter finalized it. Read again and answer as the first read would
    // have — the same idempotence, the same refusal, one race later.
    if (canceled === undefined) {
      const [selectedMoved] = await tx
        .select(RUN_READ_COLUMNS)
        .from(run)
        .innerJoin(testSuite, eq(run.suiteId, testSuite.id))
        .where(theRun(auth, id))
        .limit(1);
      const moved = selectedMoved === undefined
        ? undefined
        : (() => {
            const { suiteName: movedSuiteName, suiteDeletedAt: movedDeletedAt, ...row } = selectedMoved;
            return runFromRow(row, movedSuiteName, movedDeletedAt !== null);
          })();
      if (moved !== undefined && moved.status === "canceled") {
        return moved;
      }
      throw new RunWriteRefusedError("already_finished", nothingLeftToCancel(id));
    }

    await finalizeRunIfDone(tx, id, now);

    // Event writes page over the rows this cancel ended. No array grows with
    // the suite, and the final run event follows every conversation event.
    let after: string | undefined;
    while (true) {
      const ended = await tx
        .select({ id: simulation.id })
        .from(simulation)
        .where(
          within(
            auth,
            simulation,
            and(
              eq(simulation.runId, id),
              eq(simulation.status, "canceled"),
              eq(simulation.cancelRequestedAt, now),
              eq(simulation.endedAt, now),
              after === undefined ? undefined : gt(simulation.id, after),
            ),
          ),
        )
        .orderBy(asc(simulation.id))
        .limit(SIMULATION_INSERT_BATCH);
      if (ended.length === 0) break;
      await appendRunEvents(
        tx,
        id,
        now,
        ended.map((row) => ({
          kind: "simulation" as const,
          simulationId: row.id,
          status: "canceled" as const,
        })),
      );
      after = ended.at(-1)?.id;
      if (ended.length < SIMULATION_INSERT_BATCH) break;
    }
    await appendRunEvents(tx, id, now, [{ kind: "run", status: "canceled" }]);

    const [selectedSettled] = await tx
      .select(RUN_READ_COLUMNS)
      .from(run)
      .innerJoin(testSuite, eq(run.suiteId, testSuite.id))
      .where(theRun(auth, id))
      .limit(1);
    if (selectedSettled === undefined) return undefined;
    const { suiteName: settledSuiteName, suiteDeletedAt: settledDeletedAt, ...settled } = selectedSettled;
    return runFromRow(settled, settledSuiteName, settledDeletedAt !== null);
  });
}

/**
 * Claim metadata for spec assembly: scoped context, IDs, version pins, persona
 * parameter values, and claim timestamps. Read prompts and credentials afterward
 * through the scoped access functions.
 */
export type SimulationClaim = {
  readonly id: string;
  readonly runId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** Who calls, by identity, and the pin the traits are read from. */
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly personaParameterValues: PersonaParameterValues;
  /** What is being checked, by stable identity and exact immutable version. */
  readonly testId: string;
  readonly testVersionId: string;
  readonly modality: Modality;
  readonly claimedBy: string;
  readonly claimedAt: Date;
  /**
   * Narrowed to this simulation's own organization and project, built here
   * from the claimed row and from nothing the claimant said. It is what every
   * read the spec assembly makes goes through, so the conducting happens
   * inside one customer even though the claim that found the work was not.
   */
  readonly auth: AuthContext;
};

const SIMULATION_CLAIM_COLUMNS = {
  id: simulation.id,
  runId: simulation.runId,
  organizationId: simulation.organizationId,
  projectId: simulation.projectId,
  agentId: simulation.agentId,
  connectionId: simulation.connectionId,
  personaId: simulation.personaId,
  personaVersionId: simulation.personaVersionId,
  personaParameterValues: simulation.personaParameterValues,
  testId: simulation.testId,
  testVersionId: simulation.testVersionId,
  modality: simulation.modality,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
} as const;

/**
 * Service identity for simulator contexts. It is not a user ID and must not
 * be stored in user attribution columns.
 */
const THE_SIMULATOR = "simulator";

/**
 * Build a project-scoped simulator context from a claimed row. The member role
 * permits lifecycle writes; claimant checks and via=simulator separately restrict
 * which rows can change and which credentials can be opened.
 */
function conductingContext(
  organizationId: string,
  projectId: string,
): AuthContext {
  return {
    userId: THE_SIMULATOR,
    organizationId,
    projectId,
    role: "member",
    via: "simulator",
  };
}

export type SimulationClaimRequest = {
  /** This simulator's own name for itself. */
  readonly claimant: string;
  /** How many conversations it has room to conduct at once. */
  readonly capacity: number;
};

/**
 * Claim up to capacity eligible queued simulations across organizations with
 * FOR UPDATE SKIP LOCKED. Stamp ownership and heartbeat, start pending runs, and
 * append events in one transaction. Return each claim with a row-derived context.
 * The service chooses capacity and claimant, never an organization to claim from.
 */
export async function claimSimulations(
  request: SimulationClaimRequest,
): Promise<readonly SimulationClaim[]> {
  const claimant = validClaimant(request.claimant);
  const { capacity } = request;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > LARGEST_CLAIM_CAPACITY
  ) {
    throw new Error(
      `a claim takes between 1 and ${LARGEST_CLAIM_CAPACITY} simulations`,
    );
  }

  const now = new Date();

  const claimed = await db().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: simulation.id })
      .from(simulation)
      // Queued, **and** its run is ready to be conducted. For every run that
      // mocks nothing the second condition is true by construction; for a run
      // that owes itself a mocked world it stays false until the temporary
      // version exists, so a run that cannot build its world never has a
      // simulation conducted against the real tools. See `mock-tools/lanes.ts`.
      .where(
        and(eq(simulation.status, "queued"), runIsReadyToConduct(simulation.runId)),
      )
      .orderBy(asc(simulation.id))
      .limit(capacity)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];

    // Bare `eq`s and `inArray`s from here down: every id came off the rows
    // locked just above, in this same transaction, so nothing below reaches
    // further than that select already did.
    const rows = await tx
      .update(simulation)
      .set({
        status: "claimed",
        claimedBy: claimant,
        claimedAt: now,
        heartbeatAt: now,
      })
      .where(
        inArray(
          simulation.id,
          candidates.map((candidate) => candidate.id),
        ),
      )
      .returning(SIMULATION_CLAIM_COLUMNS);

    // The runs these came from, each flipped at most once, one at a time in
    // one order — so two claimants touching the same runs cannot deadlock.
    // Each run's events go in beside its own flip, in the same order: the
    // conversations that were picked up, and then the run that started
    // because they were.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const startedRunId of runIds) {
      const started = await tx
        .update(run)
        .set({ status: "running", startedAt: now })
        .where(and(eq(run.id, startedRunId), eq(run.status, "pending")))
        .returning({ id: run.id });

      await appendRunEvents(tx, startedRunId, now, [
        ...rows
          .filter((row) => row.runId === startedRunId)
          .map(
            (row) =>
              ({
                kind: "simulation",
                simulationId: row.id,
                status: "claimed",
              }) as const,
          ),
        ...(started.length === 0
          ? []
          : [{ kind: "run", status: "running" } as const]),
      ]);
    }

    return rows;
  });

  return claimed
    .map((row) => ({
      id: row.id,
      runId: row.runId,
      organizationId: row.organizationId,
      projectId: row.projectId,
      agentId: row.agentId,
      connectionId: row.connectionId,
      personaId: row.personaId,
      personaVersionId: row.personaVersionId,
      personaParameterValues: row.personaParameterValues,
      testId: row.testId,
      testVersionId: row.testVersionId,
      modality: row.modality as Modality,
      claimedBy: row.claimedBy ?? claimant,
      claimedAt: row.claimedAt ?? now,
      auth: conductingContext(row.organizationId, row.projectId),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Resolve simulation state, version pins, failure details, and a row-derived
 * context for internal report, heartbeat, and evidence ingestion paths.
 * Return terminal rows too: lifecycle handlers enforce state transitions while
 * evidence ingestion can retain late spans. Service authentication happens at the API.
 */
export async function resolveSimulationStanding(
  simulationId: string,
): Promise<SimulationStanding | undefined> {
  const [row] = await db()
    .select({
      id: simulation.id,
      runId: simulation.runId,
      organizationId: simulation.organizationId,
      projectId: simulation.projectId,
      agentId: simulation.agentId,
      testVersionId: simulation.testVersionId,
      personaVersionId: simulation.personaVersionId,
      modality: simulation.modality,
      status: simulation.status,
      endingReason: simulation.endingReason,
      executionFailure: simulation.executionFailure,
      claimedBy: simulation.claimedBy,
      cancelRequestedAt: simulation.cancelRequestedAt,
    })
    .from(simulation)
    .where(eq(simulation.id, simulationId))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    id: row.id,
    runId: row.runId,
    agentId: row.agentId,
    testVersionId: row.testVersionId,
    personaVersionId: row.personaVersionId,
    modality: row.modality as Modality,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    executionFailure: row.executionFailure,
    claimedBy: row.claimedBy,
    cancelRequestedAt: row.cancelRequestedAt,
    auth: conductingContext(row.organizationId, row.projectId),
  };
}

/**
 * Resolve a provider reference within the credential's explicit project. Accept
 * any lifecycle state so late agent POV evidence still reaches its simulation.
 * References are not unique; choose the newest simulation by createdAt, then ID.
 * Return undefined for an absent reference or project scope.
 */
export async function resolveSimulationByProviderReference(
  auth: AuthContext,
  providerReference: string,
): Promise<SimulationStanding | undefined> {
  authorize(auth, "read", here(auth));
  // A reference is matched exactly or not at all. An empty one is what a
  // resource that named none reads as, and it must never match the rows whose
  // column is null — nor, if the column ever held one, an empty string.
  if (auth.projectId === undefined || providerReference === "") return undefined;

  const [row] = await db()
    .select({
      id: simulation.id,
      runId: simulation.runId,
      organizationId: simulation.organizationId,
      projectId: simulation.projectId,
      agentId: simulation.agentId,
      testVersionId: simulation.testVersionId,
      personaVersionId: simulation.personaVersionId,
      modality: simulation.modality,
      status: simulation.status,
      endingReason: simulation.endingReason,
      executionFailure: simulation.executionFailure,
      claimedBy: simulation.claimedBy,
      cancelRequestedAt: simulation.cancelRequestedAt,
    })
    .from(simulation)
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.projectId, auth.projectId),
          eq(simulation.providerReference, providerReference),
        ),
      ),
    )
    .orderBy(desc(simulation.createdAt), desc(simulation.id))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    id: row.id,
    runId: row.runId,
    agentId: row.agentId,
    testVersionId: row.testVersionId,
    personaVersionId: row.personaVersionId,
    modality: row.modality as Modality,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    executionFailure: row.executionFailure,
    claimedBy: row.claimedBy,
    cancelRequestedAt: row.cancelRequestedAt,
    auth: conductingContext(row.organizationId, row.projectId),
  };
}

/**
 * Resolve the current connection key for pulling a completed Retell simulation's
 * agent POV. Require via=simulator, project scope, an active Retell connection,
 * a provider reference, and a usable key. Return undefined when any is absent.
 * Run-start platform reads use the separate resolveRunStartReach function.
 */
export type RetellSimulationPull = {
  readonly standing: SimulationStanding;
  /** Retell's own id for the conversation, off the simulation's own row. */
  readonly providerReference: string;
  /** The connection's Retell key, unsealed. */
  readonly apiKey: string;
  /** Where Retell answers for this connection, when the config names one. */
  readonly baseUrl: string | null;
};

export async function resolveRetellSimulationPull(
  auth: AuthContext,
  simulationId: string,
): Promise<RetellSimulationPull | undefined> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "a connection's credentials are unsealed for Egma's own simulator and for nothing else, because conducting is the only thing Egma does with them",
    );
  }

  const [row] = await db()
    .select({
      providerReference: simulation.providerReference,
      accessVariant: connection.accessVariant,
      config: connection.config,
      credentials: connection.credentials,
    })
    .from(simulation)
    .innerJoin(connection, eq(connection.id, simulation.connectionId))
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.id, simulationId),
          // Finished conducting, which is the one moment there is a record to
          // fetch: before it the conversation is still happening, and Retell
          // has nothing complete to answer with.
          eq(simulation.status, "completed"),
          isNull(connection.archivedAt),
          inActingProject(auth, simulation),
        ),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;
  const providerReference = row.providerReference?.trim() ?? "";
  if (providerReference === "") return undefined;
  // Every Retell access variant is one key against Retell's API. A connection
  // of any other kind has no call record to pull and is not asked for one.
  if (!row.accessVariant.startsWith("retell_")) return undefined;
  if (row.credentials === null) return undefined;

  const apiKey = openedApiKey(row.credentials);
  if (apiKey === null || apiKey === "") return undefined;

  const standing = await resolveSimulationStanding(simulationId);
  if (standing === undefined) return undefined;

  // The chat lane lets a customer point at their own Retell-compatible host,
  // and the pull must ask wherever the conversation was held. A config nobody
  // can read is not worth failing a landing over: Retell's own host is where
  // every connection that named none is answered from anyway.
  let baseUrl = "";
  try {
    baseUrl =
      stringRecordFromRow(row.config, () => new Error("unreadable"))[
        "baseUrl"
      ]?.trim() ?? "";
  } catch {
    baseUrl = "";
  }

  return {
    standing,
    providerReference,
    apiKey,
    baseUrl: baseUrl === "" ? null : baseUrl,
  };
}

/**
 * Find which provider references already belong to simulations in this project.
 * Production polling uses this batched lookup to avoid filing simulation evidence
 * again as production traffic. No project scope returns an empty set.
 */
export async function simulationProviderReferencesIn(
  auth: AuthContext,
  providerReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  authorize(auth, "read", here(auth));
  const asked = [...new Set(providerReferences.filter((one) => one !== ""))];
  if (auth.projectId === undefined || asked.length === 0) return new Set();

  const rows = await db()
    .select({ providerReference: simulation.providerReference })
    .from(simulation)
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.projectId, auth.projectId),
          inArray(simulation.providerReference, asked),
        ),
      ),
    );

  return new Set(
    rows
      .map((row) => row.providerReference)
      .filter((one): one is string => one !== null),
  );
}

/**
 * Resolve the simulation, its run liveness, pinned mock answers, and row-derived
 * context for the public mock endpoint. The endpoint checks run liveness and tool
 * coverage; this read does not authenticate the requester or open credentials.
 */
export type MockToolCallTarget = {
  readonly runId: string;
  /** Whether the run can still be conducting simulations. */
  readonly runIsLive: boolean;
  readonly simulation: {
    readonly id: string;
    readonly agentId: string;
    readonly testVersionId: string;
    readonly personaVersionId: string;
    readonly status: SimulationStatus;
    /** What this simulation is answered: its pinned test version's own list. */
    readonly answers: readonly TestMockTool[];
  };
  readonly auth: AuthContext;
};

export async function resolveMockToolCall(
  simulationId: string,
): Promise<MockToolCallTarget | undefined> {
  const [row] = await db()
    .select({
      id: simulation.id,
      agentId: simulation.agentId,
      testVersionId: simulation.testVersionId,
      personaVersionId: simulation.personaVersionId,
      status: simulation.status,
      runId: run.id,
      organizationId: run.organizationId,
      projectId: run.projectId,
      runStatus: run.status,
      runFinishedAt: run.finishedAt,
      mockTools: testVersion.mockTools,
    })
    .from(simulation)
    .innerJoin(run, eq(simulation.runId, run.id))
    .innerJoin(testVersion, eq(simulation.testVersionId, testVersion.id))
    .where(eq(simulation.id, simulationId))
    .limit(1);
  if (row === undefined) return undefined;

  const auth = conductingContext(row.organizationId, row.projectId);

  // Read off the pinned version in the same statement as the row, because the
  // version is immutable: what this simulation is answered was settled when the
  // run pinned it and nothing since can have moved it. The endpoint and the
  // simulator therefore read one list rather than merging two.
  const answers = mockToolsOfVersion(row.mockTools, row.testVersionId);

  return {
    runId: row.runId,
    // Live means the run can still be conducting: it has not been finished,
    // and it has not been canceled. A finished run's world has been torn down,
    // so an answer served after it would be an answer from a world that no
    // longer exists.
    runIsLive:
      row.runFinishedAt === null &&
      (row.runStatus === "pending" || row.runStatus === "running"),
    simulation: {
      id: row.id,
      agentId: row.agentId,
      testVersionId: row.testVersionId,
      personaVersionId: row.personaVersionId,
      status: row.status as SimulationStatus,
      answers,
    },
    auth,
  };
}

/** The plaintext key inside a sealed `{ apiKey }` envelope, or null. */
function openedApiKey(envelope: string): string | null {
  try {
    const opened = openCredentials(envelope);
    if (
      typeof opened === "object" &&
      opened !== null &&
      !Array.isArray(opened) &&
      typeof (opened as { apiKey?: unknown }).apiKey === "string"
    ) {
      return (opened as { apiKey: string }).apiKey;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * What `resolveSimulationStanding` answers with: the row's lifecycle stamps,
 * the pins its evidence is filed under, and the narrowed context every write
 * about the row goes through.
 */
export type SimulationStanding = {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  /** The exact immutable test version this conversation executes. */
  readonly testVersionId: string;
  readonly personaVersionId: string;
  readonly modality: Modality;
  readonly status: SimulationStatus;
  readonly endingReason: SimulationEndingReason | null;
  readonly executionFailure: string | null;
  /** The row's conductor — the claimant whose word the row takes. */
  readonly claimedBy: string | null;
  readonly cancelRequestedAt: Date | null;
  /**
   * Narrowed to this simulation's own organization and project, built here
   * from the row and from nothing the caller said — the claim's context,
   * derived again for the calls that come back later.
   */
  readonly auth: AuthContext;
};

/**
 * How the simulator reaches the agent of one claimed simulation: the
 * connection type, access variant, non-secret config, and unsealed credentials
 * — or null where the access variant takes no customer secret.
 */
export type SimulationConnection = {
  readonly connectionId: string;
  readonly agentPlatform: AgentPlatform | null;
  readonly connectionType: ConnectionType;
  readonly accessVariant: AccessVariant;
  readonly config: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>> | null;
};

/**
 * Open connection credentials only for a simulator context assembling a claimed
 * simulation in its project. Use the connection named by that simulation.
 * Return undefined for unseen or non-claimed simulations and archived connections;
 * reject connection tuples the current simulator cannot conduct.
 */
export async function resolveSimulationConnection(
  auth: AuthContext,
  simulationId: string,
): Promise<SimulationConnection | undefined> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "a connection's credentials are unsealed for Egma's own simulator and for nothing else, because conducting is the only thing Egma does with them",
    );
  }

  const [row] = await db()
    .select({
      connectionId: connection.id,
      agentPlatform: agent.agentPlatform,
      connectionType: connection.connectionType,
      accessVariant: connection.accessVariant,
      modality: connection.modality,
      config: connection.config,
      credentials: connection.credentials,
    })
    .from(simulation)
    .innerJoin(connection, eq(simulation.connectionId, connection.id))
    .innerJoin(agent, eq(agent.id, connection.agentId))
    .where(
      within(
        auth,
        simulation,
        and(
          eq(simulation.id, simulationId),
          eq(simulation.status, "claimed"),
          isNull(connection.archivedAt),
          inActingProject(auth, simulation),
        ),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  if (
    !connectionIsConductable(
      row.connectionType,
      row.accessVariant,
      row.modality,
    )
  ) {
    throw new Error(
      noSimulatorAdapterMessage(row.connectionType, row.modality),
    );
  }

  const malformed = (held: string) => () =>
    new Error(
      `connection ${row.connectionId} holds ${held} in a shape Egma never ` +
        `writes; the row needs repairing before anybody can conduct over it`,
    );

  return {
    connectionId: row.connectionId,
    agentPlatform:
      platformOfConnectionType(row.connectionType) ??
      (row.agentPlatform as AgentPlatform | null),
    connectionType: row.connectionType as ConnectionType,
    accessVariant: row.accessVariant as AccessVariant,
    config: stringRecordFromRow(row.config, malformed("config")),
    credentials:
      row.credentials === null
        ? null
        : stringRecordFromRow(
            openCredentials(row.credentials),
            malformed("credentials"),
          ),
  };
}

/** One beat, as the wire carries it: which simulation, and who is conducting. */
export type SimulationHeartbeat = {
  readonly simulationId: string;
  /** This simulator's own name for itself — the name the claim stamped. */
  readonly claimant: string;
};

/**
 * Update heartbeat only for this claimant's claimed or running simulation and
 * return cancel intent. Undefined means the simulator must stop. This internal
 * service operation takes no customer scope and returns no authored content.
 */
export async function recordSimulationHeartbeat(
  beat: SimulationHeartbeat,
): Promise<{ readonly cancelRequested: boolean } | undefined> {
  const [row] = await db()
    .update(simulation)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        eq(simulation.id, beat.simulationId),
        eq(simulation.claimedBy, validClaimant(beat.claimant)),
        inArray(simulation.status, ["claimed", "running"]),
      ),
    )
    .returning({ cancelRequestedAt: simulation.cancelRequestedAt });

  if (row === undefined) return undefined;
  return { cancelRequested: row.cancelRequestedAt !== null };
}

/**
 * The conversation is underway: `claimed → running`, stamped with the moment
 * it started, by the claimant conducting it. `undefined` on anything else —
 * the guarded update is the check, so there is no window in which the row
 * moves between being looked at and being moved.
 *
 * In a transaction because the move and its event are one fact: a guarded
 * update that matched nothing writes neither, and one that matched writes both.
 */
export async function startSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({ status: "running", startedAt: now, heartbeatAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, validClaimant(claimant)),
            eq(simulation.status, "claimed"),
            inActingProject(auth, simulation),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;

    await appendRunEvents(tx, row.runId, now, [
      { kind: "simulation", simulationId: row.id, status: "running" },
    ]);
    return simulationFromRow(row);
  });
}

/**
 * Write terminal facts only for the claimant's eligible simulation in scope.
 * Check grading readiness for completed simulations, finalize the run if done,
 * and append lifecycle events in one transaction. Return undefined if no row moved.
 */
async function landSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  landing: {
    readonly from: readonly SimulationStatus[];
    /**
     * Everything this landing writes beside the heartbeat — including
     * `ended_at`, when the report carried the conduction's own moment; the
     * stamp below is only the fallback for a report that brought none.
     */
    readonly write: Record<string, unknown>;
    /** Any further condition the landing requires of the row. */
    readonly onlyWhere?: SQL | undefined;
  },
): Promise<Simulation | undefined> {
  const now = new Date();
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(simulation)
      .set({ endedAt: now, ...landing.write, heartbeatAt: now })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.claimedBy, validClaimant(claimant)),
            inArray(simulation.status, [...landing.from]),
            landing.onlyWhere,
            inActingProject(auth, simulation),
          ),
        ),
      )
      .returning(SIMULATION_COLUMNS);

    if (row === undefined) return undefined;

    if (row.status === "completed") {
      const traceId = traceIdOfSimulation(row.id);
      if (traceId === undefined || row.startedAt === null) {
        throw new Error(`completed simulation ${row.id} has no trace identity or start time`);
      }
      const hasPlannedGraders = await simulationHasPlannedGradersOn(
        auth,
        tx,
        row.id,
      );
      if (hasPlannedGraders === undefined) {
        throw new Error(`completed simulation ${row.id} has no grading plan`);
      }
      if (hasPlannedGraders) {
        // Expect an agent POV only when the run's frozen connection type supports it
        // and the simulation reported a provider reference. Evidence need not have arrived
        // yet; the readiness check applies the wait bound (ADR-0024 §6).
        const [executed] = await tx
          .select({ connectionSnapshot: run.connectionSnapshot })
          .from(run)
          .where(eq(run.id, row.runId))
          .limit(1);
        const reference = row.providerReference;
        const producesAnAgentPov =
          laneProducesAnAgentPov(
            (executed?.connectionSnapshot as { connectionType?: string })
              ?.connectionType ?? "",
          ) &&
          reference !== null &&
          reference !== "";
        // Evidence may have drained before this lifecycle transition. Probe the
        // bounded trace window, then request work inside this same Postgres
        // transaction. A crash cannot commit "completed" without also
        // committing the queue row when evidence was already visible.
        const readiness = await simulationEvidenceReadiness(auth, {
          traceId,
          runId: row.runId,
          window: {
            // The simulation row and provider spans do not share one clock. A
            // five-minute cushion keeps an earlier provider timestamp visible
            // when evidence drains before this completion transaction.
            from: BigInt(row.startedAt.getTime() - 5 * 60 * 1_000) * 1_000n,
            // The store uses an exclusive upper bound. One second keeps a span
            // stamped at the landing boundary inside this small probe.
            to: BigInt(now.getTime() + 1_000) * 1_000n,
          },
          producesAnAgentPov,
          completedAt: now,
          now,
        });
        await requestGradingIn(tx, auth, {
          source: "simulation",
          traceId,
          traceStartedAt: readiness.traceStartedAt ?? row.startedAt,
          runId: row.runId,
          endsTrace: true,
          modality: row.modality as Modality,
          evidenceReady: readiness.ready,
        });
      }
    }
    const settled = await finalizeRunIfDone(tx, row.runId, now);
    await appendRunEvents(tx, row.runId, now, [
      {
        kind: "simulation",
        simulationId: row.id,
        status: row.status as SimulationStatus,
        reason: row.endingReason as SimulationEndingReason | null,
      },
      ...(settled === undefined
        ? []
        : [{ kind: "run", status: settled } as const]),
    ]);
    return simulationFromRow(row);
  });
}

/**
 * A conversation happened and this is its record: `running → completed`, the
 * terminal facts written once — how it ended and the summary facts. What was
 * said is not among them: the conversation is its spans, and they are already
 * stored.
 */
export async function completeSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  report: SimulationReport,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (!COMPLETED_ENDING_REASONS.includes(report.endingReason)) {
    throw new Error(
      `"${report.endingReason}" is not a way a conversation ends`,
    );
  }

  return landSimulation(auth, id, claimant, {
    from: ["running"],
    write: {
      status: "completed",
      endingReason: report.endingReason,
      ...summaryFactsWrite(report),
    },
  });
}

/**
 * The simulation ends without a conversation to grade — or with a partial
 * one, whatever reached the trace store before it stopped, which is the
 * honest "started, never finished" record. From `claimed`
 * (the agent never joined, the line was never answered) or from `running`
 * (something died mid-conversation). Never graded: the reasons here are the
 * "test never ran" class, and keeping them apart from a bad conversation is
 * the one normalisation a test product cannot get wrong.
 */
export async function failSimulation(
  auth: AuthContext,
  id: string,
  claimant: string,
  failure: SimulationFailure,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (!REPORTABLE_FAILURE_REASONS.includes(failure.reason)) {
    throw new Error(`"${failure.reason}" is not a way a simulation fails`);
  }

  return landSimulation(auth, id, claimant, {
    from: ["claimed", "running"],
    write: {
      status: "failed",
      endingReason: failure.reason,
      executionFailure: executionFailureWrite(failure.message),
      ...summaryFactsWrite(failure),
    },
  });
}

/**
 * Mark a claimed simulation dispatch_failed when spec assembly cannot hand it over.
 * Require the claimant and via=simulator. Use normal terminal handling to settle
 * the run and append events, without creating grading work or requeueing.
 */
export async function failSimulationDispatch(
  auth: AuthContext,
  id: string,
  claimant: string,
  message = "Egma could not dispatch this simulation to a simulator.",
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "dispatch_failed is the platform's own confession that it could not hand a claimed simulation over, and only the claim path — conducting as the simulator — stands where that happens",
    );
  }

  return landSimulation(auth, id, claimant, {
    from: ["claimed"],
    write: {
      status: "failed",
      endingReason: "dispatch_failed",
      executionFailure: executionFailureWrite(message),
    },
  });
}

/**
 * Give a claimed simulation back when a provider preflight could not answer.
 *
 * A temporary provider outage is not evidence that the simulation or agent is
 * broken. The claim path therefore clears only its own lease and lets a later
 * claim try again. A concurrent cancel wins: this update requires no cancel
 * intent, so the existing claimant remains responsible for honoring one.
 */
export async function releaseSimulationClaim(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<boolean> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  if (auth.via !== "simulator") {
    throw new Error(
      "only the claim path may release a provider preflight it could not finish",
    );
  }

  const now = new Date();
  return db().transaction(async (tx) => {
    const [released] = await tx
      .update(simulation)
      .set({
        status: "queued",
        claimedBy: null,
        claimedAt: null,
        heartbeatAt: null,
      })
      .where(
        within(
          auth,
          simulation,
          and(
            eq(simulation.id, id),
            eq(simulation.status, "claimed"),
            eq(simulation.claimedBy, validClaimant(claimant)),
            isNull(simulation.cancelRequestedAt),
            inActingProject(auth, simulation),
          ),
        ),
      )
      .returning({ id: simulation.id, runId: simulation.runId });
    if (released === undefined) return false;

    await appendRunEvents(tx, released.runId, now, [
      { kind: "simulation", simulationId: released.id, status: "queued" },
    ]);
    return true;
  });
}

/**
 * Acknowledge recorded cancellation for this claimant's claimed or running
 * simulation. Preserve available summary facts; reject cancellation without intent.
 */
export async function markSimulationCanceled(
  auth: AuthContext,
  id: string,
  claimant: string,
  facts: SimulationSummaryFacts = {},
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  return landSimulation(auth, id, claimant, {
    from: ["claimed", "running"],
    write: { status: "canceled", ...summaryFactsWrite(facts) },
    onlyWhere: isNotNull(simulation.cancelRequestedAt),
  });
}

/**
 * What the sweep answers with: which rows it ended, named and nothing more.
 * The caller's whole use for the answer is to say what happened — anything
 * fuller would carry customers' content out of a call that has no context
 * to hold it to one customer.
 */
export type SweptSimulation = {
  readonly id: string;
  readonly runId: string;
};

/**
 * Fail claimed or running simulations whose heartbeat exceeds the stale window,
 * with reason orphaned. Finalize affected runs and append events in one transaction.
 * The guarded update excludes already terminal rows; process affected runs in ID
 * order. This deployment sweep returns IDs and creates no grading work.
 */
export async function sweepOrphanedSimulations(
  options?: { readonly staleAfterSeconds?: number | undefined },
): Promise<readonly SweptSimulation[]> {
  const staleAfterSeconds =
    options?.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (!Number.isInteger(staleAfterSeconds) || staleAfterSeconds < 1) {
    throw new Error("a staleness window is a positive whole number of seconds");
  }

  const now = new Date();
  const silentSince = new Date(now.getTime() - staleAfterSeconds * 1000);

  const swept = await db().transaction(async (tx) => {
    const rows = await tx
      .update(simulation)
      .set({
        status: "failed",
        endingReason: "orphaned",
        executionFailure:
          "The simulator stopped reporting before this simulation finished.",
        endedAt: now,
      })
      .where(
        and(
          inArray(simulation.status, ["claimed", "running"]),
          lt(simulation.heartbeatAt, silentSince),
        ),
      )
      .returning({
        id: simulation.id,
        runId: simulation.runId,
        organizationId: simulation.organizationId,
        projectId: simulation.projectId,
        status: simulation.status,
      });

    // Each affected run at most once, in one order, as everywhere else — and
    // each one's events beside its own finish.
    const runIds = [...new Set(rows.map((row) => row.runId))].sort();
    for (const orphanedRunId of runIds) {
      const settled = await finalizeRunIfDone(tx, orphanedRunId, now);
      await appendRunEvents(tx, orphanedRunId, now, [
        ...rows
          .filter((row) => row.runId === orphanedRunId)
          .map(
            (row) =>
              ({
                kind: "simulation",
                simulationId: row.id,
                status: "failed",
                reason: "orphaned",
              }) as const,
          ),
        ...(settled === undefined
          ? []
          : [{ kind: "run", status: settled } as const]),
      ]);
    }

    return rows;
  });

  return swept.map((row) => ({ id: row.id, runId: row.runId }));
}

/**
 * One change to a run, in the order it happened.
 *
 * The two names are joined from the simulation this is about rather than
 * copied onto the row at write time, so a feed and the run's own page can never
 * disagree about what a conversation is called. What was *executed* is pinned
 * on the simulation and never moves; what it is *called* is answered now.
 */
export type RunEvent = {
  readonly runId: string;
  /** Dense from one, within this run. The whole of the cursor. */
  readonly seq: number;
  readonly at: Date;
  readonly kind: RunEventKind;
  /** Absent on a run event, which is about the header itself. */
  readonly simulationId: string | null;
  readonly testName: string | null;
  readonly personaName: string | null;
  /** A run status on a run event; a simulation status on a simulation one. */
  readonly status: RunStatus | SimulationStatus;
  readonly reason: SimulationEndingReason | null;
  /** Present on a failed simulation event when its row retained the message. */
  readonly executionFailure: string | null;
};

/** A bounded page of changes, where to ask from next, and whether there will be more. */
export type RunEventPage = {
  readonly events: readonly RunEvent[];
  /** Hand back as `after` to continue; the same number again on an empty page. */
  readonly next: number;
  /** True when this page reached the end of the event tail that existed when it was read. */
  readonly caughtUp: boolean;
  /** True once the run has finished, and only then. */
  readonly done: boolean;
};

/**
 * The last event visible with one run detail, or zero before its first event.
 *
 * A browser keeps this first value as its live-notification boundary. The run
 * detail is what makes the page visible, so an event after this read is new to
 * that page even when the bounded feed takes several requests to reach it.
 */
export async function latestRunEventSequence(
  auth: AuthContext,
  runId: string,
): Promise<number | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select({ id: run.id, seq: max(runEvent.seq) })
    .from(run)
    .leftJoin(runEvent, eq(runEvent.runId, run.id))
    .where(theRun(auth, runId))
    .groupBy(run.id)
    .limit(1);
  return row === undefined ? undefined : (row.seq ?? 0);
}

/**
 * Page events after a sequence number; clients resume from the last applied number
 * and deduplicate by sequence. Read the header before events so done cannot hide
 * a final event committed between the reads. Fetch one extra row to detect a tail
 * and report done only when the run finished and this page reaches the end.
 */
export async function listRunEvents(
  auth: AuthContext,
  runId: string,
  options?: { readonly after?: number | undefined },
): Promise<RunEventPage | undefined> {
  authorize(auth, "read", here(auth));

  const after = options?.after ?? 0;
  if (!Number.isInteger(after) || after < 0) {
    throw new Error(
      "a follower asks for everything after a sequence number, which is a whole number from zero",
    );
  }

  const header = await getRun(auth, runId);
  if (header === undefined) return undefined;

  const rows = await db()
    .select({
      runId: runEvent.runId,
      seq: runEvent.seq,
      at: runEvent.createdAt,
      kind: runEvent.kind,
      simulationId: runEvent.simulationId,
      testName: test.name,
      personaName: persona.name,
      status: runEvent.status,
      reason: runEvent.reason,
      executionFailure: simulation.executionFailure,
    })
    .from(runEvent)
    .leftJoin(simulation, eq(runEvent.simulationId, simulation.id))
    .leftJoin(test, eq(simulation.testId, test.id))
    .leftJoin(persona, eq(simulation.personaId, persona.id))
    .where(
      within(
        auth,
        runEvent,
        and(
          eq(runEvent.runId, runId),
          gt(runEvent.seq, after),
          inActingProject(auth, runEvent),
        ),
      ),
    )
    .orderBy(asc(runEvent.seq))
    .limit(RUN_EVENT_PAGE_SIZE + 1);

  const hasLater = rows.length > RUN_EVENT_PAGE_SIZE;
  const events = rows.slice(0, RUN_EVENT_PAGE_SIZE).map((row) => ({
    ...row,
    kind: row.kind as RunEventKind,
    status: row.status as RunStatus | SimulationStatus,
    reason: row.reason as SimulationEndingReason | null,
    // The joined simulation now holds its terminal failure for good. Earlier
    // queued, claimed, or running events did not know it yet, so the feed must
    // not rewrite their history with a fact that arrived later.
    executionFailure:
      row.kind === "simulation" && row.status === "failed"
        ? row.executionFailure
        : null,
  }));

  return {
    events,
    next: events.at(-1)?.seq ?? after,
    caughtUp: !hasLater,
    done: header.finishedAt !== null && !hasLater,
  };
}

/**
 * Cancel work in the same transaction that archives its connections. End queued
 * simulations immediately and stamp cancel intent on claimed or running ones.
 * Mark affected active runs canceled and append events. Finalize counts when all
 * simulations end; retain the evidence already produced.
 */
export async function stopWorkOverConnections(
  tx: Transaction,
  auth: AuthContext,
  connectionIds: readonly string[],
  now: Date,
): Promise<number> {
  let canceledRunCount = 0;
  for (let offset = 0; offset < connectionIds.length; offset += SIMULATION_INSERT_BATCH) {
    const connectionBatch = connectionIds.slice(offset, offset + SIMULATION_INSERT_BATCH);
    while (connectionBatch.length > 0) {
      const touched = await tx
        .select({ id: simulation.id, runId: simulation.runId, status: simulation.status })
        .from(simulation)
        .where(
          within(
            auth,
            simulation,
            and(
              inArray(simulation.connectionId, connectionBatch),
              or(
                eq(simulation.status, "queued"),
                and(
                  inArray(simulation.status, ["claimed", "running"]),
                  isNull(simulation.cancelRequestedAt),
                ),
              ),
            ),
          ),
        )
        .orderBy(asc(simulation.id))
        .limit(SIMULATION_INSERT_BATCH)
        .for("update", { of: simulation });
      if (touched.length === 0) break;

      const endedHere = touched.filter((row) => row.status === "queued");
      const asked = touched.filter((row) => row.status !== "queued");
      if (endedHere.length > 0) {
        await tx
          .update(simulation)
          .set({ status: "canceled", cancelRequestedAt: now, endedAt: now })
          .where(inArray(simulation.id, endedHere.map((row) => row.id)));
      }
      if (asked.length > 0) {
        await tx
          .update(simulation)
          .set({ cancelRequestedAt: now })
          .where(inArray(simulation.id, asked.map((row) => row.id)));
      }

      const runIds = [...new Set(touched.map((row) => row.runId))].sort();
      for (const runId of runIds) {
        const [header] = await tx
          .update(run)
          .set({ status: "canceled" })
          .where(and(eq(run.id, runId), inArray(run.status, ["pending", "running"])))
          .returning({ id: run.id });
        const ended = endedHere.filter((row) => row.runId === runId);
        await appendRunEvents(tx, runId, now, [
          ...ended.map(
            (row) =>
              ({ kind: "simulation", simulationId: row.id, status: "canceled" }) as const,
          ),
          ...(header === undefined
            ? []
            : [{ kind: "run", status: "canceled" } as const]),
        ]);
        if (header !== undefined) canceledRunCount += 1;
        await finalizeRunIfDone(tx, runId, now);
      }
    }
  }
  return canceledRunCount;
}
