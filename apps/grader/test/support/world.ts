import { newId } from "@egma/ids";
import {
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
  setJudgeConfiguration,
  startRun,
  startSimulation,
  type AuthContext,
  type ExpectedBehaviorInput,
  type FailedEndingReason,
  type NewGrader,
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
