import { newId } from "@egma/ids";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  createPersona,
  listProjectGraders,
  readTraceGrades,
  type AuthContext,
  type CurrentGrade,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rowsIn } from "../../../packages/db/test/support/clickhouse.ts";
import { makeLog } from "../../grader/src/log.ts";
import { startService, type Service } from "../../grader/src/service.ts";
import { scriptedJudge } from "../../grader/test/support/scripted-judge.ts";
import { REPORTS_PATH } from "../src/routes/reports.ts";
import { startInstance, type Instance } from "./support/instance.ts";
import {
  startObjectStorage,
  type ObjectStorage,
} from "./support/object-storage.ts";
import { NEUTRAL_TRAITS } from "./support/traces.ts";

/**
 * The whole wire, walked by the shipped simulator: a run started through the
 * real API, its simulation claimed from the real claim door, conducted by
 * the real Python service over a Retell-shaped counterpart on loopback,
 * streamed span by span into the real ClickHouse through the real OTLP
 * ingest, and reported back through the real report door — queued → claimed
 * → running → completed, with every lifecycle column read back and checked
 * for truth.
 *
 * Nothing here is a stand-in for egma's own halves: the API listens on a
 * real port, the database is a real Postgres, the trace store is a real
 * ClickHouse, and the simulator is the same process `docker compose up`
 * starts. The one fake is the platform on the far side of the conversation —
 * a local server speaking Retell's chat wire shape — because the agent under
 * test is the customer's, and a test that needed a real Retell account would
 * prove an account rather than the wire.
 *
 * **The ordering guarantee is proved here and nowhere better.** The
 * simulator puts its span batches and its lifecycle documents through one
 * write-ahead log and one ordered sender, so a terminal report leaves only
 * after every span before it landed. What that buys is read back the way a
 * grader will read it: the walk is watched while it runs, and the moment the
 * simulation row turns terminal the conversation is already queryable in
 * ClickHouse, root span included.
 *
 * **And it runs to a grade.** The real grader service claims the work the
 * terminal landing minted, reads the conversation back out of ClickHouse the
 * way it reads a production trace, and writes one normalized score with nested
 * assertion details that cite turns. This closes the walk on the only claim
 * that matters end to end: a team's check was answered from a conversation
 * that exists as spans and as nothing else — the row has no column left to
 * hold one, and this asserts that of the schema itself.
 *
 * The judge is scripted, and it is the one seam here that is not a real
 * deployment's. A criterion written in a team's own words is answered by a
 * model, and a walk that called one would need an account and a network and
 * would still not answer the same way twice. Everything around it is real,
 * including the persisted grade and its frozen project policy.
 *
 * The failed walk rides the same session: a second connection whose key the
 * counterpart refuses, landing `failed` with the honest reason. The canceled
 * walk is deliberately absent — the cancel directive travels on heartbeat
 * answers, and the heartbeat route ships separately — so cancellation is
 * proven at the report door's own seam instead (`reports-routes.test.ts`).
 */

const API_DIRECTORY = path.join(import.meta.dirname, "..");
const SIMULATOR_DIRECTORY = path.join(
  API_DIRECTORY,
  "../simulator",
);

/** The token the instance support configures on the API's side. */
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

/** The key the Retell-shaped counterpart accepts, and the one it refuses. */
const COUNTERPART_KEY = "retell-secret-A1B2C3D4WXYZ";
const REFUSED_KEY = "retell-secret-NOBODY0000000";

/**
 * Retell's dispatch preflight sees the target as a direct chat agent.
 *
 * The second exchange still proves an execution-time refusal: its credential
 * passes this read, then the conversation endpoint refuses it, as can happen
 * when a provider credential is revoked between preflight and dispatch.
 */
const RETELL_CHAT_PREFLIGHT: typeof fetch = async (input) => {
  const url = String(input);
  if (!url.includes("/v2/list-agents")) {
    throw new Error(`unexpected Retell preflight read: ${url}`);
  }
  return new Response(
    JSON.stringify({
      items: [
        {
          agent_id: "agent_under_walk",
          agent_name: "Front desk",
          channel: "chat",
        },
      ],
      has_more: false,
    }),
    { status: 200 },
  );
};

/**
 * The Retell plug gives one platform request 60 seconds. Node otherwise closes
 * an idle pooled socket after 5 seconds, so a worker paused under suite load
 * can wake up holding a stale connection before its next POST. Keep the test
 * counterpart alive beyond that request window, with longer room for headers.
 */
const COUNTERPART_KEEP_ALIVE_MILLISECONDS = 65_000;
const COUNTERPART_HEADERS_TIMEOUT_MILLISECONDS = 70_000;

type Gate = {
  readonly opened: Promise<void>;
  open(): void;
};

/** One test-owned pause point, opened once and safe to open again. */
function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Wait for a controlled test signal without leaving a timer behind. */
async function waitForSignal(
  signal: Promise<void>,
  within: number,
  message: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), within);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A Retell-shaped chat platform on loopback: the three endpoints the shipped
 * plug speaks — create-chat, create-chat-completion, end-chat — with
 * Retell's own field names, bearer-key auth, and a scripted agent behind
 * them. Strict where the platform is: a wrong key answers 401, which is the
 * failed walk's whole way in.
 */
class RetellCounterpart {
  private server: http.Server | undefined;
  private readonly replies = [
    "Of course — we have Tuesday and Wednesday afternoon free next week.",
    "Done: you are moved to Wednesday at half past two.",
  ];

  /** Reply cursor per chat, so two exchanges cannot eat each other's script. */
  private readonly delivered = new Map<string, number>();
  /**
   * Hold the first agent answer so the walk can inspect a stable, live
   * Simulation. Earlier evidence has flushed, but the conversation cannot
   * finish until the test opens the second gate.
   */
  private readonly firstCompletionArrived = gate();
  private readonly firstCompletionCanAnswer = gate();
  private hasHeldFirstCompletion = false;
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      let body = "";
      request.on("data", (piece: Buffer) => {
        body += piece.toString("utf8");
      });
      request.on("end", () => {
        this.answer(request, response, body);
      });
    });
    this.server.keepAliveTimeout = COUNTERPART_KEEP_ALIVE_MILLISECONDS;
    this.server.headersTimeout = COUNTERPART_HEADERS_TIMEOUT_MILLISECONDS;
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the counterpart has no port");
    }
    this.port = address.port;
  }

  private answer(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: string,
  ): void {
    const send = (status: number, document: Record<string, unknown>): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(document));
    };

    if (request.headers.authorization !== `Bearer ${COUNTERPART_KEY}`) {
      send(401, { error: "invalid api key" });
      return;
    }

    const url = request.url ?? "";
    if (request.method === "POST" && url === "/create-chat") {
      const chatId = `chat_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      this.delivered.set(chatId, 0);
      send(201, {
        chat_id: chatId,
        message_with_tool_calls: [
          { role: "agent", content: "Lakeside Dental, how can I help?" },
        ],
      });
      return;
    }
    if (request.method === "POST" && url === "/create-chat-completion") {
      const { chat_id: chatId } = JSON.parse(body) as { chat_id?: string };
      const turn = chatId === undefined ? undefined : this.delivered.get(chatId);
      if (chatId === undefined || turn === undefined) {
        send(422, { error: "no such chat" });
        return;
      }
      const reply = this.replies[turn];
      if (reply === undefined) {
        send(422, { error: "the script ran dry" });
        return;
      }
      const answer = (): void => {
        this.delivered.set(chatId, turn + 1);
        send(200, { messages: [{ role: "agent", content: reply }] });
      };
      if (turn === 0 && !this.hasHeldFirstCompletion) {
        this.hasHeldFirstCompletion = true;
        this.firstCompletionArrived.open();
        void this.firstCompletionCanAnswer.opened.then(answer);
        return;
      }
      answer();
      return;
    }
    if (request.method === "PATCH" && url.startsWith("/end-chat/")) {
      send(200, {});
      return;
    }
    send(404, { error: `nothing at ${url}` });
  }

  /** Wait until the live conversation is held before its first agent answer. */
  async waitForHeldCompletion(within: number): Promise<void> {
    await waitForSignal(
      this.firstCompletionArrived.opened,
      within,
      `the counterpart received no completion within ${within}ms`,
    );
  }

  /** Let the held agent answer return and the Simulation continue. */
  releaseHeldCompletion(): void {
    this.firstCompletionCanAnswer.open();
  }

  async stop(): Promise<void> {
    this.releaseHeldCompletion();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}

describe("the Retell-shaped counterpart", () => {
  it("keeps an idle connection beyond the simulator's Retell request window", async () => {
    const server = new RetellCounterpart();
    await server.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/create-chat`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${COUNTERPART_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ agent_id: "agent_under_walk" }),
        },
      );
      await response.body?.cancel();

      // The simulator allows one Retell request 60 seconds. The counterpart
      // must keep a pooled socket alive longer than that, including when this
      // worker pauses under load between two non-idempotent POST requests.
      expect(response.headers.get("keep-alive")).toBe("timeout=65");
    } finally {
      await server.stop();
    }
  });
});

/** What the team wrote down, in their own words, for the judge to answer. */
const THE_BEHAVIOR = "confirms the new time back before finishing";

/**
 * A phrase the counterpart says back, and the turn the judge is scripted to
 * cite. It is not a grader of its own any more — there is one grader on this
 * project and it is the copy of `expectedBehaviors` every project is created
 * with — so what it proves now is where the cited turn came from: the judge was
 * shown a transcript egma assembled out of the spans the simulator streamed,
 * and the turn it pointed at is the turn holding these words.
 */
const THE_PHRASE = "Wednesday afternoon";

/**
 * The walk needs somewhere for evidence to become durable, because the whole of
 * what it watches runs through the real door: the simulator's span batches are
 * answered on object-store durability, and its terminal report is sent behind
 * them in order. An instance with no ingestion bucket answers those batches the
 * way an unconfigured deployment does — retryably — and the simulation never
 * reaches the report that ends it.
 */
const storage: ObjectStorage = await startObjectStorage("simulator-walk");

if (!storage.available) {
  process.stderr.write(
    `\nskipping the shipped-simulator walk — ${storage.why}\n\n`,
  );
}

let instance: Instance;
let counterpart: RetellCounterpart;
let simulator: ChildProcess | undefined;
let grader: Service | undefined;
let simulatorSaid = "";
let scratch: string;
let terminalReportSimulationId: string | undefined;
const terminalReportArrived = gate();
const terminalReportCanLand = gate();

/** One request against the instance as a person's terminal makes one. */
async function call(
  method: string,
  route: string,
  options: { key?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; setCookie: string }> {
  const response = await fetch(`${instance.origin}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.key === undefined
        ? {}
        : { authorization: `Bearer ${options.key}` }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>,
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

/**
 * Sign up over the wire and come back holding a project-scoped key — plus
 * the tenancy the persona seam needs, because no persona route ships yet
 * and the caller authors one at the db seam this process shares.
 */
async function signedUpKey(): Promise<{
  key: string;
  userId: string;
  organizationId: string;
  projectId: string;
}> {
  const signedUp = await call("POST", "/api/signup", {
    body: {
      email: "ada@acme.example",
      password: "a-password-long-enough-1",
      organizationName: "Acme",
    },
  });
  expect(signedUp.status, JSON.stringify(signedUp.body)).toBe(201);
  const cookie = signedUp.setCookie.split(";", 1)[0] ?? "";
  const landed = signedUp.body as unknown as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };

  const minted = await call("POST", "/v1/keys", {
    cookie,
    body: { name: "walking", projectId: landed.project.id },
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return {
    key: String(minted.body.secret),
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
  };
}

/** What the row itself says, read raw — the truth the walk must land. */
async function rowOf(simulationId: string): Promise<Record<string, unknown>> {
  const { rows } = await instance.database.sql(
    `select status, ending_reason, claimed_by, started_at, ended_at,
            turn_count, provider_reference,
            cancel_requested_at
       from simulation where id = $1`,
    [simulationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no row for ${simulationId}`);
  return row;
}

/**
 * The trace a simulation's spans belong to, derived here independently of
 * both the emitter and the ingest: the simulation id's own 128 bits, the 26
 * Crockford base32 characters after `sim_` written as 32 lowercase hex. A
 * derivation this test computed for itself is what makes finding the rows
 * proof of anything — asking either side where it filed them would not be.
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function traceIdOf(simulationId: string): string {
  let value = 0n;
  for (const character of simulationId.slice("sim_".length)) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    expect(digit, `${simulationId} is not Crockford base32`).toBeGreaterThan(-1);
    value = (value << 5n) | BigInt(digit);
  }
  return value.toString(16).padStart(32, "0");
}

type StoredSpan = {
  readonly name: string;
  readonly kind: string;
  readonly text: string;
  readonly duration_ns: string;
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly source: string;
  readonly emitter: string;
  readonly run_id: string;
  readonly agent_id: string;
};

/** One conversation as it stands in the trace store, oldest span first. */
async function storedSpans(traceId: string): Promise<StoredSpan[]> {
  return rowsIn<StoredSpan>(
    instance.traceStore,
    `select name, kind, text, toString(duration_ns) as duration_ns, span_id,
            parent_span_id, source, emitter, run_id, agent_id
       from spans
      where trace_id = '${traceId}'
      order by started_at, span_id`,
  );
}

/**
 * The Expected behaviors project grader every project is created with.
 */
async function theProjectsGrader(
  auth: AuthContext,
): Promise<{
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
}> {
  const [only] = await listProjectGraders(auth);
  if (only === undefined) throw new Error("the project has no graders");
  return {
    id: only.id,
    definitionId: only.graderDefinitionId,
    definitionVersion: only.currentDefinitionVersion,
  };
}

/** The current grades on one trace, once the grader has written them. */
async function gradesOn(
  auth: AuthContext,
  simulationId: string,
  runId: string,
  atLeast: number,
  within: number,
): Promise<readonly CurrentGrade[]> {
  const deadline = Date.now() + within;
  for (;;) {
    const { current } = await readTraceGrades(auth, {
      source: "simulation",
      traceId: traceIdOf(simulationId),
      runId,
    });
    if (current.length >= atLeast) return current;
    if (Date.now() > deadline) {
      throw new Error(
        `${simulationId} has ${current.length} grade(s) after ${within}ms, ` +
          `wanted ${atLeast}`,
      );
    }
    await new Promise((resume) => setTimeout(resume, 100));
  }
}

async function gradingJobsFor(simulationId: string): Promise<number> {
  const { rows } = await instance.database.sql<{ count: string }>(
    "select count(*) as count from grading_job where simulation_id = $1",
    [simulationId],
  );
  return Number(rows[0]?.count);
}

/** Wait until a durable grade has been followed by temporary queue cleanup. */
async function waitForGradingCleanup(
  simulationId: string,
  within: number,
): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    const jobs = await gradingJobsFor(simulationId);
    if (jobs === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${simulationId} still has ${jobs} grading job(s) after ${within}ms`,
      );
    }
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

/**
 * Read evidence while the counterpart holds the conversation open. This is
 * an eventual-delivery wait, not a race to catch a short-lived state: the
 * held Retell answer prevents the Simulation from becoming terminal.
 */
async function runningEvidence(
  simulationId: string,
  traceId: string,
  within: number,
): Promise<readonly string[]> {
  const deadline = Date.now() + within;
  for (;;) {
    const spans = (await storedSpans(traceId)).map((span) => span.name);
    const status = String((await rowOf(simulationId)).status);
    if (status === "running" && spans.length > 0) return spans;
    if (status === "completed" || status === "failed" || status === "canceled") {
      throw new Error(
        `simulation ${simulationId} became ${status} while its agent answer was held`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `simulation ${simulationId} has no readable running evidence after ${within}ms; ` +
          `last read: ${JSON.stringify({ status, spans })}; ` +
          `the simulator said:\n${simulatorSaid}`,
      );
    }
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

/**
 * Wait for one Simulation to reach a terminal state. The cross-store ordering
 * is proved separately while the terminal report is held at the API route.
 */
async function waitForTerminal(
  simulationId: string,
  within: number,
): Promise<string> {
  const deadline = Date.now() + within;
  for (;;) {
    const status = String((await rowOf(simulationId)).status);
    if (status === "completed" || status === "failed" || status === "canceled") {
      return status;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `simulation ${simulationId} is still ${status} after ${within}ms; ` +
          `the simulator said:\n${simulatorSaid}`,
      );
    }
    await new Promise((resume) => setTimeout(resume, 25));
  }
}

/** Poll one run until it reaches a terminal status, or say what it was doing. */
async function settledRun(
  key: string,
  runId: string,
  within: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + within;
  for (;;) {
    const read = await call("GET", `/v1/runs/${runId}`, { key });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const status = String(read.body.status);
    if (status === "completed" || status === "canceled") return read.body;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} is still ${status} after ${within}ms; the simulator said:\n` +
          simulatorSaid,
      );
    }
    await new Promise((resume) => setTimeout(resume, 250));
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "egma-simulator-walk-"));
  counterpart = new RetellCounterpart();
  await counterpart.start();
  // The trace store gets its schema here, because this walk reads the
  // conversation back out of it rather than only off the row.
  instance = await startInstance("simulator_walk", {
    web: false,
    traces: true,
    retellFetch: RETELL_CHAT_PREFLIGHT,
    ...(storage.available ? { ingestStore: storage.ingestStore } : {}),
    beforeApiListen(api) {
      api.addHook("preHandler", async (request) => {
        if (
          terminalReportSimulationId === undefined ||
          request.routeOptions.url !== REPORTS_PATH
        ) {
          return;
        }
        const { simulationId } = request.params as { simulationId?: string };
        if (simulationId !== terminalReportSimulationId) return;
        const report = request.body as {
          readonly events?: readonly { readonly status?: unknown }[];
        };
        const hasTerminalEvent =
          report.events?.some(
            (event) =>
              event.status === "completed" ||
              event.status === "failed" ||
              event.status === "canceled",
          ) ?? false;
        if (!hasTerminalEvent) return;

        terminalReportArrived.open();
        await terminalReportCanLand.opened;
      });
    },
  });
}, 120_000);

afterAll(async () => {
  terminalReportCanLand.open();
  simulator?.kill("SIGTERM");
  grader?.stop();
  await grader?.finished;
  await instance?.close();
  await counterpart?.stop();
  await rm(scratch, { recursive: true, force: true });
  if (storage.available) storage.stop();
});

describe.skipIf(!storage.available)("the shipped simulator against the real API", () => {
  it(
    "walks queued → claimed → running → completed, and a refused key to an honest failed",
    // Every controlled wait below has its own smaller deadline and diagnostic.
    // This outer limit must not replace one with Vitest's generic timeout.
    { timeout: 420_000 },
    async () => {
      const { key, userId, organizationId, projectId } = await signedUpKey();

      // The agent and the way to reach it — a retell chat connection whose
      // key the counterpart accepts, and a second whose key it refuses.
      const registered = await call("POST", "/v1/agents", {
        key,
        body: {
          name: "Front desk",
          connection: {
            agentPlatform: "retell",
            connectionKind: "retell_chat_api",
            accessVariant: "retell_chat_api.api_key",
            modality: "chat",
            config: { retellAgentId: "agent_under_walk" },
            credentials: { apiKey: COUNTERPART_KEY },
          },
        },
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const agentId = (registered.body.agent as { id: string }).id;
      const goodConnection = (registered.body.connection as { id: string }).id;

      const attached = await call("POST", `/v1/agents/${agentId}/connections`, {
        key,
        body: {
          agentPlatform: "retell",
          connectionKind: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          config: { retellAgentId: "agent_under_walk" },
          credentials: { apiKey: REFUSED_KEY },
        },
      });
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
      const refusedConnection = (attached.body.connection as { id: string }).id;

      // Point both connections at the counterpart. `baseUrl` is the shipped
      // plug's own documented config key — what lets an exchange land on a
      // Retell-shaped server on loopback — but the connection factory does
      // not take it from customers yet, so the harness writes it the way a
      // deployment pointing at a proxy one day would. Raw SQL on purpose,
      // and the only hand this test lays on any table.
      await instance.database.sql(
        `update connection
            set config = config || jsonb_build_object('baseUrl', $1::text)
          where id in ($2, $3)`,
        [
          `http://127.0.0.1:${counterpart.port}`,
          goodConnection,
          refusedConnection,
        ],
      );

      // The persona is authored at the seam and this process shares the
      // instance's database connection.
      const auth: AuthContext = {
        userId,
        organizationId,
        projectId,
        role: "member",
        via: "session",
      };
      await createPersona(auth, {
        name: "Impatient Rita",
        traits: NEUTRAL_TRAITS,
      });
      // No grader is authored here. The project was created with an active
      // expected-behaviors copy; its immutable version owns the model and the
      // worker resolves the deployment credential at claim time.

      const suite = await call("POST", "/v1/test-suites", {
        key,
        body: { name: "Appointment changes" },
      });
      expect(suite.status, JSON.stringify(suite.body)).toBe(201);
      const suiteId = String(suite.body.id);

      const pushed = await call("POST", "/v1/tests", {
        key,
        body: {
          suiteId,
          name: "Reschedules a booked appointment",
          scenario:
            "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
          expectedBehaviors: [THE_BEHAVIOR],
          personas: ["Impatient Rita"],
        },
      });
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);

      // Both runs queued before the simulator exists, so the walk starts
      // from the resting state a trigger leaves behind.
      const startRunOver = async (connection: string) => {
        const started = await call("POST", "/v1/runs", {
          key,
          body: {
            suiteId,
            agentId,
            connectionId: connection,
            idempotencyKey: newId("run"),
          },
        });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const page = await call(
          "GET",
          `/v1/runs/${String(started.body.id)}/simulations?pageSize=1`,
          { key },
        );
        expect(page.status, JSON.stringify(page.body)).toBe(200);
        const simulations = page.body.simulations as { id: string }[];
        const first = simulations[0];
        if (first === undefined) throw new Error("the run has no simulation");
        return { runId: String(started.body.id), simulationId: first.id };
      };
      const conducted = await startRunOver(goodConnection);
      const refused = await startRunOver(refusedConnection);
      terminalReportSimulationId = conducted.simulationId;

      // The shipped service loop, pointed at this instance and holding the
      // deployment's service token. Its model client is the one explicit test
      // seam: deterministic replies keep this proof off a provider account.
      simulator = spawn(
        "uv",
        ["run", "--frozen", "python", "tests/simulator_process.py"],
        {
          cwd: SIMULATOR_DIRECTORY,
          env: {
            ...process.env,
            EGMA_SIMULATOR_CONTROL_PLANE_URL: instance.origin,
            EGMA_SIMULATOR_SERVICE_TOKEN: SERVICE_TOKEN,
            EGMA_SIMULATOR_CLAIMANT: "walking-simulator-1",
            EGMA_SIMULATOR_CLAIM_WAIT_SECONDS: "2",
            EGMA_SIMULATOR_HEARTBEAT_SECONDS: "1",
            EGMA_SIMULATOR_WAL_DIR: path.join(scratch, "wal"),
            EGMA_SIMULATOR_BLOB_DIR: path.join(scratch, "blobs"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      simulator.stdout?.on("data", (piece: Buffer) => {
        simulatorSaid += piece.toString("utf8");
      });
      simulator.stderr?.on("data", (piece: Buffer) => {
        simulatorSaid += piece.toString("utf8");
      });

      // The real grader, in this process and against these same two stores,
      // claiming the work each terminal landing mints. Started beside the
      // simulator rather than after it, so the walk to a grade is one
      // continuous thing and not a second act arranged afterwards.
      const judge = scriptedJudge({
        answers: {
          [THE_BEHAVIOR]: {
            decision: "met",
            rationale: "the agent named an afternoon back before finishing.",
            citedTurns: [3],
          },
        },
      });
      grader = startService({
        config: {
          databaseUrl: "",
          clickhouseUrl: "",
          // Both stores are already connected by the instance this process
          // shares.
          claimant: "walking-grader-1",
          capacity: 4,
          heartbeatSeconds: 1,
          leaseSeconds: 3_600,
          sweepSeconds: 3_600,
          logLevel: "ERROR",
        },
        log: makeLog("ERROR", "walking-grader-1"),
        makers: judge.makers,
        providerCredentials: {
          async load() {
            return { openai: "walking-grader-provider-key" };
          },
        },
      });

      // Hold the first agent answer. The greeting has already crossed the
      // answer boundary and flushed, but the conversation cannot finish.
      const traceId = traceIdOf(conducted.simulationId);
      await counterpart.waitForHeldCompletion(60_000);
      try {
        // Streamed, not posted at the end: evidence is readable in ClickHouse
        // while the Simulation is held in its running state.
        const whileRunning = await runningEvidence(
          conducted.simulationId,
          traceId,
          30_000,
        );
        expect(whileRunning).toContain("agent_turn");
        // The root closes the trace. It cannot exist while the held
        // conversation is still in progress.
        expect(whileRunning).not.toContain("simulation");
      } finally {
        counterpart.releaseHeldCompletion();
      }

      // The terminal lifecycle document has reached the real report door, but
      // the route has not applied it. The simulator drains every span first,
      // so the complete trace must already be readable while PostgreSQL still
      // says this Simulation is running.
      await waitForSignal(
        terminalReportArrived.opened,
        60_000,
        "the terminal report did not reach the API",
      );
      let spans: StoredSpan[] = [];
      try {
        expect((await rowOf(conducted.simulationId)).status).toBe("running");
        // The root span closes the trace and rides the last segment, so its
        // arrival is what says the whole conversation is readable. Bounded,
        // and answered with whatever the last look saw, so a conversation
        // that never lands fails on what is missing rather than on a timer.
        const readableBy = Date.now() + 30_000;
        spans = await storedSpans(traceId);
        while (
          !spans.some((span) => span.name === "simulation") &&
          Date.now() <= readableBy
        ) {
          await new Promise((resume) => setTimeout(resume, 25));
          spans = await storedSpans(traceId);
        }
        // Still running after the wait: the held report is the only terminal
        // producer for this Simulation, and it has not landed.
        expect((await rowOf(conducted.simulationId)).status).toBe("running");
        const beforeTerminal = spans.map((span) => span.name);
        expect(
          beforeTerminal.filter((name) => name.endsWith("_turn")),
        ).toHaveLength(4);
        expect(
          beforeTerminal.filter((name) => name === "simulation"),
        ).toHaveLength(1);
      } finally {
        terminalReportCanLand.open();
      }

      expect(await waitForTerminal(conducted.simulationId, 60_000)).toBe(
        "completed",
      );

      // The whole walk, as a person watching the run would see it settle.
      const conductedRun = await settledRun(key, conducted.runId, 60_000);
      const refusedRun = await settledRun(key, refused.runId, 60_000);

      // The conversation that happened: completed, concluded by the persona,
      // and every lifecycle column telling the truth about it.
      const row = await rowOf(conducted.simulationId);
      if (row.status !== "completed") {
        throw new Error(
          `the conducted simulation ended ${String(row.ending_reason)}; ` +
            `the simulator said:\n${simulatorSaid}`,
        );
      }
      expect(row.ending_reason).toBe("persona_concluded");
      expect(row.claimed_by).toBe("walking-simulator-1");
      // Greeting, the scenario's one sentence, the scripted answer, and the
      // persona's goodbye: four turns, counted by the simulator itself.
      expect(row.turn_count).toBe(4);
      // Retell's own id for the exchange, echoed off the counterpart.
      expect(String(row.provider_reference)).toMatch(/^chat_/);
      const startedAt = new Date(String(row.started_at));
      const endedAt = new Date(String(row.ended_at));
      expect(startedAt.getTime()).toBeLessThanOrEqual(endedAt.getTime());

      // The complete conversation read while the terminal report was held,
      // before PostgreSQL left running — one span per timed thing, nothing
      // invented, in the same shape the grader reads.
      const names = spans.map((span) => span.name);
      expect(names.filter((name) => name === "agent_turn")).toHaveLength(2);
      expect(names.filter((name) => name === "human_turn")).toHaveLength(2);
      expect(names.filter((name) => name === "turn_response_latency")).toHaveLength(1);
      expect(names).toContain("first_response_latency");
      expect(names.filter((name) => name === "simulation")).toHaveLength(1);
      // What the row counted and what the store holds are one conversation.
      expect(names.filter((name) => name.endsWith("_turn"))).toHaveLength(
        Number(row.turn_count),
      );

      // What was said, in order, with the transcript's two labels riding the
      // span names — the speaker is the name, so nothing can disagree with it.
      expect(
        spans
          .filter((span) => span.name.endsWith("_turn"))
          .map((span) => [span.name, span.text]),
      ).toEqual([
        ["agent_turn", "Lakeside Dental, how can I help?"],
        [
          "human_turn",
          "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
        ],
        [
          "agent_turn",
          "Of course — we have Tuesday and Wednesday afternoon free next week.",
        ],
        ["human_turn", "That covers everything I needed. Thank you, goodbye."],
      ]);

      // Filed under the customer's own row, from egma's own side of the
      // conversation, and never from anything the payload claimed.
      const root = spans.find((span) => span.name === "simulation");
      expect(root?.kind).toBe("root");
      expect(root?.parent_span_id).toBe("");
      for (const span of spans) {
        expect(span.source).toBe("simulation");
        expect(span.emitter).toBe("egma-runtime");
        expect(span.run_id).toBe(conducted.runId);
        expect(span.agent_id).toBe(agentId);
        if (span !== root) expect(span.parent_span_id).toBe(root?.span_id);
      }

      // A timing span's own duration is the measurement, in nanoseconds.
      for (const span of spans) {
        if (span.name.endsWith("_latency")) {
          expect(Number(span.duration_ns)).toBeGreaterThan(0);
        }
      }

      // Every span landed once. The simulator retries the same serialized
      // bytes, so ClickHouse can suppress a recent exact block repeat.
      expect(new Set(spans.map((span) => span.span_id)).size).toBe(spans.length);

      expect(conductedRun.status).toBe("completed");
      expect(conductedRun.completedCount).toBe(1);
      expect(conductedRun.failedCount).toBe(0);

      // The conversation that could not happen: the platform refused the
      // key, and the record says failed with the simulator's honest word —
      // never a grade of an agent nothing ever reached.
      const refusedRow = await rowOf(refused.simulationId);
      expect(refusedRow.status).toBe("failed");
      expect(refusedRow.ending_reason).toBe("simulator_error");
      expect(refusedRow.claimed_by).toBe("walking-simulator-1");
      expect(await gradingJobsFor(refused.simulationId)).toBe(0);

      // A simulation that never got a conversation still says it happened:
      // one root span, no turns, nothing invented to fill the silence.
      const refusedSpans = await storedSpans(traceIdOf(refused.simulationId));
      expect(refusedSpans.map((span) => span.name)).toEqual(["simulation"]);

      expect(refusedRun.status).toBe("completed");
      expect(refusedRun.completedCount).toBe(0);
      expect(refusedRun.failedCount).toBe(1);

      // And the grade, which is what the whole walk was for. The Expected
      // behaviors grader scored this trace from the spans above.
      const grades = await gradesOn(
        auth,
        conducted.simulationId,
        conducted.runId,
        1,
        30_000,
      );
      const [grade] = grades;
      // Successful work is temporary. The grade can become query-visible just
      // before the worker deletes its Postgres queue row, so wait for that
      // ordered cleanup instead of depending on which read wins the instant.
      await waitForGradingCleanup(conducted.simulationId, 30_000);

      // The row names both the project policy and the shared definition version.
      const seeded = await theProjectsGrader(auth);
      expect(grade).toMatchObject({
        projectGraderId: seeded.id,
        graderDefinitionId: seeded.definitionId,
        graderDefinitionVersion: seeded.definitionVersion,
        score: 1,
        result: "passed",
        traceId: traceIdOf(conducted.simulationId),
        runId: conducted.runId,
      });
      // Cited at its position in the span-assembled transcript: the third
      // thing said, which is the agent turn carrying the phrase — the same
      // turn the store holds and the same one this test read back above.
      expect(grade?.details.assertions?.[0]?.citedSpanIds).toEqual(["turn:3"]);
      expect(
        spans.filter((span) => span.name.endsWith("_turn"))[2]?.text,
      ).toContain(THE_PHRASE);

      // Assertion details stay nested under the one normalized grader score.
      expect(grade?.details.assertions?.[0]).toMatchObject({
        key: "behavior_1",
        score: 1,
      });
      // The judge was shown the conversation egma assembled, not a report:
      // four turns, the ending the row records, and no tool call, because the
      // counterpart made none.
      const [asked] = judge.asked;
      expect(asked?.criterion).toBe(THE_BEHAVIOR);
      expect(asked?.evidence.transcript).toHaveLength(4);
      expect(asked?.evidence.outcome).toMatchObject({
        happened: true,
        endingReason: "persona_concluded",
        turns: 4,
      });

      // And the row it was all filed against holds no conversation, because
      // the table has nowhere left to put one. Asked of the schema rather
      // than of a row: a column nobody writes is not the same fact as a
      // column that does not exist.
      const { rows: gone } = await instance.database.sql<{
        column_name: string;
      }>(
        `select column_name from information_schema.columns
          where table_name = 'simulation'
            and column_name in ('transcript', 'events', 'metrics')`,
      );
      expect(gone).toEqual([]);
    },
  );
});
