import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { createPersona, readTraceGrades } from "@egma/db";
import { afterAll, expect, it } from "vitest";

import { startInstance, type Instance } from "./support/instance.ts";
import { openBrowser } from "./support/browser.ts";
import { startObjectStorage } from "./support/object-storage.ts";
import { NEUTRAL_PERSON } from "./support/traces.ts";
import {
  assertEvidencePage,
  assertPublicEvidence,
  startPublicTunnel,
  startFullPathWorkers,
  stopChild,
  waitForChild,
} from "./support/simulation-proof.ts";

const ENABLED = process.env["SIMULATION_E2E_RETELL"] === "1";
const CONNECTION = process.env["SIMULATION_E2E_RETELL_CONNECTION"] ?? "text";
const MOCKS = process.env["SIMULATION_E2E_MOCKS"] !== "off";
const RETELL_KEY = process.env["SIMULATION_E2E_RETELL_API_KEY"]?.trim() ?? "";
const MODEL_KEY = process.env["SIMULATION_E2E_MODEL_API_KEY"]?.trim() ??
  process.env["LIVEKIT_E2E_OPENAI_API_KEY"]?.trim() ?? "";
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";
const REPOSITORY = path.join(import.meta.dirname, "../../..");
const SIMULATOR = path.join(REPOSITORY, "apps/simulator");
const PYTHON = path.join(SIMULATOR, ".venv/bin/python");
const storage = ENABLED
  ? await startObjectStorage("retell-live-simulation")
  : undefined;

afterAll(() => { if (storage?.available === true) storage.stop(); });

function liveStorage(): Extract<NonNullable<typeof storage>, { available: true }> {
  if (storage?.available !== true) throw new Error("the Retell live test has no object store");
  return storage;
}

type ToolRequest = { path: string; body: Record<string, unknown> };
type PublicSpan = {
  spanId?: string;
  startedAt?: string;
  kind?: string;
  text?: string;
  toolName?: string;
  toolArguments?: string;
  toolResult?: string;
  pov?: string;
  spans?: PublicSpan[];
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function traceIdOf(simulationId: string): string {
  let value = 0n;
  for (const character of simulationId.slice("sim_".length)) {
    const digit = CROCKFORD.indexOf(character);
    if (digit < 0) throw new Error(`${simulationId} is not a simulation id`);
    value = (value << 5n) | BigInt(digit);
  }
  return value.toString(16).padStart(32, "0");
}

function decoded(value: unknown): unknown {
  let result = value;
  for (let depth = 0; depth < 2 && typeof result === "string"; depth += 1) {
    try { result = JSON.parse(result) as unknown; } catch { break; }
  }
  return result;
}

function publicTranscript(body: Record<string, unknown>): {
  turns: PublicSpan[];
  spans: PublicSpan[];
} {
  return body.transcript as { turns: PublicSpan[]; spans: PublicSpan[] };
}

function publicTools(transcript: { turns: PublicSpan[]; spans: PublicSpan[] }, pov: string) {
  const seen = new Set<string>();
  const tools: PublicSpan[] = [];
  const visit = (span: PublicSpan): void => {
    if (span.kind === "tool" && span.pov === pov) {
      const identity = span.spanId ?? JSON.stringify(span);
      if (!seen.has(identity)) {
        seen.add(identity);
        tools.push(span);
      }
    }
    for (const child of span.spans ?? []) visit(child);
  };
  for (const span of [...transcript.spans, ...transcript.turns]) visit(span);
  return tools.sort((left, right) =>
    String(left.startedAt).localeCompare(String(right.startedAt)) ||
    String(left.spanId).localeCompare(String(right.spanId))
  );
}

/** Compare every public event Retell documents as conversation evidence.
 * Provider-only transitions and measurements remain on the safe root payload;
 * Retell does not define them as spoken turns or paired tool calls. */
function expectWebEvidenceToMatchRetell(
  body: Record<string, unknown>,
  providerCall: Record<string, unknown>,
): void {
  const transcript = publicTranscript(body);
  const woven = providerCall.transcript_with_tool_calls;
  if (!Array.isArray(woven)) throw new Error("Retell final record has no woven transcript");
  const providerTurns = woven.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const message = entry as Record<string, unknown>;
    if ((message.role !== "user" && message.role !== "agent") || typeof message.content !== "string") return [];
    return [{ kind: message.role === "user" ? "turn:human" : "turn:agent", text: message.content }];
  });
  const egmaTurns = transcript.turns
    .filter((turn) => turn.pov === "agent")
    .map((turn) => ({ kind: turn.kind, text: turn.text }));
  expect(egmaTurns).toEqual(providerTurns);

  const pending = new Map<string, { name: unknown; arguments: unknown }>();
  const seen = new Set<string>();
  const providerTools: Array<{ name: unknown; arguments: unknown; result: unknown }> = [];
  for (const entry of woven) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const message = entry as Record<string, unknown>;
    const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
    if (message.role === "tool_call_invocation" && id !== "") {
      if (seen.has(id)) throw new Error(`Retell reused tool call id ${id}`);
      seen.add(id);
      pending.set(id, { name: message.name, arguments: decoded(message.arguments) });
    } else if (message.role === "tool_call_result") {
      const invocation = pending.get(id);
      if (id === "" || invocation === undefined) {
        throw new Error(`Retell returned an orphan tool result${id === "" ? "" : ` ${id}`}`);
      }
      pending.delete(id);
      providerTools.push({ ...invocation, result: decoded(message.content) });
    }
  }
  expect(pending.size, "Retell returned an invocation without its result").toBe(0);
  expect(publicTools(transcript, "agent").map((tool) => ({
    name: tool.toolName,
    arguments: decoded(tool.toolArguments),
    result: decoded(tool.toolResult),
  }))).toEqual(providerTools);
}

function expectCompleteTextModeExchange(body: Record<string, unknown>): void {
  const transcript = publicTranscript(body);
  const turns = transcript.turns.filter((turn) => turn.pov === "persona");
  expect(turns[0]?.kind).toBe("turn:human");
  expect(turns.every((turn, index) =>
    turn.kind === (index % 2 === 0 ? "turn:human" : "turn:agent")
  )).toBe(true);
  expect(publicTools(transcript, "persona").map((tool) => tool.toolName)).toEqual([
    "check_availability",
    "record_request",
    "end_call",
  ]);
}

async function callbackServer(token: string): Promise<{
  origin: string;
  calls: ToolRequest[];
  close(): Promise<void>;
}> {
  const calls: ToolRequest[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (piece: Buffer) => { raw += piece.toString("utf8"); });
    request.on("end", () => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const body = raw === "" ? {} : JSON.parse(raw) as Record<string, unknown>;
      const args = typeof body.args === "object" && body.args !== null
        ? body.args as Record<string, unknown>
        : body;
      const requestPath = request.url ?? "/";
      calls.push({ path: requestPath, body: args });
      const result = requestPath === "/check-availability"
        ? { available: true, day: "Tuesday", time: "9:40 AM" }
        : { recorded: true, day: "Tuesday", time: String(args.time ?? "9:40 AM"), reference: "retell-e2e-742" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("callback server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForFile<T>(file: string, child: ChildProcess, output: () => string): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Retell fixture exited early: ${output()}`);
    try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { /* still provisioning */ }
    if (Date.now() > deadline) throw new Error(`Retell fixture was not ready: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function request(
  instance: Instance,
  method: string,
  route: string,
  options: { key?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
  const response = await fetch(`${instance.origin}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : JSON.parse(text) as Record<string, unknown>,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
  };
}

it.skipIf(!ENABLED || storage?.available !== true)(
  `runs the real Retell ${CONNECTION} ${MOCKS ? "mocked" : "unmocked"} cell through storage, grading, and the browser`,
  { timeout: 480_000 },
  async () => {
    expect(["text", "web"]).toContain(CONNECTION);
    if (RETELL_KEY === "" || MODEL_KEY === "") throw new Error("Retell and model E2E keys are required");
    const scratch = await mkdtemp(path.join(os.tmpdir(), "egma-retell-live-"));
    const proofDirectory = path.join(REPOSITORY, ".proofs/simulation-e2e");
    const callbackToken = `retell-fixture-${process.pid}-${Date.now()}`;
    const callback = await callbackServer(callbackToken);
    const tunnel = await startPublicTunnel(callback.origin);
    const readyPath = path.join(scratch, "retell-ready.json");
    const stopPath = path.join(scratch, "retell-stop");
    let fixtureOutput = "";
    const fixture = spawn(PYTHON, [path.join(REPOSITORY, "fixtures/simulation-e2e/retell_provider.py")], {
      cwd: REPOSITORY,
      env: {
        ...process.env,
        SIMULATION_E2E_RETELL_API_KEY: RETELL_KEY,
        SIMULATION_E2E_RETELL_WEBHOOK_URL: tunnel.url,
        SIMULATION_E2E_RETELL_WEBHOOK_AUTH: callbackToken,
        SIMULATION_E2E_RETELL_READY: readyPath,
        SIMULATION_E2E_RETELL_STOP: stopPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    fixture.stdout?.on("data", (piece: Buffer) => { fixtureOutput += piece.toString("utf8"); });
    fixture.stderr?.on("data", (piece: Buffer) => { fixtureOutput += piece.toString("utf8"); });
    let instance: Instance | undefined;
    let workers: ReturnType<typeof startFullPathWorkers> | undefined;
    let provisioned: {
      agentId: string;
      agentVersion: number;
      providerMetadata: Record<string, unknown>;
    } | undefined;
    let projectKey = "";
    let mainSucceeded = false;
    try {
      provisioned = await waitForFile<{
        agentId: string;
        agentVersion: number;
        providerMetadata: Record<string, unknown>;
      }>(readyPath, fixture, () => fixtureOutput);
      instance = await startInstance(`retell_live_${CONNECTION}_${MOCKS ? "mock" : "real"}`, {
        web: true,
        traces: true,
        providerKeys: { openai: MODEL_KEY },
        ingestStore: liveStorage().ingestStore,
        blob: liveStorage().store,
      });
      const signup = await request(instance, "POST", "/api/signup", { body: {
        email: "retell-e2e@acme.example",
        password: "a-password-long-enough-1",
        organizationName: "Retell E2E",
      } });
      expect(signup.status, JSON.stringify(signup.body)).toBe(201);
      const sessionCookie = signup.cookie;
      const identity = signup.body as unknown as {
        userId: string;
        organization: { id: string };
        project: { id: string };
      };
      const key = await request(instance, "POST", "/v1/keys", {
        cookie: sessionCookie,
        body: { name: "retell-live", projectId: identity.project.id },
      });
      expect(key.status, JSON.stringify(key.body)).toBe(201);
      projectKey = String(key.body.secret);
      const registered = await request(instance, "POST", "/v1/agents", { key: projectKey, body: {
        agentPlatform: "retell",
        name: "Ephemeral Retell appointment agent",
        connection: {
          agentPlatform: "retell",
          connectionType: CONNECTION === "text" ? "retell_text_mode" : "retell_web_call",
          accessVariant: CONNECTION === "text" ? "retell_text_mode.api_key" : "retell_web_call.api_key",
          modality: CONNECTION === "text" ? "chat" : "voice",
          config: { retellAgentId: provisioned.agentId },
          credentials: { apiKey: RETELL_KEY },
          platformAgentId: provisioned.agentId,
        },
      } });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      const auth = {
        userId: identity.userId,
        organizationId: identity.organization.id,
        projectId: identity.project.id,
        role: "member" as const,
        via: "session" as const,
      };
      await createPersona(auth, {
        name: "Appointment Rita",
        ...NEUTRAL_PERSON,
        models: {
          llm: { provider: "openai", model: "gpt-4o-mini" },
          stt: { provider: "openai", model: "gpt-live-transcribe" },
          tts: { provider: "openai", model: "tts-1", voiceId: "alloy", speed: 1 },
        },
      });
      const suite = await request(instance, "POST", "/v1/test-suites", {
        key: projectKey, body: { name: "Retell live appointment" },
      });
      expect(suite.status, JSON.stringify(suite.body)).toBe(201);
      const availability = MOCKS
        ? { available: true, day: "Tuesday", time: "11:20 AM" }
        : { available: true, day: "Tuesday", time: "9:40 AM" };
      const test = await request(instance, "POST", "/v1/tests", { key: projectKey, body: {
        suiteId: String(suite.body.id),
        name: "Checks and records a Tuesday appointment",
        scenario: "Ask for a Tuesday appointment. Accept the offered time and ask the agent to record it.",
        expectedBehaviors: [
          `checks Tuesday availability, offers ${availability.time}, records the accepted request, and confirms it`,
        ],
        personas: ["Appointment Rita"],
        ...(MOCKS ? { mockTools: [{ tool: "check_availability", answer: availability }] } : {}),
      } });
      expect(test.status, JSON.stringify(test.body)).toBe(201);
      workers = startFullPathWorkers({
        apiOrigin: instance.origin,
        serviceToken: SERVICE_TOKEN,
        claimant: `retell-${CONNECTION}-${MOCKS ? "mock" : "real"}`,
        simulatorDirectory: SIMULATOR,
        walDirectory: path.join(scratch, "wal"),
        blobDirectory: path.join(scratch, "blobs"),
        modelKey: MODEL_KEY,
      });
      const run = await request(instance, "POST", "/v1/runs", { key: projectKey, body: {
        suiteId: String(suite.body.id),
        agentId: (registered.body.agent as { id: string }).id,
        connectionId: (registered.body.connection as { id: string }).id,
      } });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      const runId = String(run.body.id);
      const page = await request(instance, "GET", `/v1/runs/${runId}/simulations?pageSize=1`, { key: projectKey });
      const simulationId = String((page.body.simulations as Array<{ id: string }>)[0]?.id);
      let detail: { status: number; body: Record<string, unknown>; cookie: string } | undefined;
      await expect.poll(async () => {
        await instance!.drainEvidence();
        detail = await request(instance!, "GET", `/v1/simulations/${simulationId}`, { key: projectKey });
        return { status: detail.body.status, gradingState: detail.body.gradingState };
      }, { timeout: 180_000, interval: 500 }).toEqual({ status: "completed", gradingState: "complete" });
      const storedGrades = await readTraceGrades(auth, {
        source: "simulation",
        traceId: traceIdOf(simulationId),
        runId,
      });
      expect(storedGrades.current).toHaveLength(1);
      expect(storedGrades.current[0]?.result).toBe("passed");
      expect(storedGrades.current[0]?.score).toBe(1);
      const recorded = { recorded: true, day: "Tuesday", time: String(availability.time), reference: "retell-e2e-742" };
      assertPublicEvidence(detail!.body, {
        pov: CONNECTION === "text" ? "persona" : "agent",
        humanIncludes: "tuesday",
        agentIncludes: String(availability.time).toLowerCase(),
        recording: CONNECTION === "web",
        tools: [
          { name: "check_availability", arguments: { day: "Tuesday" }, result: availability, ...(MOCKS ? { provenance: "mocked" as const } : {}) },
          { name: "record_request", arguments: { day: "Tuesday", time: availability.time }, result: recorded },
        ],
      });
      if (CONNECTION === "web") {
        const providerReference = detail!.body.providerReference;
        if (typeof providerReference !== "string" || providerReference === "") {
          throw new Error("completed Retell web call has no provider reference");
        }
        const providerAnswer = await fetch(
          `https://api.retellai.com/v2/get-call/${encodeURIComponent(providerReference)}`,
          { headers: { authorization: `Bearer ${RETELL_KEY}` } },
        );
        if (!providerAnswer.ok) {
          throw new Error(`Retell final record read failed with HTTP ${providerAnswer.status}`);
        }
        expectWebEvidenceToMatchRetell(
          detail!.body,
          await providerAnswer.json() as Record<string, unknown>,
        );
      } else {
        // Text mode creates no provider call. The stored persona POV is the
        // platform API exchange itself, so prove that complete bounded sequence.
        expectCompleteTextModeExchange(detail!.body);
      }
      const browser = await openBrowser();
      try {
        const context = await browser.newContext();
        await context.addCookies([{
          name: sessionCookie.slice(0, sessionCookie.indexOf("=")),
          value: sessionCookie.slice(sessionCookie.indexOf("=") + 1),
          url: instance.origin,
        }]);
        const page = await context.newPage();
        await page.goto(`${instance.origin}/projects/${identity.project.id}/runs/${runId}`);
        await assertEvidencePage(page, {
          humanIncludes: "tuesday",
          agentIncludes: String(availability.time).toLowerCase(),
          recording: CONNECTION === "web",
          sourceLabel: CONNECTION === "text"
            ? "Conversation from the Retell API"
            : "Conversation from Retell",
        });
      } finally {
        await browser.close();
      }
      const availabilityCallbacks = callback.calls.filter((call) => call.path === "/check-availability");
      const recordCallbacks = callback.calls.filter((call) => call.path === "/record-request");
      if (MOCKS) expect(availabilityCallbacks).toEqual([]);
      else expect(availabilityCallbacks.map((call) => call.body)).toContainEqual({ day: "Tuesday" });
      expect(recordCallbacks.map((call) => call.body)).toContainEqual({
        day: "Tuesday",
        time: availability.time,
      });
      await mkdir(proofDirectory, { recursive: true });
      await writeFile(path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.json`), JSON.stringify({
        commitSha: process.env["GITHUB_SHA"] ?? "local-working-tree",
        connection: CONNECTION,
        mocked: MOCKS,
        providerMetadata: provisioned.providerMetadata,
        outcomes: { simulation: "completed", grade: "passed", browser: true },
      }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      mainSucceeded = true;
    } catch (error) {
      const safe = [fixtureOutput, workers?.output() ?? "", tunnel.output()]
        .join("\n").replaceAll(RETELL_KEY, "[REDACTED]").replaceAll(MODEL_KEY, "[REDACTED]")
        .replaceAll(projectKey, "[REDACTED]").replaceAll(callbackToken, "[REDACTED]");
      await mkdir(proofDirectory, { recursive: true });
      await writeFile(
        path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.log`),
        safe,
        { encoding: "utf8", mode: 0o600 },
      );
      await writeFile(
        path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.json`),
        JSON.stringify({
          commitSha: process.env["GITHUB_SHA"] ?? "local-working-tree",
          connection: CONNECTION,
          mocked: MOCKS,
          outcomes: { simulation: "failed", failureType: error instanceof Error ? error.name : "unknown" },
        }, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      throw error;
    } finally {
      const failures: unknown[] = [];
      const clean = async (task: () => Promise<void>): Promise<void> => {
        try { await task(); } catch (failure) { failures.push(failure); }
      };
      await clean(async () => { await workers?.stop(); });
      await clean(async () => { await instance?.close(); });
      await clean(async () => {
        await writeFile(stopPath, "stop\n", { encoding: "utf8", mode: 0o600 });
      });
      await clean(async () => waitForChild(fixture, 60_000));
      await clean(async () => stopChild(tunnel.process));
      await clean(async () => callback.close());
      await clean(async () => rm(scratch, { recursive: true, force: true }));
      if (failures.length > 0) {
        await mkdir(proofDirectory, { recursive: true });
        await writeFile(
          path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.json`),
          JSON.stringify({
            commitSha: process.env["GITHUB_SHA"] ?? "local-working-tree",
            connection: CONNECTION,
            mocked: MOCKS,
            ownedFixture: provisioned === undefined ? null : {
              agentId: provisioned.agentId,
              agentVersion: provisioned.agentVersion,
              providerMetadata: provisioned.providerMetadata,
            },
            outcomes: {
              simulation: "failed",
              cleanup: "failed",
              cleanupFailureCount: failures.length,
            },
          }, null, 2) + "\n",
          { encoding: "utf8", mode: 0o600 },
        );
        throw new AggregateError(failures, "Retell live fixture cleanup failed");
      }
      if (mainSucceeded) {
        const manifestPath = path.join(
          proofDirectory,
          `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.json`,
        );
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          outcomes: Record<string, unknown>;
        };
        manifest.outcomes.cleanup = "complete";
        await writeFile(
          manifestPath,
          JSON.stringify(manifest, null, 2) + "\n",
          { encoding: "utf8", mode: 0o600 },
        );
      }
    }
  },
);
