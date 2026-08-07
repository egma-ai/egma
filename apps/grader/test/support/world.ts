import { newId } from "@egma/ids";
import {
  appendSpans,
  claimSimulations,
  completeSimulation,
  connect,
  connectClickHouse,
  createAgent,
  createGrader,
  createPersona,
  createTest,
  disconnect,
  disconnectClickHouse,
  failSimulation,
  getSimulation,
  recordProductionTraces,
  startRun,
  startSimulation,
  type AuthContext,
  type FailedEndingReason,
  type NewGrader,
  type NewSpan,
} from "@egma/db";

import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
  type MigratedDatabase,
} from "../../../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../../../packages/db/test/support/clickhouse.ts";
import type { Config } from "../../src/config.ts";
import { makeLog } from "../../src/log.ts";
import { startService, type Service } from "../../src/service.ts";

/**
 * A whole deployment, small enough to reason about: two stores of its own, one
 * customer with an agent and a persona, and whatever graders a test wants.
 *
 * Both stores are real, because everything worth asserting here is one of their
 * behaviours — the notification a transaction raises, the lock that keeps two
 * copies off one conversation, the replace semantics of a re-grade. A substitute
 * would confirm the calls egma makes and nothing about what they do.
 */

export type World = {
  readonly database: MigratedDatabase;
  readonly store: MigratedTraceStore;
  readonly auth: AuthContext;
  readonly organizationId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  drop(): Promise<void>;
};

const ada = newId("usr");

export async function makeWorld(label: string): Promise<World> {
  const database = await createMigratedDatabase(label);
  const store = await createMigratedTraceStore(label);

  // The key is here only because seeding an agent seals a connection's
  // credentials. The deployed service is given none, deliberately — grading
  // never unseals a secret, so it is never handed the key that could.
  //
  // And a small pool on purpose: every file here owns two stores, the suite
  // runs files in parallel, and a generous default multiplied by the file count
  // is how a run ends up refused connections rather than merely short of them.
  connect({
    databaseUrl: database.url,
    encryptionKey: TEST_ENCRYPTION_KEY,
    maxConnections: 4,
  });
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 4 });

  const organizationId = newId("org");
  const projectId = newId("prj");

  // Tenancy by raw SQL, as every data-access test seeds it: provisioning has its
  // own tests, and seeding through it would be asking the module whether the
  // module worked.
  await database.sql("insert into organization (id, name, slug) values ($1, $2, $2)", [
    organizationId,
    organizationId.slice(-8),
  ]);
  await database.sql(
    "insert into project (id, organization_id, name, slug) values ($1, $2, 'default', 'default')",
    [projectId, organizationId],
  );
  await database.sql('insert into "user" (id, email) values ($1, $2)', [
    ada,
    `ada-${organizationId.slice(-6)}@acme.example`,
  ]);

  const auth: AuthContext = {
    userId: ada,
    organizationId,
    projectId,
    role: "member",
    via: "session",
  };

  const agent = await createAgent(auth, {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });

  const persona = await createPersona(auth, {
    name: "Impatient Rita",
    traits: {
      personality: "Speaks plainly.",
      language: "en-US",
      voice: {
        provider: "elevenlabs",
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        speed: 1,
      },
    },
  });

  return {
    database,
    store,
    auth,
    organizationId,
    projectId,
    agentId: agent.id,
    connectionId: agent.connection?.id ?? "",
    personaId: persona.id,
    async drop() {
      await disconnect();
      await disconnectClickHouse();
      await database.drop();
      await store.drop();
    },
  };
}

/** A grader on the project, judging everything the project runs. */
export async function seedGrader(
  world: World,
  grader: NewGrader,
): Promise<string> {
  return (await createGrader(world.auth, grader)).id;
}

/** A latency threshold, which is the one type the skeleton executes. */
export function aThreshold(
  overrides: Partial<NewGrader> = {},
): NewGrader {
  return {
    name: "Answers inside two seconds",
    type: "metric_threshold",
    config: {
      measure: "turn_response_latency",
      aggregation: "p90",
      comparator: "below",
      threshold: 2_000,
    },
    ...overrides,
  } as NewGrader;
}

export type ConductedSimulation = {
  readonly runId: string;
  readonly simulationId: string;
};

/**
 * One conversation, conducted to a terminal transition — which is the moment
 * that makes it grading work.
 */
export async function conductSimulation(
  world: World,
  landing: {
    readonly metrics?: unknown;
    readonly transcript?: unknown;
    /** Absent means it happened; a reason means it never ran. */
    readonly failedBecause?: FailedEndingReason | undefined;
    readonly testId?: string | undefined;
  } = {},
): Promise<ConductedSimulation> {
  const claimant = "simulator-1";
  const started = await startRun(world.auth, {
    agentId: world.agentId,
    connectionId: world.connectionId,
    personaIds: [world.personaId],
    ...(landing.testId === undefined ? {} : { testId: landing.testId }),
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");

  // The claim takes the oldest queued rows rather than this caller's, and it
  // skips whatever another claim holds locked — so two conducts running at once
  // can each come back having claimed nothing while the other's transaction is
  // still open. One claimant for all of them makes whoever won harmless; asking
  // again until this conversation is actually claimed is what makes the conduct
  // itself reliable. A real simulator has the same shape and does not care,
  // because it conducts whatever it claimed rather than one row it named.
  await eventually(`simulation ${only.id} to be claimed`, async () => {
    await claimSimulations(world.auth, { claimant, capacity: 50 });
    const now = await getSimulation(world.auth, only.id);
    return now?.status === "claimed" ? now : undefined;
  });

  const conducting = await startSimulation(world.auth, only.id, claimant);
  if (conducting === undefined) {
    throw new Error(`simulation ${only.id} would not start`);
  }

  const landed =
    landing.failedBecause !== undefined
      ? await failSimulation(world.auth, only.id, claimant, {
          reason: landing.failedBecause as Exclude<FailedEndingReason, "orphaned">,
        })
      : await completeSimulation(world.auth, only.id, claimant, {
          endingReason: "persona_concluded",
          transcript: landing.transcript ?? [
            { speaker: "agent", text: "Booked for Tuesday at four." },
          ],
          metrics: landing.metrics ?? { turn_response_latency: [900, 1_100] },
        });
  if (landed === undefined) {
    throw new Error(`simulation ${only.id} never reached a terminal transition`);
  }

  return { runId: started.id, simulationId: only.id };
}

/* ------------------------------------------------------------------- *
 * The other source: a real caller's conversation, as spans.
 * ------------------------------------------------------------------- */

/**
 * One production trace, filed exactly as the ingest door files one: each flush
 * of spans into the trace store, and the same spans to the grading queue.
 *
 * Those two calls in that order *are* the door — the HTTP, the protobuf and the
 * credential are the API's own tests, and repeating them here would test Fastify
 * rather than grading. What matters on this side is that a trace becomes work
 * the same way a simulation does, and that is the pair of calls below. Nothing
 * here tells the queue when the conversation ended: the queue reads that off the
 * spans, which is the one place it is read.
 *
 * **Two flushes, because that is what an exporter does.** The captured LiveKit
 * trace arrives in fourteen, and its root `agent_session` comes alone in the
 * last one — so the conversation's turns land while it is still going, and the
 * root lands when it is over. Sending it all at once would never exercise the
 * upsert that makes a trace one job however many times it is flushed.
 */
export type ConductedTrace = {
  readonly traceId: string;
  /** When its first span began — the far end of the window a reader needs. */
  readonly startedAt: Date;
};

let nextTraceOrdinal = 0;
let nextSpanOrdinal = 0;

function wireId(ordinal: number, bytes: 8 | 16): string {
  return ordinal.toString(16).padStart(bytes * 2, "0");
}

export async function conductProductionTrace(
  world: World,
  conducting: {
    /** Absent leaves the root span unsent, which is what the idle window is for. */
    readonly rootCloses?: boolean;
    readonly said?: readonly { speaker: "human" | "agent"; text: string }[];
    readonly calledTool?: string | undefined;
  } = {},
): Promise<ConductedTrace> {
  nextTraceOrdinal += 1;
  const traceId = wireId(nextTraceOrdinal, 16);
  const startedAt = new Date();
  const spanId = (): string => {
    nextSpanOrdinal += 1;
    return wireId(nextSpanOrdinal, 8);
  };

  const rootSpanId = spanId();
  const said = conducting.said ?? [
    { speaker: "human" as const, text: "Can you move my cleaning to Tuesday?" },
    { speaker: "agent" as const, text: "Booked for Tuesday at four." },
  ];

  const spans: NewSpan[] = [];
  const spanning = (over: Partial<NewSpan>): NewSpan =>
    productionSpan(traceId, {
      spanId: spanId(),
      parentSpanId: rootSpanId,
      startedAtMicroseconds: BigInt(startedAt.getTime()) * 1_000n,
      ...over,
    });

  said.forEach((turn, at) => {
    const turnSpan = spanning({
      name: turn.speaker === "human" ? "user_turn" : "agent_turn",
      kind: `turn:${turn.speaker}`,
      text: turn.text,
      startedAtMicroseconds:
        BigInt(startedAt.getTime()) * 1_000n + BigInt(at) * 2_000_000n,
    });
    spans.push(turnSpan);

    // The tool span hangs inside the agent's turn, where LiveKit puts it.
    if (conducting.calledTool !== undefined && turn.speaker === "agent") {
      spans.push(
        spanning({
          parentSpanId: turnSpan.spanId,
          name: "function_tool",
          kind: "tool",
          toolName: conducting.calledTool,
          toolArguments: '{"when": "Tuesday"}',
          toolResult: '"booked"',
          startedAtMicroseconds: turnSpan.startedAtMicroseconds + 100_000n,
        }),
      );
    }
  });

  // While the conversation is still happening: the turns, and nothing that
  // closes it.
  await exportFlush(world, spans);

  if (conducting.rootCloses ?? true) {
    // And the flush that ends it, alone, exactly as the capture's last one is.
    await exportFlush(world, [
      spanning({
        spanId: rootSpanId,
        parentSpanId: "",
        name: "agent_session",
        kind: "root",
        durationNanoseconds: 20_000_000_000n,
      }),
    ]);
  }

  return { traceId, startedAt };
}

/** One export, as the door handles one: the store, then the queue, same spans. */
async function exportFlush(world: World, spans: readonly NewSpan[]): Promise<void> {
  await appendSpans(world.auth, spans);
  await recordProductionTraces(world.auth, spans);
}

/**
 * One more flush of a conversation egma has already dealt with — a root span at
 * that, so it says as loudly as telemetry can that the conversation is over.
 */
export async function exportALateFlush(
  world: World,
  traceId: string,
): Promise<void> {
  nextSpanOrdinal += 1;
  await exportFlush(world, [
    productionSpan(traceId, {
      spanId: wireId(nextSpanOrdinal, 8),
      parentSpanId: "",
      name: "agent_session",
      kind: "root",
      startedAtMicroseconds: BigInt(Date.now()) * 1_000n,
    }),
  ]);
}

/** A span as the door writes one, with everything a test does not care about. */
function productionSpan(traceId: string, over: Partial<NewSpan>): NewSpan {
  return {
    traceId,
    spanId: "",
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    startedAtMicroseconds: 0n,
    durationNanoseconds: 1_000_000_000n,
    name: "user_turn",
    kind: "turn:human",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: `room-${traceId.slice(-6)}`,
    connectionType: "livekit",
    audioSampleRateHz: 0,
    audioEncoding: "",
    // Empty, as the door writes them: a trace arriving there was not started by
    // egma, so there is no run and no agent behind it.
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    ...over,
  };
}

/** A test with expected behaviors, and the graders its array names. */
export async function seedTest(
  world: World,
  graderIds: readonly string[],
): Promise<string> {
  const test = await createTest(world.auth, {
    name: "Reschedules a booked appointment",
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [world.personaId],
    graderIds: [...graderIds],
  });
  return test.id;
}

/**
 * The service, configured for a test: a backstop so far away that anything
 * graded promptly was graded because a notification woke it, and a lease short
 * enough that a killed copy's job is reclaimable inside a test's patience.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: "",
    clickhouseUrl: "",
    claimant: "grader-under-test",
    capacity: 4,
    heartbeatSeconds: 1,
    leaseSeconds: 3_600,
    sweepSeconds: 3_600,
    // An hour, so a production trace judged inside a test's patience was judged
    // because its root span closed. The idle fallback's own test sets it low.
    traceIdleSeconds: 3_600,
    logLevel: "ERROR",
    ...overrides,
  };
}

export function runService(config: Config): Service {
  return startService({ config, log: makeLog(config.logLevel, config.claimant) });
}

/** Waits for `answer` to stop being undefined, or gives up saying what it wanted. */
export async function eventually<T>(
  what: string,
  answer: () => Promise<T | undefined>,
  withinMilliseconds = 20_000,
): Promise<T> {
  const until = Date.now() + withinMilliseconds;
  for (;;) {
    const found = await answer();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
