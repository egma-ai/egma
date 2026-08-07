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
  getGradingJobForTrace,
  getSimulation,
  listGradingJobsForSimulation,
  readVerdicts,
  recordProductionTraces,
  setJudgeConfiguration,
  startRun,
  startSimulation,
  type AuthContext,
  type ExpectedBehaviorInput,
  type FailedEndingReason,
  type GradingJob,
  type NewGrader,
  type NewSpan,
  type RecordedVerdict,
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
import type { JudgeMakers } from "../../src/judge/index.ts";
import { makeLog, type Log } from "../../src/log.ts";
import { startService, type Service } from "../../src/service.ts";
import { scriptedJudge, type Scripted, type ScriptedJudge } from "./scripted-judge.ts";

/**
 * A whole deployment, small enough to reason about: two stores of its own, one
 * customer with an agent and a persona, and whatever graders a test wants.
 *
 * Both stores are real, because everything worth asserting here is one of their
 * behaviours — the notification a transaction raises, the lock that keeps two
 * copies off one conversation, the replace semantics of a re-grade. A substitute
 * would confirm the calls egma makes and nothing about what they do.
 *
 * Beside the world, what every file in this suite waits on: the verdicts of one
 * conversation, the job behind it, and one running copy of the service. They are
 * here rather than in each file because they are all the same shape of mistake —
 * asserting before the engine has got there, or after another copy has — and a
 * hand-written copy of the wait is where that mistake gets made.
 */

export type World = {
  readonly database: MigratedDatabase;
  readonly store: MigratedTraceStore;
  readonly auth: AuthContext;
  /** The same person at the role that may set a project's judge. */
  readonly adminAuth: AuthContext;
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

  // The master key, held for the whole world: seeding an agent seals a
  // connection's credentials, and setting a project's judge seals its key. The
  // grading service opens exactly one of those two — a judge key resolves only
  // for a context built from a grading claim, and a connection's credentials
  // sit behind a permission the engine's context does not carry.
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
    adminAuth: { ...auth, role: "admin" },
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

/**
 * The one judge key every test in this suite configures, and it is written here
 * rather than inline so a test can assert it never appears anywhere else.
 *
 * Distinctive on purpose: a substring nothing else in the codebase, the
 * fixtures or the store could produce, so "the key is not in this log" is an
 * assertion about the key rather than about luck.
 */
export const THE_JUDGE_KEY = "sk-egma-test-judge-NEVERLEAKME-9Z8Y7X";

/**
 * The project's default judge. No judge speaks over the wire in these tests —
 * the scripted judge stands in at the provider seam — but everything up to that
 * seam is the real path: the key is sealed on the way in, resolved through the
 * one door on the way out, and never seen by anything in between.
 */
export async function seedJudge(
  world: World,
  judge: { readonly model?: string; readonly key?: string } = {},
): Promise<void> {
  await setJudgeConfiguration(world.adminAuth, {
    provider: "openai",
    model: judge.model ?? "gpt-4.1-mini",
    key: judge.key ?? THE_JUDGE_KEY,
  });
}

/** A latency threshold: the deterministic type, parameterized. */
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

/**
 * The criteria a team wrote in their own words, which is the one authored type
 * that asks a model anything — and the only one that carries a judge model of
 * its own.
 */
export const A_RUBRIC = "The agent acknowledged the caller's frustration.";

export function aRubric(overrides: Partial<NewGrader> = {}): NewGrader {
  return {
    name: "Was the agent empathetic",
    type: "llm_rubric",
    config: { rubric: A_RUBRIC },
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

/**
 * A test with expected behaviors, and the graders its array names.
 *
 * The behaviors are the caller's when it has an opinion, because the built-in
 * grader judges exactly this list and most of what is worth asserting about it
 * is a question of how many there are and what priorities they carry.
 */
export async function seedTest(
  world: World,
  graderIds: readonly string[],
  expectedBehaviors: readonly ExpectedBehaviorInput[] = [
    "confirms the new time back before finishing",
  ],
): Promise<string> {
  const test = await createTest(world.auth, {
    name: `Reschedules a booked appointment ${newId("tst").slice(-8)}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: [...expectedBehaviors],
    personaIds: [world.personaId],
    graderIds: [...graderIds],
  });
  return test.id;
}

/** A transcript with enough turns in it for a judgment to cite one. */
export function aConversation(): readonly unknown[] {
  return [
    { speaker: "agent", text: "Thanks for calling Lakeside Dental." },
    { speaker: "persona", text: "I need to move my cleaning to Thursday." },
    { speaker: "agent", text: "Thursday at four works. Shall I move it?" },
    { speaker: "persona", text: "Yes please." },
    { speaker: "agent", text: "Booked for Thursday at four. Anything else?" },
  ];
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
    // The stores are already connected by `makeWorld`, which is also what held
    // the master key — the service under test never reads either of these.
    encryptionKey: undefined,
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

export type ServiceUnderTest = {
  /** How each judge provider is spoken to; absent means the real ones. */
  readonly makers?: JudgeMakers | undefined;
  /** Where the service's own log lines go, for a test that reads them. */
  readonly log?: Log | undefined;
};

export function runService(
  config: Config,
  options: ServiceUnderTest = {},
): Service {
  return startService({
    config,
    log: options.log ?? makeLog(config.logLevel, config.claimant),
    ...(options.makers === undefined ? {} : { makers: options.makers }),
  });
}

/**
 * One copy of the service at a time, for a file whose cases each judge with
 * their own scripted answers.
 *
 * **Stopping means stopped and waited out**, not asked to stop: a copy still
 * finishing its claim when the next case conducts a conversation would judge
 * that conversation with the previous case's answers, and the failure would land
 * in whichever case ran second. Held here rather than written out in every file
 * that needs it, because that is exactly the mistake a hand-written copy makes
 * once and then flakes forever.
 *
 * Starting stops whatever is running first, so "exactly one copy is ever
 * claiming" is a property of this object rather than of everybody remembering
 * the pair of calls.
 */
export type OneService = {
  /** Started, with whatever was running stopped and waited out first. */
  start(config?: Config, options?: ServiceUnderTest): Promise<Service>;
  /**
   * Started behind a judge that answers as scripted, and the scripted judge
   * handed back — which is the whole of what most cases want.
   */
  judgingWith(
    answers: Readonly<Record<string, Scripted>>,
    config?: Config,
  ): Promise<ScriptedJudge>;
  /** Stopped and waited out. Doing it with nothing running is not an error. */
  stop(): Promise<void>;
};

export function oneServiceAtATime(): OneService {
  let running: Service | undefined;

  const stop = async (): Promise<void> => {
    if (running === undefined) return;
    running.stop();
    await running.finished;
    running = undefined;
  };

  const start = async (
    config: Config = testConfig(),
    options: ServiceUnderTest = {},
  ): Promise<Service> => {
    await stop();
    running = runService(config, options);
    return running;
  };

  return {
    start,
    stop,
    async judgingWith(answers, config) {
      const judge = scriptedJudge({ answers });
      await start(config, { makers: judge.makers });
      return judge;
    },
  };
}

/**
 * The verdicts on one conversation, once there are at least this many.
 *
 * The conversation is a simulation or a production trace and this does not ask
 * which: a verdict is filed under the conversation it judges, and both sources
 * name theirs the same way.
 */
export async function verdictsOn(
  world: World,
  conversationId: string,
  atLeast = 1,
): Promise<readonly RecordedVerdict[]> {
  return eventually(`${atLeast} verdicts on ${conversationId}`, async () => {
    const read = await readVerdicts(world.auth, conversationId);
    return read.verdicts.length >= atLeast ? read.verdicts : undefined;
  });
}

/**
 * The one job behind a conversation, once it has reached a state worth
 * asserting on.
 *
 * Which read finds it is the one thing the two sources differ on — a simulation
 * has its run's jobs listed under it, a production trace is looked up by the id
 * it arrived with — so naming the conversation is naming which. Waiting for the
 * job to be `graded` is also how a case leaves the queue quiet behind it: a job
 * still claimable when the next case starts its own copy would be judged again,
 * by a judge scripted for something else.
 */
export async function jobFor(
  world: World,
  conversation:
    | { readonly simulationId: string }
    | { readonly traceId: string },
  settled: GradingJob["status"],
  withinMilliseconds?: number,
): Promise<GradingJob> {
  const named =
    "simulationId" in conversation
      ? conversation.simulationId
      : conversation.traceId;

  return eventually(
    `the job for ${named} to be ${settled}`,
    async () => {
      const job =
        "simulationId" in conversation
          ? (
              await listGradingJobsForSimulation(
                world.auth,
                conversation.simulationId,
              )
            )[0]
          : await getGradingJobForTrace(world.auth, conversation.traceId);
      return job?.status === settled ? job : undefined;
    },
    withinMilliseconds,
  );
}

/**
 * A log that keeps every line instead of printing it, so a test can assert what
 * the service said — and, more to the point, what it never said.
 */
export function capturedLog(): { readonly log: Log; readonly lines: string[] } {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      lines.push(JSON.stringify({ level, message, ...fields }));
    };

  return {
    lines,
    log: {
      debug: at("DEBUG"),
      info: at("INFO"),
      warn: at("WARN"),
      error: at("ERROR"),
    },
  };
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
