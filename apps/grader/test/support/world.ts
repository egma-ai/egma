import { newId } from "@egma/ids";
import {
  appendSpans,
  claimSimulations,
  completeSimulation,
  connect,
  connectClickHouse,
  createAgent,
  createPersona,
  createTest,
  disconnect,
  disconnectClickHouse,
  failSimulation,
  getGradingJobForTrace,
  getSimulation,
  getTest,
  listGradingJobsForSimulation,
  readVerdicts,
  recordProductionTraces,
  PREDEFINED_GRADERS,
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  reportedMeasurementsPayload,
  seedGraderLibrary,
  seedRunningGraders,
  setJudgeConfiguration,
  startRun,
  startSimulation,
  useLibraryEntry,
  type AuthContext,
  type ExpectedBehavior,
  type GradingJob,
  type NewSpan,
  type ReportedMeasurement,
  type UseLibraryEntry,
  type RecordedVerdict,
  type Simulation,
  type SimulationFailure,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";

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
  /**
   * A version naming the world's persona and nothing else, so a conduct that
   * has no opinion about the test still has something for a run to execute.
   * A run pins frozen versions now, and there is no such thing as a run that
   * names none.
   */
  readonly bareTestVersionId: string;
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

  // egma's own graders, on the shelf before anything points at one — what a
  // real deployment writes in the same breath as applying its migrations.
  await seedGraderLibrary();

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
    "insert into project (id, organization_id, name, slug, revision) values ($1, $2, 'default', 'default', $3)",
    [projectId, organizationId, newId("rev")],
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

  // The project's mandatory grading. On a real deployment this row is written
  // inside the transaction that creates the project; the tenancy here is raw
  // SQL, for the reason every data-access test's is, so the standing backfill
  // does the same job — which is also what these files are exercising when they
  // expect a conversation to be judged against its test's own behaviors.
  await seedRunningGraders();

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
    personality: "Speaks plainly.",
  });

  /**
   * A judge, because a run in this world cannot start without one.
   *
   * The world above seeds the project's expected-behaviors copy, which judges by
   * asking a model — so a run planned here in `needs_setup` is refused before
   * anything is conducted, and "a provisioned project" and "a project with a
   * judge" are the same thing for these files. A test about the *absence* of a
   * judge clears the row after its run exists, which is also the only way that
   * state can arise now: a project that deleted the copy needs no judge, and is
   * refused nothing.
   */
  await setJudgeConfiguration(
    { ...auth, role: "admin" },
    { provider: "openai", model: "gpt-4.1-mini", key: THE_JUDGE_KEY },
  );

  const bare = await createTest(auth, {
    name: "A conversation with nothing named about it",
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [persona.id],
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
    bareTestVersionId: bare.versionId,
    async drop() {
      await disconnect();
      await disconnectClickHouse();
      await database.drop();
      await store.drop();
    },
  };
}

/**
 * A grader on the project, judging everything the project runs — made the one
 * way a grader is ever made, by pressing Use on a library entry.
 */
export async function seedGrader(
  world: World,
  grader: UseLibraryEntry,
): Promise<string> {
  return (await useLibraryEntry(world.auth, grader)).id;
}

/**
 * The copy of `expected_behaviors` every project is given, found by the entry
 * it points at.
 *
 * Tests reach for it constantly — it is what judges a test against its own
 * expectations, and its identifier is what its verdict rows name — and it is
 * found rather than remembered, because the seeding is the thing under test in
 * half of them.
 */
export async function theSeededGrader(world: World): Promise<string> {
  const [row] = (
    await world.database.sql<{ id: string }>(
      "select id from grader where project_id = $1 and library_id = $2 and deleted_at is null",
      [world.projectId, PREDEFINED_GRADERS.expectedBehaviors],
    )
  ).rows;
  if (row === undefined) {
    throw new Error("this project has no expected-behaviors grader");
  }
  return row.id;
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

/**
 * A copy of the `latency` entry: a measure from the catalog and a bound, which
 * is the whole of what its form asks.
 *
 * **The bound is above what a conducted conversation measures**, so a case that
 * only wants a second grader on the project gets one that passes rather than one
 * that fails for reasons its own case never mentions. `A_CONVERSATION_HAPPENED`
 * measures 900 and 1100 milliseconds, and the worst of those is what a bound is
 * held against — a case that wants a failure lowers it and says so.
 *
 * It is the one entry v0 ships that egma computes rather than asks a model, so
 * it is also how these files put a second grader on a project without a second
 * scripted judge answer.
 */
export function aLatencyCopy(
  overrides: Partial<UseLibraryEntry> = {},
): UseLibraryEntry {
  return {
    libraryId: PREDEFINED_GRADERS.latency,
    params: { metric: "turn_response_latency", bound: 2_000 },
    ...overrides,
  };
}

/**
 * A second copy of the `expected_behaviors` entry: judged, and asking for
 * nothing at Use time.
 *
 * Allowed and pointless in the product — two copies of one entry judge the same
 * thing twice until filters arrive — and useful here, because it is the only way
 * to put a second *judged* grader on a project.
 */
export function aJudgedCopy(
  overrides: Partial<UseLibraryEntry> = {},
): UseLibraryEntry {
  return {
    libraryId: PREDEFINED_GRADERS.expectedBehaviors,
    name: "A second opinion on the behaviors",
    ...overrides,
  };
}

export type ConductedSimulation = {
  readonly runId: string;
  readonly simulationId: string;
  /** Where its spans are filed, for a test that wants to read them back. */
  readonly traceId: string;
};

/**
 * One conversation, conducted to a terminal transition — which is the moment
 * that makes it grading work.
 */
export async function conductSimulation(
  world: World,
  landing: {
    /**
     * The conversation as spans, streamed while it runs — before the terminal
     * transition, which is the order the simulator's one ordered sender puts
     * them in.
     *
     * Absent is a conversation that happened, in the default shape below.
     * `null` is the other thing a case can mean: a conversation that happened
     * and whose evidence never reached egma at all, which a reader has to be
     * able to tell from one that never happened.
     */
    readonly spans?: StreamedConversation | null | undefined;
    /**
     * Absent means it happened; a reason means it never ran. Typed as what a
     * simulator may report, because that is who this helper is playing.
     */
    readonly failedBecause?: SimulationFailure["reason"] | undefined;
    readonly testId?: string | undefined;
  } = {},
): Promise<ConductedSimulation> {
  const claimant = "simulator-1";
  const pinned =
    landing.testId === undefined
      ? world.bareTestVersionId
      : ((await getTest(world.auth, landing.testId))?.versionId ??
        world.bareTestVersionId);
  const started = await startRun(world.auth, {
    agentId: world.agentId,
    connectionId: world.connectionId,
    testVersionIds: [pinned],
  });
  const [only] = started.simulations;
  if (only === undefined) throw new Error("the run has no simulation");

  // A conduct that named no test wants a conversation with nothing to judge it
  // against — the row an instance upgraded across the pin's migration holds.
  // No verb writes one any more, because `startRun` names a version for every
  // conversation it creates, so it is written here by hand and before the
  // landing that makes this conversation grading work.
  if (landing.testId === undefined) {
    await world.database.sql(
      "update simulation set test_id = null, test_version_id = null where id = $1",
      [only.id],
    );
  }

  // The claim takes the oldest queued rows rather than this caller's, and it
  // skips whatever another claim holds locked — so two conducts running at once
  // can each come back having claimed nothing while the other's transaction is
  // still open. One claimant for all of them makes whoever won harmless; asking
  // again until this conversation is actually claimed is what makes the conduct
  // itself reliable. A real simulator has the same shape and does not care,
  // because it conducts whatever it claimed rather than one row it named.
  await eventually(`simulation ${only.id} to be claimed`, async () => {
    await claimSimulations({ claimant, capacity: 50 });
    const now = await getSimulation(world.auth, only.id);
    return now?.status === "claimed" ? now : undefined;
  });

  const conducting = await startSimulation(world.auth, only.id, claimant);
  if (conducting === undefined) {
    throw new Error(`simulation ${only.id} would not start`);
  }

  // Every span on the wire before the document that ends the conversation, which
  // is the whole point of the simulator's one ordered sender: when the control
  // plane lands a terminal transition, the evidence is already stored.
  //
  // A case that said nothing about the conversation gets one that happened,
  // because that is what a conducted simulation is now: there is no column
  // left for a conversation to sit in instead of the spans. `null` asks for
  // the opposite — nothing on the wire at all — and a conduct that failed
  // streams nothing unless it asked to, because nothing was conducted.
  const streaming =
    landing.spans === null
      ? undefined
      : (landing.spans ??
        (landing.failedBecause === undefined
          ? A_CONVERSATION_HAPPENED
          : undefined));
  if (streaming !== undefined) {
    await streamConversation(world, conducting, streaming);
  }

  // The landing carries the lifecycle and the summary facts, and nothing
  // about what was said: the conversation is whatever was streamed above,
  // and there is no column left for a second copy of it to land in.
  const landed =
    landing.failedBecause !== undefined
      ? await failSimulation(world.auth, only.id, claimant, {
          reason: landing.failedBecause,
        })
      : await completeSimulation(world.auth, only.id, claimant, {
          endingReason: "persona_concluded",
        });
  if (landed === undefined) {
    throw new Error(`simulation ${only.id} never reached a terminal transition`);
  }

  return {
    runId: started.id,
    simulationId: only.id,
    traceId: traceIdOfSimulation(only.id) ?? "",
  };
}

/* ------------------------------------------------------------------- *
 * A simulation's conversation, as the spans it actually arrives as.
 * ------------------------------------------------------------------- */

/**
 * The conversation a conduct streams when a case has no opinion about it: two
 * turns with something findable in them, and one measure to threshold. It is
 * the default rather than the empty conversation because most cases here are
 * about grading and not about evidence, and a simulation that streamed nothing
 * is a simulation with nothing to judge.
 */
const A_CONVERSATION_HAPPENED: StreamedConversation = {
  measured: { turn_response_latency: [900, 1_100] },
};

/**
 * What one conducted conversation streams, said in the terms the vocabulary
 * uses rather than in rows.
 */
export type StreamedConversation = {
  /**
   * Absent leaves the root span unsent — a trace egma holds part of, which is
   * what a simulator killed mid-conversation leaves behind.
   */
  readonly rootCloses?: boolean | undefined;
  readonly said?: readonly StreamedTurn[] | undefined;
  readonly calledTool?:
    | { readonly name: string; readonly arguments: string }
    | undefined;
  /**
   * What the simulator measured, in the milliseconds the catalog names — each
   * sample authored as its own timing span whose duration *is* the number.
   */
  readonly measured?: Readonly<Record<string, readonly number[]>> | undefined;
};

/**
 * One turn as it was spoken, which is two facts a transcript cannot carry.
 *
 * Both default to what a chat turn is — one instant, two seconds after the one
 * before it — and both are here because a voice turn is neither. A turn is open
 * for as long as it was spoken for, and two of them may **cross**: the persona
 * starting before the agent has finished is what barge-in looks like, and the
 * shape has to permit it rather than be widened for it later.
 */
export type StreamedTurn = {
  readonly speaker: "human" | "agent";
  readonly text: string;
  /** When it began, counted from the start of the conversation. */
  readonly atMilliseconds?: number | undefined;
  /** How long the audio ran, ear to ear. Zero on chat. */
  readonly spokeForMilliseconds?: number | undefined;
};

/**
 * One simulation's spans, filed exactly as the ingest door files them.
 *
 * That one call *is* the door for these purposes — the OTLP wire, the service
 * token and the resource attribute naming the simulation are the API's own
 * tests, and repeating them here would test Fastify rather than grading. What
 * matters on this side is that the rows land under the trace the simulation id
 * derives, stamped `simulation` and `egma-runtime`, carrying the run and the
 * agent the door resolves from egma's own row.
 *
 * **No queue row, deliberately.** A simulation's grading work is minted by the
 * transaction that lands it terminal, so a span arriving has nothing to add —
 * which is exactly the asymmetry with a production trace, whose spans are the
 * only thing that could ever have created its job.
 */
async function streamConversation(
  world: World,
  simulation: Simulation,
  streaming: StreamedConversation,
): Promise<void> {
  const traceId = traceIdOfSimulation(simulation.id);
  if (traceId === undefined) {
    throw new Error(`${simulation.id} names no trace`);
  }

  const began = Date.now();
  const rootSpanId = nextSpanId();
  const spans: NewSpan[] = [];

  const spanning = (over: Partial<NewSpan>): NewSpan =>
    simulationSpan(traceId, simulation, {
      spanId: nextSpanId(),
      parentSpanId: rootSpanId,
      startedAtMicroseconds: BigInt(began) * 1_000n,
      ...over,
    });

  const said = streaming.said ?? [
    { speaker: "human" as const, text: "Can you move my cleaning to Tuesday?" },
    { speaker: "agent" as const, text: "Booked for Tuesday at four." },
  ];

  said.forEach((turn, at) => {
    spans.push(
      spanning({
        // The speaker rides the span name, and the door reads the kind off it.
        name: turn.speaker === "human" ? "human_turn" : "agent_turn",
        kind: `turn:${turn.speaker}`,
        text: turn.text,
        startedAtMicroseconds:
          BigInt(began) * 1_000n +
          BigInt(turn.atMilliseconds ?? at * 2_000) * 1_000n,
        // One instant unless something measured how long it was spoken for,
        // which on chat nothing ever does.
        durationNanoseconds:
          BigInt(turn.spokeForMilliseconds ?? 0) * 1_000_000n,
      }),
    );
  });

  if (streaming.calledTool !== undefined) {
    spans.push(
      spanning({
        name: "tool_call",
        kind: "tool",
        toolName: streaming.calledTool.name,
        toolArguments: streaming.calledTool.arguments,
        // Always empty: the simulator observes the call and not the return, so
        // its vocabulary declares no result attribute at all.
        toolResult: "",
        startedAtMicroseconds: BigInt(began) * 1_000n + 1_000_000n,
        durationNanoseconds: 0n,
      }),
    );
  }

  let takenAt = 0n;
  for (const [measure, samples] of Object.entries(streaming.measured ?? {})) {
    for (const milliseconds of samples) {
      takenAt += 500_000n;
      spans.push(
        spanning({
          // A timing span is named for the measure it takes, and the door files
          // every one of the catalog's timing measures as `timing`.
          name: measure,
          kind: "timing",
          startedAtMicroseconds: BigInt(began) * 1_000n + takenAt,
          durationNanoseconds: BigInt(Math.round(milliseconds * 1_000_000)),
        }),
      );
    }
  }

  // While it is still happening: everything the walk observed, and nothing that
  // closes it.
  await appendSpans(world.auth, spans);

  if (streaming.rootCloses ?? true) {
    // And the flush that ends it, with the root alone — authored first, sent
    // last, which is what makes its arrival mean the conversation is over.
    await appendSpans(world.auth, [
      simulationSpan(traceId, simulation, {
        spanId: rootSpanId,
        parentSpanId: "",
        name: "simulation",
        kind: "root",
        startedAtMicroseconds: BigInt(began) * 1_000n,
        durationNanoseconds: 20_000_000_000n,
      }),
    ]);
  }
}

/** A simulation's span as the door writes one, with everything else empty. */
function simulationSpan(
  traceId: string,
  simulation: Simulation,
  over: Partial<NewSpan>,
): NewSpan {
  return {
    traceId,
    spanId: "",
    parentSpanId: "",
    // Explicit on the row rather than inferred from the run being set:
    // comparing a simulation against a production trace is the premise of the
    // product, so the two facts have to compose instead of sharing a slot.
    source: "simulation",
    emitter: "egma-runtime",
    environment: "default",
    startedAtMicroseconds: 0n,
    durationNanoseconds: 0n,
    name: "",
    kind: "other",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    // Empty, as the door writes it here: the type is read off the emitting
    // instrumentation's scope name, and only LiveKit's is one egma knows —
    // this world reaches its agent over a Retell chat connection.
    connectionType: "",
    // Resolved by the door from egma's own row, never from the payload.
    runId: simulation.runId,
    agentId: simulation.agentId,
    agentVersionId: "",
    testVersionId: simulation.testVersionId ?? "",
    personaVersionId: simulation.personaVersionId,
    payload: "{}",
    ...over,
  };
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

/**
 * One span id, never issued twice in a run of the suite — which is what the
 * store's own dedup is keyed on, so a repeat would land as nothing at all.
 */
function nextSpanId(): string {
  nextSpanOrdinal += 1;
  return wireId(nextSpanOrdinal, 8);
}

export async function conductProductionTrace(
  world: World,
  conducting: {
    /** Absent leaves the root span unsent, which is what the idle window is for. */
    readonly rootCloses?: boolean;
    readonly said?: readonly { speaker: "human" | "agent"; text: string }[];
    readonly calledTool?: string | undefined;
    /**
     * What this conversation measured, in the milliseconds the catalog names —
     * each sample its own timing span, whose duration *is* the number.
     *
     * **Written straight into the store, which is what makes this a fair
     * comparison and not a claim about the door.** The door files a span as
     * `timing` only for the `egma-simulator` scope, so a customer's agent
     * emitting a perfectly-named `turn_response_latency` span today lands it as
     * `other` and it is not a measurement — the reason a real production trace
     * carries no measures is the door's scope gate, not the frameworks. What is
     * being exercised here is everything *after* the door: given identical rows
     * from either source, egma computes identical numbers. Normalising a
     * provider's own timing attribute into this kind is the ingest door's
     * decision to take, and the day it does, these rows are what arrive.
     */
    readonly measured?: Readonly<Record<string, readonly number[]>> | undefined;
    /**
     * What the **agent platform** measured about this conversation, filed the
     * way a managed platform's normalizer files it: the neutral block on the
     * root span's payload, and placeholder turns beside it — every one opening
     * at the conversation's own start, lasting nothing, with no speech inside.
     *
     * **The two go together because on a real platform they always do.** Retell
     * publishes no per-turn timing, so `normaliseRetellCall` has no instant to
     * open a turn at except the one the conversation opened at, and no width to
     * give it — and the block exists precisely because there is nothing else to
     * measure from. A harness writing the block onto turns egma could read the
     * geometry of would be describing a conversation no platform produces: the
     * derivation would answer first and outrank the block, and this option
     * would quietly stop being about the source it names.
     *
     * The instants matter as much as the widths, and that is the sharp edge.
     * Zero-width turns at instants two seconds apart are **chat**-shaped —
     * really observed, and the derivation is right to measure the gaps between
     * them. Only turns that share the conversation's own start are the
     * placeholder signature the guard is allowed to read as "never timed".
     */
    readonly reportedByPlatform?:
      | {
          readonly by: string;
          readonly measurements: readonly ReportedMeasurement[];
        }
      | undefined;
  } = {},
): Promise<ConductedTrace> {
  nextTraceOrdinal += 1;
  const traceId = wireId(nextTraceOrdinal, 16);
  const startedAt = new Date();
  const spanId = nextSpanId;

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

  const reportedByPlatform = conducting.reportedByPlatform;

  said.forEach((turn, at) => {
    const turnSpan = spanning({
      name: turn.speaker === "human" ? "user_turn" : "agent_turn",
      kind: `turn:${turn.speaker}`,
      text: turn.text,
      startedAtMicroseconds:
        BigInt(startedAt.getTime()) * 1_000n + BigInt(at) * 2_000_000n,
      // **The placeholder signature, exactly as `normaliseRetellCall` writes
      // it: every turn opens at the conversation's own start and lasts
      // nothing.** Not merely zero-width — zeroing the width while leaving the
      // turns two seconds apart makes a *chat*-shaped conversation, whose
      // instants were really observed and whose gaps the derivation is right to
      // measure. It would answer 2000 ms here, outrank the block, and this
      // option would silently stop being about the source it names. The two
      // facts travel together because on a real platform they always do:
      // Retell publishes no per-turn timing, so there is no instant to open a
      // turn at except the one the conversation opened at.
      ...(reportedByPlatform === undefined
        ? {}
        : {
            startedAtMicroseconds: BigInt(startedAt.getTime()) * 1_000n,
            durationNanoseconds: 0n,
          }),
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

  // The measurements, filed exactly as a simulation's are: one timing span per
  // sample, named for the measure, its duration the number. The only difference
  // from the simulator's is the row's `source`, which is the point.
  let takenAt = 0n;
  for (const [measure, samples] of Object.entries(conducting.measured ?? {})) {
    for (const milliseconds of samples) {
      takenAt += 500_000n;
      spans.push(
        spanning({
          name: measure,
          kind: "timing",
          startedAtMicroseconds:
            BigInt(startedAt.getTime()) * 1_000n + takenAt,
          durationNanoseconds: BigInt(Math.round(milliseconds * 1_000_000)),
        }),
      );
    }
  }

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
        // The block rides here, under the egma-owned corner of a payload that
        // is otherwise the vendor's own document — written through the
        // contract's own writer, so this harness cannot spell it differently
        // from the normalizer it stands in for.
        ...(reportedByPlatform === undefined
          ? {}
          : {
              payload: JSON.stringify({
                call_id: `platform-${traceId.slice(-6)}`,
                egma_normalised: {
                  degraded: false,
                  [REPORTED_MEASUREMENTS_PAYLOAD_KEY]:
                    reportedMeasurementsPayload(
                      reportedByPlatform.by,
                      reportedByPlatform.measurements,
                    ),
                },
              }),
            }),
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
  await exportFlush(world, [
    productionSpan(traceId, {
      spanId: nextSpanId(),
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
 * A test with expected behaviors, and nothing else that decides how it is
 * judged.
 *
 * **It names no graders, because a test cannot.** Which copies judge a
 * simulation is the project's business — every active copy whose scope covers
 * simulations — so a case that wants a second grader on this conversation makes
 * one with `seedGrader` rather than attaching one here.
 *
 * The behaviors are the caller's when it has an opinion, because the
 * expected-behaviors grader judges exactly this list and most of what is worth
 * asserting about it is a question of how many there are and what order they are
 * in.
 */
export async function seedTest(
  world: World,
  expectedBehaviors: readonly ExpectedBehavior[] = [
    "confirms the new time back before finishing",
  ],
): Promise<string> {
  const test = await createTest(world.auth, {
    name: `Reschedules a booked appointment ${newId("tst").slice(-8)}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: [...expectedBehaviors],
    personaIds: [world.personaId],
  });
  return test.id;
}

/**
 * A conversation with enough turns in it for a judgment to cite one, streamed
 * as the spans a conversation now is. The measure rides with it because a
 * judge is shown the measures beside the transcript, and a case about what a
 * judge was shown wants both.
 */
export function aConversation(): StreamedConversation {
  return {
    said: [
      { speaker: "agent", text: "Thanks for calling Lakeside Dental." },
      { speaker: "human", text: "I need to move my cleaning to Thursday." },
      { speaker: "agent", text: "Thursday at four works. Shall I move it?" },
      { speaker: "human", text: "Yes please." },
      { speaker: "agent", text: "Booked for Thursday at four. Anything else?" },
    ],
    measured: { turn_response_latency: [900, 1_100] },
  };
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
    (level: string): Log["info"] =>
      ((fields: Record<string, unknown>, body?: string): void => {
        lines.push(JSON.stringify({ level, msg: body, ...fields }));
      }) as Log["info"];

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
