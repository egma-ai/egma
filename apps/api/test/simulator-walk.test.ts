import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createPersona } from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startInstance, type Instance } from "./support/instance.ts";
import { NEUTRAL_TRAITS } from "./support/traces.ts";

/**
 * The whole wire, walked by the shipped simulator: a run started through the
 * real API, its simulation claimed from the real claim door, conducted by
 * the real Python service over a Retell-shaped counterpart on loopback, and
 * reported back through the real report door — queued → claimed → running →
 * completed, with every lifecycle column read back and checked for truth.
 *
 * Nothing here is a stand-in for egma's own halves: the API listens on a
 * real port, the database is a real Postgres, and the simulator is the same
 * process `docker compose up` starts. The one fake is the platform on the
 * far side of the conversation — a local server speaking Retell's chat wire
 * shape — because the agent under test is the customer's, and a test that
 * needed a real Retell account would prove an account rather than the wire.
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
      this.delivered.set(chatId, turn + 1);
      send(200, { messages: [{ role: "agent", content: reply }] });
      return;
    }
    if (request.method === "PATCH" && url.startsWith("/end-chat/")) {
      send(200, {});
      return;
    }
    send(404, { error: `nothing at ${url}` });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }
}

let instance: Instance;
let counterpart: RetellCounterpart;
let simulator: ChildProcess | undefined;
let simulatorSaid = "";
let scratch: string;

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

  const minted = await call("POST", "/api/keys", {
    cookie,
    body: { name: "walking", project_id: landed.project.id },
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
            turn_count, provider_reference, measured_audio_band_hertz,
            cancel_requested_at
       from simulation where id = $1`,
    [simulationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no row for ${simulationId}`);
  return row;
}

async function gradingJobsFor(simulationId: string): Promise<number> {
  const { rows } = await instance.database.sql<{ count: string }>(
    "select count(*) as count from grading_job where simulation_id = $1",
    [simulationId],
  );
  return Number(rows[0]?.count);
}

/** Poll one run until it reaches a terminal status, or say what it was doing. */
async function settledRun(
  key: string,
  runId: string,
  within: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + within;
  for (;;) {
    const read = await call("GET", `/api/runs/${runId}`, { key });
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
  instance = await startInstance("simulator_walk", { web: false });
}, 120_000);

afterAll(async () => {
  simulator?.kill("SIGTERM");
  await instance?.close();
  await counterpart?.stop();
  await rm(scratch, { recursive: true, force: true });
});

describe("the shipped simulator against the real API", () => {
  it(
    "walks queued → claimed → running → completed, and a refused key to an honest failed",
    { timeout: 90_000 },
    async () => {
      const { key, userId, organizationId, projectId } = await signedUpKey();

      // The agent and the way to reach it — a retell chat connection whose
      // key the counterpart accepts, and a second whose key it refuses.
      const registered = await call("POST", "/api/agents", {
        key,
        body: {
          name: "Front desk",
          connection: {
            type: "retell",
            modality: "chat",
            config: { retellAgentId: "agent_under_walk" },
            credentials: { apiKey: COUNTERPART_KEY },
          },
        },
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const agentId = (registered.body.agent as { id: string }).id;
      const goodConnection = (registered.body.connection as { id: string }).id;

      const attached = await call("POST", `/api/agents/${agentId}/connections`, {
        key,
        body: {
          type: "retell",
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

      // The persona is authored at the seam — no route ships for one — and
      // the test then names her, which is what the claimed spec's traits
      // come from. This process shares the instance's database connection.
      await createPersona(
        {
          userId,
          organizationId,
          projectId,
          role: "member",
          via: "session",
        },
        { name: "Impatient Rita", traits: NEUTRAL_TRAITS },
      );

      const pushed = await call("POST", "/api/tests", {
        key,
        body: {
          name: "Reschedules a booked appointment",
          scenario:
            "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
          expected_behaviors: ["confirms the new time back before finishing"],
          personas: ["Impatient Rita"],
        },
      });
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
      const versionId = String(pushed.body.version_id);

      // Both runs queued before the simulator exists, so the walk starts
      // from the resting state a trigger leaves behind.
      const startRunOver = async (connection: string) => {
        const started = await call("POST", "/api/runs", {
          key,
          body: { connection, test_versions: [versionId] },
        });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        const simulations = started.body.simulations as { id: string }[];
        const first = simulations[0];
        if (first === undefined) throw new Error("the run has no simulation");
        return { runId: String(started.body.id), simulationId: first.id };
      };
      const conducted = await startRunOver(goodConnection);
      const refused = await startRunOver(refusedConnection);

      // The shipped service, exactly as compose starts it: pointed at this
      // instance, holding the deployment's service token, everything else
      // its defaults — the scripted persona model included.
      simulator = spawn("uv", ["run", "--frozen", "egma-simulator"], {
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
      });
      simulator.stdout?.on("data", (piece: Buffer) => {
        simulatorSaid += piece.toString("utf8");
      });
      simulator.stderr?.on("data", (piece: Buffer) => {
        simulatorSaid += piece.toString("utf8");
      });

      // The whole walk, as a person watching the run would see it settle.
      const conductedRun = await settledRun(key, conducted.runId, 60_000);
      const refusedRun = await settledRun(key, refused.runId, 60_000);

      // The conversation that happened: completed, concluded by the persona,
      // and every lifecycle column telling the truth about it.
      const row = await rowOf(conducted.simulationId);
      expect(row.status).toBe("completed");
      expect(row.ending_reason).toBe("persona_concluded");
      expect(row.claimed_by).toBe("walking-simulator-1");
      // Greeting, the scenario's one sentence, the scripted answer, and the
      // persona's goodbye: four turns, counted by the simulator itself.
      expect(row.turn_count).toBe(4);
      // Retell's own id for the exchange, echoed off the counterpart.
      expect(String(row.provider_reference)).toMatch(/^chat_/);
      expect(row.measured_audio_band_hertz).toBeNull();
      const startedAt = new Date(String(row.started_at));
      const endedAt = new Date(String(row.ended_at));
      expect(startedAt.getTime()).toBeLessThanOrEqual(endedAt.getTime());
      expect(await gradingJobsFor(conducted.simulationId)).toBe(1);

      expect(conductedRun.status).toBe("completed");
      expect(conductedRun.completed_count).toBe(1);
      expect(conductedRun.failed_count).toBe(0);

      // The conversation that could not happen: the platform refused the
      // key, and the record says failed with the simulator's honest word —
      // never a judgement of an agent nothing ever reached.
      const refusedRow = await rowOf(refused.simulationId);
      expect(refusedRow.status).toBe("failed");
      expect(refusedRow.ending_reason).toBe("simulator_error");
      expect(refusedRow.claimed_by).toBe("walking-simulator-1");
      expect(await gradingJobsFor(refused.simulationId)).toBe(1);

      expect(refusedRun.status).toBe("completed");
      expect(refusedRun.completed_count).toBe(0);
      expect(refusedRun.failed_count).toBe(1);
    },
  );
});
