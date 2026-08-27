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

import { db, type Queryable, type Transaction } from "../client.ts";
import { planGroupsFor } from "../grading/plan.ts";
import {
  agent,
  connection,
  type AccessVariant,
  type AgentPlatform,
  type ConnectionType,
  type Modality,
  type Topology,
} from "../schema/agents.ts";
import { persona } from "../schema/personas.ts";
import { idempotentOperation } from "../schema/plans.ts";
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
  type MockToolSnapshot,
  type SnapshotDefault,
  type SnapshotEntry,
} from "../mock-tools/resolve.ts";
import { stringRecordFromRow } from "./agents.ts";
import { validClaimant } from "./claimants.ts";
import {
  connectionIsConductable,
  noSimulatorAdapterMessage,
  platformOfConnectionType,
} from "./connection-registry.ts";
import type { AuthContext } from "./context.ts";
import { IdempotencyConflictError, RunWriteRefusedError } from "./errors.ts";
import { requestGradingIn, traceEvidenceStartedAt } from "./grading.ts";
import { mockToolsApplyingTo } from "./mock-tools.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import {
  applicableGraders,
  refuseRun,
  resolvePersonaVersions,
  simulationHasPlannedGradersOn,
  writeGradingPlan,
} from "./run-plans.ts";
import {
  getTestVersionExecutionContent,
  type TestExecutionContent,
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
  readonly idempotencyKey: string;
  readonly name?: string | undefined;
  readonly expectedTestVersions?: readonly ExpectedTestVersion[] | undefined;
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
  readonly expectedSimulationCount: number;
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

export type StartedRun = Run;

export type MockToolCoverage = {
  readonly discovered: readonly string[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
};

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
  readonly failureDetail: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly recordingReference: string | null;
  readonly turnCount: number | null;
  readonly providerReference: string | null;
  readonly mockToolCoverage: MockToolCoverage | null;
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
  readonly mockToolCoverage?: MockToolCoverage | undefined;
  readonly startedAt?: Date | undefined;
  readonly endedAt?: Date | undefined;
};

export type SimulationReport = SimulationSummaryFacts & {
  readonly endingReason: CompletedEndingReason;
};

export type SimulationFailure = SimulationSummaryFacts & {
  readonly reason: Exclude<FailedEndingReason, "orphaned" | "dispatch_failed">;
  readonly detail: string;
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
  failureDetail: simulation.failureDetail,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
  heartbeatAt: simulation.heartbeatAt,
  cancelRequestedAt: simulation.cancelRequestedAt,
  startedAt: simulation.startedAt,
  endedAt: simulation.endedAt,
  recordingReference: simulation.recordingReference,
  turnCount: simulation.turnCount,
  providerReference: simulation.providerReference,
  mockToolCoverage: simulation.mockToolCoverage,
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
  readonly expectedSimulationCount: number;
  readonly completedCount: number | null;
  readonly failedCount: number | null;
  readonly canceledCount: number | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
};

type SimulationRow = Omit<Simulation, "status" | "endingReason" | "modality" | "mockToolCoverage"> & {
  readonly status: string;
  readonly endingReason: string | null;
  readonly modality: string;
  readonly mockToolCoverage: unknown;
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
  if (facts.mockToolCoverage !== undefined) {
    write.mockToolCoverage = {
      discovered: [...facts.mockToolCoverage.discovered],
      covered: [...facts.mockToolCoverage.covered],
      uncovered: [...facts.mockToolCoverage.uncovered],
    };
  }
  if (facts.startedAt !== undefined) write.startedAt = facts.startedAt;
  if (facts.endedAt !== undefined) write.endedAt = facts.endedAt;
  return write;
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

function mockToolSnapshotFromRow(value: unknown, runId: string): MockToolSnapshot {
  const malformed = () => new Error(`run ${runId} holds a malformed mock-tool snapshot`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformed();
  const { defaults, overrides } = value as Record<string, unknown>;
  if (
    !Array.isArray(defaults) ||
    typeof overrides !== "object" ||
    overrides === null ||
    Array.isArray(overrides) ||
    Object.keys(overrides).length !== 0
  ) {
    throw malformed();
  }
  const entryFromRow = (entry: unknown): SnapshotEntry => {
    if (typeof entry !== "object" || entry === null) throw malformed();
    const { toolName, answer, delayMilliseconds } = entry as Record<string, unknown>;
    if (typeof toolName !== "string" || typeof delayMilliseconds !== "number" || typeof answer !== "object" || answer === null) throw malformed();
    const held = answer as Record<string, unknown>;
    const read = "error" in held
      ? { error: held.error as string }
      : { answer: held.answer };
    return { toolName, delayMilliseconds, answer: read } as SnapshotEntry;
  };
  return {
    defaults: defaults.map((entry): SnapshotDefault => {
      const mockToolId = (entry as Record<string, unknown>).mockToolId;
      if (typeof mockToolId !== "string") throw malformed();
      return { ...entryFromRow(entry), mockToolId };
    }),
    overrides: {},
  };
}

function mockToolCoverageFromRow(value: unknown, simulationId: string): MockToolCoverage | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`simulation ${simulationId} holds malformed mock-tool coverage`);
  }
  const row = value as Record<string, unknown>;
  const list = (key: string): readonly string[] => {
    const held = row[key];
    if (!Array.isArray(held) || held.some((one) => typeof one !== "string")) {
      throw new Error(`simulation ${simulationId} holds malformed mock-tool coverage`);
    }
    return held as string[];
  };
  return { discovered: list("discovered"), covered: list("covered"), uncovered: list("uncovered") };
}

function runFromRow(
  row: RunRow,
  suiteName: string,
  suiteDeleted: boolean,
): Run {
  const { status, triggeredVia, connectionSnapshot, ...rest } = row;
  return {
    ...rest,
    suiteName,
    suiteDeleted,
    status: status as RunStatus,
    triggeredVia: triggeredVia as RunTrigger,
    connectionSnapshot: connectionSnapshotFromRow(connectionSnapshot, row.id),
  };
}

function simulationFromRow(row: SimulationRow): Simulation {
  return {
    ...row,
    status: row.status as SimulationStatus,
    endingReason: row.endingReason as SimulationEndingReason | null,
    modality: row.modality as Modality,
    mockToolCoverage: mockToolCoverageFromRow(row.mockToolCoverage, row.id),
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

async function freezeMockTools(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  agentId: string,
): Promise<MockToolSnapshot> {
  const defaults = await mockToolsApplyingTo(on, auth, projectId, agentId);
  return {
    defaults: defaults.map((one) => ({
      mockToolId: one.id,
      toolName: one.toolName,
      answer: one.answer,
      delayMilliseconds: one.delayMilliseconds,
    })),
    overrides: {},
  };
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

function digestOfStart(input: NewRun): string {
  const expected = [...(input.expectedTestVersions ?? [])]
    .map((one) => [one.testId, one.versionId] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256")
    .update(JSON.stringify({
      suite: input.suiteId,
      agent: input.agentId,
      connection: input.connectionId,
      name: input.name?.trim() || null,
      expected,
    }))
    .digest("hex");
}

function lostToIdempotencyKey(cause: unknown): boolean {
  const held = cause as { constraint?: unknown; cause?: unknown };
  if (held.constraint === "idempotent_operation_pk") return true;
  return (held.cause as { constraint?: unknown } | undefined)?.constraint === "idempotent_operation_pk";
}

async function originalRunFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  input: NewRun,
): Promise<StartedRun | undefined> {
  const [remembered] = await on
    .select({ resultId: idempotentOperation.resultId, requestDigest: idempotentOperation.requestDigest })
    .from(idempotentOperation)
    .where(and(
      eq(idempotentOperation.organizationId, auth.organizationId),
      eq(idempotentOperation.projectId, projectId),
      eq(idempotentOperation.actorId, auth.userId),
      eq(idempotentOperation.operation, "start_run"),
      eq(idempotentOperation.idempotencyKey, input.idempotencyKey.trim()),
    ))
    .limit(1);
  if (remembered === undefined) return undefined;
  if (remembered.requestDigest !== digestOfStart(input)) {
    throw new IdempotencyConflictError(input.idempotencyKey, remembered.resultId);
  }
  const found = await getRun(auth, remembered.resultId);
  if (found === undefined) throw new IdempotencyConflictError(input.idempotencyKey, remembered.resultId);
  return found;
}

/** Start one complete suite under one exact database lock. */
export async function startRun(auth: AuthContext, input: NewRun): Promise<StartedRun> {
  authorize(auth, "start_and_cancel_runs", here(auth));
  const { projectId } = auth;
  if (projectId === undefined) throw new Error("a run happens inside a project");
  if (!isId("ste", input.suiteId)) refuseRun("not_admitted", `"${input.suiteId}" is not a test suite id`);
  if (!isId("agt", input.agentId)) refuseRun("connection_not_on_agent", `"${input.agentId}" is not an agent id`);
  if (!isId("con", input.connectionId)) refuseRun("no_such_connection", `"${input.connectionId}" is not a connection id`);
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey === "") refuseRun("not_admitted", "a run needs an idempotency key");
  const expected = validateExpectedVersions(input.expectedTestVersions);
  const expectedInOrder = expected === undefined
    ? undefined
    : [...expected].sort((a, b) => a.testId.localeCompare(b.testId));
  const remembered = await originalRunFor(db(), auth, projectId, input);
  if (remembered !== undefined) return remembered;

  const runId = newId("run");
  const at = new Date();
  let created: Run | undefined;
  try {
    created = await db().transaction(async (tx) => {
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

      const graderCandidates = await applicableGraders(auth, tx, projectId);
      const plannedTests: {
        suiteId: string;
        testId: string;
        testVersionId: string;
        modality: Modality;
      }[] = [];
      const mockToolSnapshot = await freezeMockTools(
        tx,
        auth,
        projectId,
        reached.agentId,
      );
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
        mockToolSnapshot,
        expectedSimulationCount,
        createdAt: at,
      }).returning(RUN_COLUMNS);
      if (header === undefined) throw new Error("the run was not written");

      let simulationCount = 0;
      let expectedIndex = 0;
      while (currentTests.length > 0) {
        for (const current of currentTests) {
          const expectedCurrent = expectedInOrder?.[expectedIndex];
          if (
            expectedInOrder !== undefined &&
            (expectedCurrent?.testId !== current.id || expectedCurrent.versionId !== current.versionId)
          ) {
            refuseRun("not_admitted", "the suite changed after this run request was prepared; read it again and retry");
          }
          expectedIndex += 1;
          plannedTests.push({
            suiteId: suite.id,
            testId: current.id,
            testVersionId: current.versionId,
            modality: reached.modality as Modality,
          });

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
                eq(testPersona.testVersionId, current.versionId),
                gt(testPersona.position, personaPosition),
              ))
              .orderBy(asc(testPersona.position))
              .limit(SIMULATION_INSERT_BATCH);
            if (personaRows.length === 0) break;
            namedPersona = true;
            const pins = await resolvePersonaVersions(
              auth,
              tx,
              projectId,
              personaRows.map((one) => one.personaId),
            );
            await tx.insert(simulation).values(pins.map((pin, index) => ({
              id: newId("sim"),
              runId,
              organizationId: auth.organizationId,
              projectId,
              agentId: reached.agentId,
              connectionId: input.connectionId,
              personaId: pin.personaId,
              personaVersionId: pin.personaVersionId,
              testId: current.id,
              testVersionId: current.versionId,
              position: simulationCount + index + 1,
              modality: reached.modality,
              status: "queued" as const,
              createdAt: at,
            })));
            simulationCount += pins.length;
            personaPosition = personaRows.at(-1)?.position ?? personaPosition;
            if (personaRows.length < SIMULATION_INSERT_BATCH) break;
          }
          if (!namedPersona) throw new Error(`test version ${current.versionId} names no persona`);
        }
        if (currentTests.length < SIMULATION_INSERT_BATCH) break;
        const afterTestId = currentTests.at(-1)?.id;
        if (afterTestId === undefined) break;
        currentTests = await readTestPage(afterTestId);
      }
      if (expectedInOrder !== undefined && expectedIndex !== expectedInOrder.length) {
        refuseRun("not_admitted", "the suite changed after this run request was prepared; read it again and retry");
      }
      if (simulationCount !== expectedSimulationCount) {
        throw new Error(`test suite ${suite.id} changed while its run was being planned`);
      }
      const groups = planGroupsFor(graderCandidates, plannedTests);
      await writeGradingPlan(auth, tx, {
        runId,
        groups,
        capturedAt: at,
      });
      await tx.insert(idempotentOperation).values({
        organizationId: auth.organizationId,
        projectId,
        actorId: auth.userId,
        operation: "start_run",
        idempotencyKey,
        requestDigest: digestOfStart(input),
        resultId: runId,
      });
      return runFromRow(header, suite.name, false);
    });
  } catch (cause) {
    if (!lostToIdempotencyKey(cause)) throw cause;
    const winner = await originalRunFor(db(), auth, projectId, input);
    if (winner === undefined) throw cause;
    return winner;
  }
  return created;
}

export async function runAlreadyStartedFor(
  auth: AuthContext,
  input: NewRun,
): Promise<StartedRun | undefined> {
  // The API asks this before phone readiness so a lost successful response can
  // be replayed without consulting external state again. It is still a start
  // operation: a user whose role was reduced to viewer may neither start a new
  // run nor replay one they started while they had write access.
  authorize(auth, "start_and_cancel_runs", here(auth));
  if (auth.projectId === undefined || input.idempotencyKey.trim() === "") return undefined;
  return originalRunFor(db(), auth, auth.projectId, input);
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

export type SimulationExecutionEvidence = {
  readonly testVersion: TestExecutionContent;
  readonly mockToolSnapshot: MockToolSnapshot;
};

/**
 * The bounded frozen test and Mock Tool evidence for one Simulation.
 *
 * The Simulation already pins one persona. This read therefore never loads the
 * full persona list on its test version, even when hundreds of Simulations
 * share that version.
 */
export async function getSimulationExecutionEvidence(
  auth: AuthContext,
  simulationId: string,
): Promise<SimulationExecutionEvidence | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select({
      runId: run.id,
      testVersionId: simulation.testVersionId,
      snapshot: run.mockToolSnapshot,
    })
    .from(simulation)
    .innerJoin(run, eq(simulation.runId, run.id))
    .where(within(auth, simulation, and(
      eq(simulation.id, simulationId),
      inActingProject(auth, simulation),
    )))
    .limit(1);
  if (row === undefined) return undefined;
  const frozen = mockToolSnapshotFromRow(row.snapshot, row.runId);
  const version = await getTestVersionExecutionContent(auth, row.testVersionId);
  if (version === undefined) {
    throw new Error(`simulation ${simulationId} pins unreadable test version ${row.testVersionId}`);
  }
  return {
    testVersion: version,
    mockToolSnapshot: {
      defaults: frozen.defaults,
      overrides: { [row.testVersionId]: version.mockOverrides },
    },
  };
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
 * The cancel intent, honored where each simulation stands. Queued ones end
 * here and now — canceled before claim, never dispatched, never claimable.
 * Claimed and running ones get the intent stamped, and the simulator honors it
 * at its next heartbeat; the run's own status flips at once, and its counts
 * land when the last straggler does.
 *
 * Canceling a canceled run is nothing to do and answers with the run as it
 * stands; canceling a completed one is refused out loud, because a run that
 * finished has nothing left to cancel and the caller should know they missed.
 *
 * **The three counts settle honestly.** A cancel that catches every
 * conversation before it was claimed finishes the run here and now, with the
 * canceled count equal to what was queued and nothing pretending to have
 * passed. A cancel that catches conversations in flight leaves the counts
 * unwritten until the stragglers land, and the run says `canceled` in the
 * meantime — so stopping early never reads as a suite that went green.
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
 * What a claim answers with, and no more — identifiers, tenancy, the two
 * stamps the claim itself wrote, and the pins a spec is assembled from.
 *
 * Deliberately not the `Simulation` shape: a claim crosses every customer on
 * the deployment, so what it carries out is held to what the assembly needs
 * to *ask for* — never the asked-for things themselves. No transcript, no
 * configuration, no credentials, nothing a customer wrote. Each of those is
 * read afterwards through the ordinary scoped surface, under `auth`.
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
  testId: simulation.testId,
  testVersionId: simulation.testVersionId,
  modality: simulation.modality,
  claimedBy: simulation.claimedBy,
  claimedAt: simulation.claimedAt,
} as const;

/**
 * The name the simulator's context wears where a person's id would be.
 *
 * The same shape as the grading queue's `engine`, for the same reason: the
 * simulator is a process, and the conversations it conducts were asked for by
 * whoever started the run rather than by it. Deliberately not shaped like an
 * identifier, so anything that ever tried to write it as one is refused out
 * loud by the foreign key to `user` rather than quietly attributing a
 * machine's act to a person.
 */
const THE_SIMULATOR = "simulator";

/**
 * The context one claimed simulation is conducted under.
 *
 * `member`, where the grading engine's is `viewer`, and the difference is the
 * work: the engine only reads and writes egma's own records, while conducting
 * moves the simulation row itself through the machinery this file gates with
 * `start_and_cancel_runs` — because claiming and reporting a simulation *is*
 * conducting the run somebody started. What keeps the context narrower than a
 * person holding the same role is not the role at all: every write requires
 * the claimant's own name on the row, and the one secret it can ask for sits
 * behind a door that checks how the context came to exist, not what its role
 * permits.
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
 * The atomic claim, across every organization on this deployment.
 *
 * Up to `capacity` of the oldest queued simulations move to `claimed` in one
 * transaction, stamped with the claimant and their first heartbeat; whatever
 * another claimant holds locked is skipped rather than waited on, so two
 * simulators drain one queue without ever taking the same conversation.
 * `SKIP LOCKED`, exactly as `claimGradingJobs` does it, because it is exactly
 * the same problem. The capacity is the simulator's own declaration of what
 * it can hold — a big run degrades to a queue, never to overload.
 *
 * Every claimed simulation's run leaves `pending` here, because a run has
 * started when its first conversation is someone's to conduct.
 *
 * **It takes no `AuthContext` and cannot be given one.** See the note at the
 * top of this file, and the grading queue's, whose reasoning this claim
 * inherits whole: it is the one call in this file that reaches across
 * customers; the only rows it moves are egma's own queue of simulations; it
 * takes a claimant's name and a capacity, and there is no argument by which a
 * caller could name whose work they want — a build rule holds it to that; it
 * carries out identifiers and no content; and every claim arrives with the
 * narrowed context the conducting is actually done under. There is no
 * tenancy-scoped claim beside it, deliberately — a claim a customer's
 * credential could make would be a claim that has to answer which customers
 * it serves, and the honest answer is all of them.
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
      .where(eq(simulation.status, "queued"))
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
 * Where one simulation stands, and the context its conducting continues
 * under — what the report, heartbeat and telemetry doors read before applying
 * anything a simulator says about a row.
 *
 * Lifecycle stamps and identifiers, and no content: enough to tell an
 * unknown simulation from a moved one, a duplicate from a conflict, and the
 * claimant whose word the row takes — and nothing a customer wrote. The pins
 * ride along for the row's arriving evidence: a span filed under the
 * simulation carries the run and the versions its conversation executed, and
 * they come off this same row rather than off anything the wire claimed.
 * What the work itself needs is read afterwards, through the scoped surface,
 * under the context answered here.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's own
 * discipline, one step later in the same lifecycle: the simulator holds no
 * credential, so its calls about a claimed row arrive with the service
 * token — which resolves to nobody — and the row itself is what names whose
 * conducting this is. The context comes back built from the row's own
 * tenancy and from nothing the caller said, exactly as the claim built it,
 * and it is the context every write about the row then goes through. The
 * one argument is the simulation's id — an identifier the claim itself
 * handed out — and there is no argument by which a caller could name a
 * customer.
 *
 * The row is answered in whatever state it stands, terminal and swept
 * included, and each door decides what that standing permits: the lifecycle
 * doors refuse a claim about a row beyond help, while the telemetry door
 * keeps a late-returning orphan's spans after its terminal lifecycle state.
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
    claimedBy: row.claimedBy,
    cancelRequestedAt: row.cancelRequestedAt,
    auth: conductingContext(row.organizationId, row.projectId),
  };
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
 * The one door to a connection's plaintext on the dispatch path, and **egma's
 * own simulator is the only thing that may knock.**
 *
 * The gate is narrower than a role: the only thing egma ever does with a
 * connection's credentials at this seam is conduct a simulation over them,
 * and the only thing that conducts is the simulator. So the check is on how
 * the caller came to exist rather than on what their role permits — a context
 * built from a claim says `simulator` on its face, and every other context in
 * the product, a person's session and an API key and the grading engine
 * alike, is refused out loud.
 *
 * It is asked with a simulation, never with a connection, and that is the
 * second half of the door: the row names the connection it was pinned to when
 * the run started, so there is no argument by which a caller could point the
 * unsealing at a connection the claimed row does not name. And it answers
 * only while the row stands `claimed` — the one moment a spec is assembled.
 * Before the claim there is nobody to hand a secret to, and after the
 * conversation starts nothing asks again.
 *
 * `undefined` answers three absences alike — a simulation out of the
 * context's tenancy, one not standing claimed, and a connection since deleted
 * — because telling them apart at this seam would confirm rows the context
 * cannot see. A caller who needs the difference is holding the claim, which
 * already says what was claimed; a connection gone mid-flight is the one case
 * left, and it is exactly the "could not be handed over" the dispatch path
 * answers for out loud.
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
 * Still alive, still holding this conversation — and the answer carries the
 * one directive that travels back on a heartbeat: whether cancellation has
 * been requested. `undefined` is a heartbeat with nothing under it: an id
 * this egma never issued, another claimant's row, or one no longer moving —
 * the signal to stop, not to retry.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's exact
 * terms (see the note at the top of this file): the beat comes from egma's
 * own simulator, which stands behind every organization at once and holds no
 * credential to build a context from. What keeps it narrow is the guarded
 * update itself — the only row it can touch is one the caller's own name is
 * already stamped on, in a state only egma's claim machinery writes — and the
 * answer is a single boolean egma itself stamped. Nothing a customer authored
 * goes in or comes out.
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
 * How every simulation lands: one guarded update — this claimant's row, in a
 * state the landing may leave, within the caller's reach — writing the
 * terminal facts, and the run finalized in the same transaction when the
 * landing was its last. The three landings below differ only in what they
 * write and what they require, so that is all they say; `undefined` still
 * means there was nothing here to move.
 *
 * The events go in beside them: the conversation landing, and then the run
 * itself when this landing was the one that finished it.
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
        // Evidence may have drained before this lifecycle transition. Probe the
        // bounded trace window, then request work inside this same Postgres
        // transaction. A crash cannot commit "completed" without also
        // committing the queue row when evidence was already visible.
        const evidenceStartedAt = await traceEvidenceStartedAt(auth, {
          source: "simulation",
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
        });
        await requestGradingIn(tx, auth, {
          source: "simulation",
          traceId,
          traceStartedAt: evidenceStartedAt ?? row.startedAt,
          runId: row.runId,
          endsTrace: true,
          modality: row.modality as Modality,
          evidenceReady: evidenceStartedAt !== undefined,
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
      failureDetail: failure.detail,
      ...summaryFactsWrite(failure),
    },
  });
}

/**
 * The claim path's own landing, for a claimed simulation the platform could
 * not hand over: `claimed → failed` with the one reason no simulator can
 * report, `dispatch_failed`. Written at claim time, the moment spec assembly
 * fails — never left for the sweep to misname `orphaned` (the simulator did
 * not stop answering; it was never handed anything to answer for), and never
 * re-queued to fail the same way again — and through the same terminal
 * machinery as every landing, so a run waiting only on a broken row settles
 * with truthful counts. No grading job is created because no completed trace
 * exists.
 *
 * Only a context minted by a claim may write it, on the terms
 * `resolveSimulationConnection` drew: the check is on how the caller came to
 * exist, not on what its role permits. Dispatch failure is a fact about the
 * moment between claiming and handing over, and the claim path is the only
 * thing that stands there — a person's session or key, and the grading
 * engine, would be recording the platform's confession to an act that was
 * never theirs.
 *
 * From `claimed` alone, by the claimant alone: once the conversation is
 * underway, dispatch already succeeded, and whatever fails afterwards is the
 * simulator's to report.
 */
export async function failSimulationDispatch(
  auth: AuthContext,
  id: string,
  claimant: string,
): Promise<Simulation | undefined> {
  authorize(auth, "start_and_cancel_runs", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "dispatch_failed is the platform's own confession that it could not hand a claimed simulation over, and only the claim path — conducting as the simulator — stands where that happens",
    );
  }

  return landSimulation(auth, id, claimant, {
    from: ["claimed"],
    write: { status: "failed", endingReason: "dispatch_failed" },
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
 * The simulator honors the cancel it was told about: `claimed` or `running`
 * to `canceled`, by the claimant, and only where the intent was actually
 * recorded — a simulator abandoning a conversation nobody canceled is a
 * failure, not a cancellation, and is refused by the same guarded update
 * that checks everything else.
 *
 * A canceled conversation still landed somewhere, so the landing takes the
 * summary facts the report carried — what had been reached by the time the
 * directive was honored. Never an ending reason: the cancel intent is its
 * own record, and the row's shape holds it to that.
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
 * The orphan sweep: every claimed or running simulation whose simulator has
 * been silent past the staleness window is marked `failed` with reason
 * `orphaned` — an honest "started, never finished" instead of a row stuck
 * running forever — and any run that was waiting only on orphans is
 * finalized. Returns what it swept, so the caller can say what it did.
 *
 * **It takes no `AuthContext` and cannot be given one**, on the claim's exact
 * terms (see the note at the top of this file): silence is noticed by egma
 * standing behind every organization at once, because the simulator whose
 * silence this is stood there too. The only rows it moves are ones egma's own
 * claim machinery stamped, and the answer is identifiers and no content.
 * Orphaned simulations have no completed trace and create no grading work.
 *
 * **Racing sweeps collide harmlessly**, which is what makes it safe to run on
 * an interval in every replica with nothing elected to go first. The guarded
 * update is the whole arbiter: of two sweeps reaching one row, whichever
 * arrives second re-reads it after the first commits, finds it no longer
 * `claimed` or `running`, and leaves it alone — so a row is ended once and its
 * run is finalized once. And the after-work
 * walks rows and runs in id order, so two sweeps over one set cannot
 * deadlock over the order they took things in.
 *
 * The staleness window is measured in whole seconds against the last
 * heartbeat. The default is `DEFAULT_STALE_AFTER_SECONDS`, set where it is so
 * a partition cannot out-wait a report that is still coming; the sweep's one
 * sin would be calling a simulator dead that isn't.
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
      .set({ status: "failed", endingReason: "orphaned", endedAt: now })
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
};

/** A bounded page of changes, where to ask from next, and whether there will be more. */
export type RunEventPage = {
  readonly events: readonly RunEvent[];
  /** Hand back as `after` to continue; the same number again on an empty page. */
  readonly next: number;
  /** True once the run has finished, and only then. */
  readonly done: boolean;
};

/**
 * Everything that has changed about a run since a point, in the order it
 * happened.
 *
 * **The split that makes crash-resume real.** This side is stateless: it
 * remembers nothing about who has read what, and asking twice for the same
 * `after` answers the same page twice. The client's half is to apply each
 * sequence number at most once. Between them, a follower that dies mid-page
 * and restarts from the last number it applied misses nothing and repeats
 * nothing — and neither end has to trust the other to have been alive.
 *
 * **The header is read before the events, and the order is load-bearing.** If
 * `done` were read second, a run that finished between the two reads would be
 * reported finished by a page that did not yet hold its last events, and a
 * follower that stopped there would never learn how the run ended. Read this
 * way round, the worst case is a `done` that is one poll stale, which costs a
 * poll and loses nothing.
 *
 * One fixed-size page is answered. A run has no simulation limit, so an event
 * reader must never materialize the whole remaining tail. The extra row read
 * below proves whether this page has a later event without exposing it early.
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
  }));

  return {
    events,
    next: events.at(-1)?.seq ?? after,
    done: header.finishedAt !== null && !hasLater,
  };
}

/**
 * Stop every piece of work that would have gone over these connections.
 *
 * **Archiving how egma reaches an agent is not an edit to a list; it is a
 * decision about work in flight.** A queued simulation over an archived
 * connection would sit in the claim queue for a target the simulator can no
 * longer resolve a credential for, and would eventually fail — putting an
 * operational failure on the record dressed as something the agent did. So the
 * queue is settled in the same transaction as the Archive.
 *
 * Where each simulation stands decides what happens to it, and the two answers
 * are the ones `cancelRun` already gives for the same three states:
 *
 * - **queued** ends here and now. Nothing dispatched it, so nothing has to
 *   agree to stop.
 * - **claimed or running** gets the intent stamped and honors it at its next
 *   heartbeat. Egma does not reach into a conversation already happening, and
 *   whatever it produced before it stops stays on the record — evidence is
 *   never erased to make a state tidy.
 *
 * Every run left holding one of those and not already terminal is set
 * `canceled` in the same operation, with its run event written, so a run
 * cannot later report itself `completed` over a target that was taken away
 * mid-flight. Counts settle exactly as a cancel's do: at once where everything
 * was queued, and when the stragglers land where they were not.
 *
 * It takes a transaction rather than opening one, because the whole point is
 * that it happens with the Archive and not beside it.
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
