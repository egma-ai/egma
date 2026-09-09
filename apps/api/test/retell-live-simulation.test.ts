import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createPersona, readTraceGrades } from "@egma/db";
import { safeRetellProviderData } from "@egma/retell";
import { afterAll, expect, it } from "vitest";

import { startInstance, type Instance } from "./support/instance.ts";
import { openBrowser } from "./support/browser.ts";
import { startObjectStorage } from "./support/object-storage.ts";
import { NEUTRAL_PERSON } from "./support/traces.ts";
import {
  assertEvidencePage,
  assertPublicEvidence,
  assertValidGrade,
  startPublicTunnel,
  startFullPathWorkers,
  stopChild,
  waitForChild,
  waitForPublicTunnel,
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

function redact(text: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret !== "")
    .reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), text);
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
  const terminalCalls = [...pending.entries()].filter(([, invocation]) =>
    invocation.name === "end_call"
  );
  expect(terminalCalls, "Retell must finish with one native end_call invocation").toHaveLength(1);
  const terminalArguments = terminalCalls[0]?.[1].arguments;
  expect(terminalArguments).toMatchObject({ execution_message: expect.any(String) });
  expect(String((terminalArguments as { execution_message?: unknown }).execution_message).trim())
    .not.toBe("");
  pending.delete(terminalCalls[0]![0]);
  expect(pending.size, "Retell returned a custom-tool invocation without its result").toBe(0);
  const publicEvidenceTools = publicTools(transcript, "agent");
  const publicTerminalCalls = publicEvidenceTools.filter((tool) => tool.toolName === "end_call");
  expect(publicTerminalCalls).toHaveLength(1);
  expect(publicTerminalCalls[0]?.toolResult ?? "").toBe("");
  expect(publicEvidenceTools.filter((tool) => tool.toolName !== "end_call").map((tool) => ({
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
  setMockOrigin(origin: string): void;
  close(): Promise<void>;
}> {
  const calls: ToolRequest[] = [];
  let mockOrigin: string | undefined;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (piece: Buffer) => { raw += piece.toString("utf8"); });
    request.on("end", () => {
      const requestPath = request.url ?? "/";
      if (request.method === "GET" && requestPath === "/_egma-fixture/health") {
        response.writeHead(204).end();
        return;
      }
      const providerCallback = requestPath === "/check-availability" ||
        requestPath === "/record-request";
      if (!providerCallback && mockOrigin !== undefined) {
        const target = new URL(requestPath, mockOrigin);
        const forwarded = http.request(target, {
          method: request.method ?? "GET",
          headers: {
            ...request.headers,
            host: target.host,
            ...(request.headers.host === undefined ? {} : { "x-forwarded-host": request.headers.host }),
            "x-forwarded-proto": "https",
          },
        }, (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        });
        forwarded.on("error", (error: Error) => {
          response.writeHead(502, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: error.name }));
        });
        forwarded.end(raw);
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const body = raw === "" ? {} : JSON.parse(raw) as Record<string, unknown>;
      const args = typeof body.args === "object" && body.args !== null
        ? body.args as Record<string, unknown>
        : body;
      calls.push({ path: requestPath, body: args });
      const result = requestPath === "/check-availability"
        ? { available: true, day: "Tuesday", time: "9:40 AM" }
        : { recorded: true, day: "Tuesday", time: String(args.time ?? "9:40 AM"), reference: "retell-e2e-742" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (mockOrigin === undefined) {
      socket.destroy();
      return;
    }
    const target = new URL(request.url ?? "/", mockOrigin);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const headers: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!;
        if (name.toLowerCase() === "host") continue;
        headers.push(`${name}: ${request.rawHeaders[index + 1] ?? ""}`);
      }
      headers.push(`Host: ${target.host}`);
      if (request.headers.host !== undefined) headers.push(`X-Forwarded-Host: ${request.headers.host}`);
      headers.push("X-Forwarded-Proto: https");
      upstream.write(
        `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n` +
        `${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("callback server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    setMockOrigin(origin: string) { mockOrigin = origin; },
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
  target: Instance | string,
  method: string,
  route: string,
  options: { key?: string; cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; cookie: string }> {
  const origin = typeof target === "string" ? target : target.origin;
  const response = await fetch(`${origin}${route}`, {
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

function browserCookie(setCookie: string, publicOrigin: string): {
  name: string;
  value: string;
  url: string;
  secure: boolean;
} {
  const separator = setCookie.indexOf("=");
  if (separator <= 0) throw new Error("signup returned no session cookie");
  const name = setCookie.slice(0, separator);
  if (name.startsWith("__Secure-") && !publicOrigin.startsWith("https://")) {
    throw new Error("a __Secure session cookie needs the public HTTPS origin");
  }
  return {
    name,
    value: setCookie.slice(separator + 1),
    url: publicOrigin,
    secure: publicOrigin.startsWith("https://"),
  };
}

async function proveAuthenticatedBrowser(
  publicOrigin: string,
  sessionCookie: string,
  projectId: string,
  projectName: string,
): Promise<void> {
  const browser = await openBrowser();
  const consoleErrors: string[] = [];
  let pageUrl = publicOrigin;
  let title = "";
  let body = "";
  try {
    const context = await browser.newContext();
    await context.addCookies([browserCookie(sessionCookie, publicOrigin)]);
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const response = await page.goto(`${publicOrigin}/projects/${projectId}/agents`);
    pageUrl = page.url();
    title = await page.title();
    body = (await page.locator("body").innerText()).slice(0, 500);
    if (response === null || !response.ok()) {
      throw new Error(`the authenticated page answered ${String(response?.status())}`);
    }
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
    await page.locator('[data-slot="project-name"]', { hasText: projectName }).first().waitFor();
    expect(page.url()).toContain(`/projects/${projectId}/agents`);
  } catch (cause) {
    throw new Error(
      `public browser auth failed (${cause instanceof Error ? cause.message : "unknown"}); ` +
      `url=${pageUrl}; title=${title}; body=${body}; console=${consoleErrors.slice(0, 5).join(" | ")}`,
    );
  } finally {
    await browser.close();
  }
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
    let fixture: ChildProcess | undefined;
    let instance: Instance | undefined;
    let workers: ReturnType<typeof startFullPathWorkers> | undefined;
    let provisioned: {
      agentId: string;
      agentVersion: number;
      providerMetadata: Record<string, unknown>;
    } | undefined;
    let projectKey = "";
    let mainSucceeded = false;
    let diagnosticDetail: Record<string, unknown> | undefined;
    let diagnosticGrade: Record<string, unknown> | undefined;
    let diagnosticProviderCall: Record<string, unknown> | undefined;
    let diagnosticBrowser: {
      url: string;
      status: number | null;
      title: string;
      body: string;
    } | undefined;
    try {
      await waitForPublicTunnel(tunnel, "/_egma-fixture/health");
      instance = await startInstance(`retell_live_${CONNECTION}_${MOCKS ? "mock" : "real"}`, {
        baseUrl: tunnel.url,
        web: true,
        traces: true,
        providerKeys: { openai: MODEL_KEY },
        ingestStore: liveStorage().ingestStore,
        blob: liveStorage().store,
      });
      callback.setMockOrigin(instance.origin);
      const signup = await request(tunnel.url, "POST", "/api/signup", { body: {
        email: "retell-e2e@acme.example",
        password: "a-password-long-enough-1",
        organizationName: "Retell E2E",
      } });
      expect(signup.status, JSON.stringify(signup.body)).toBe(201);
      const sessionCookie = signup.cookie;
      const identity = signup.body as unknown as {
        userId: string;
        organization: { id: string };
        project: { id: string; name: string };
      };
      await proveAuthenticatedBrowser(
        tunnel.url,
        sessionCookie,
        identity.project.id,
        identity.project.name,
      );
      fixture = spawn(PYTHON, [path.join(REPOSITORY, "fixtures/simulation-e2e/retell_provider.py")], {
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
      provisioned = await waitForFile<{
        agentId: string;
        agentVersion: number;
        providerMetadata: Record<string, unknown>;
      }>(readyPath, fixture, () => fixtureOutput);
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
        recordingStore: liveStorage().writeStore,
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
        diagnosticDetail = detail.body;
        return { status: detail.body.status, gradingState: detail.body.gradingState };
      }, { timeout: 180_000, interval: 500 }).toEqual({ status: "completed", gradingState: "complete" });
      const storedGrades = await readTraceGrades(auth, {
        source: "simulation",
        traceId: traceIdOf(simulationId),
        runId,
      });
      expect(storedGrades.current).toHaveLength(1);
      const currentGrade = storedGrades.current[0];
      diagnosticGrade = currentGrade === undefined ? undefined : {
        result: currentGrade.result,
        score: currentGrade.score,
        passThreshold: currentGrade.graderPassThreshold,
        details: currentGrade.details,
      };
      const validGrade = assertValidGrade(storedGrades.current[0]!, detail!.body);
      const recorded = { recorded: true, day: "Tuesday", time: String(availability.time), reference: "retell-e2e-742" };
      const evidencePov = CONNECTION === "text" ? "persona" : "agent";
      const persistedAgentText = publicTranscript(detail!.body).turns.find((turn) =>
        turn.pov === evidencePov && turn.kind === "turn:agent" && turn.text?.trim() !== ""
      )?.text;
      expect(persistedAgentText).toBeDefined();
      const agentNeedle = String(persistedAgentText).replace(/\s+/gu, " ").trim().slice(0, 60).toLowerCase();
      assertPublicEvidence(detail!.body, {
        pov: evidencePov,
        humanIncludes: "tuesday",
        agentIncludes: agentNeedle,
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
        diagnosticProviderCall = await providerAnswer.json() as Record<string, unknown>;
        expectWebEvidenceToMatchRetell(detail!.body, diagnosticProviderCall);
      } else {
        // Text mode creates no provider call. The stored persona POV is the
        // platform API exchange itself, so prove that complete bounded sequence.
        expectCompleteTextModeExchange(detail!.body);
      }
      const browser = await openBrowser();
      try {
        const context = await browser.newContext();
        await context.addCookies([browserCookie(sessionCookie, tunnel.url)]);
        const page = await context.newPage();
        let pageStatus: number | null = null;
        try {
          const response = await page.goto(`${tunnel.url}/projects/${identity.project.id}/runs/${runId}`);
          pageStatus = response?.status() ?? null;
          await assertEvidencePage(page, {
            humanIncludes: "tuesday",
            agentIncludes: agentNeedle,
            recording: CONNECTION === "web",
            sourceLabel: CONNECTION === "text"
              ? "Conversation from the Retell API"
              : "Conversation from Retell",
            gradeResult: validGrade.result,
          });
        } catch (cause) {
          const shown = new URL(page.url());
          shown.search = "";
          shown.hash = "";
          diagnosticBrowser = {
            url: shown.toString(),
            status: pageStatus,
            title: await page.title().catch(() => "<unavailable>"),
            body: await page.locator("body").innerText().then(
              (text) => text.slice(0, 1_000),
              () => "<unavailable>",
            ),
          };
          throw cause;
        }
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
        outcomes: { simulation: "completed", grade: validGrade, browser: true },
      }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      mainSucceeded = true;
    } catch (error) {
      if (CONNECTION === "web" && diagnosticProviderCall === undefined) {
        const providerReference = diagnosticDetail?.providerReference;
        if (typeof providerReference === "string" && providerReference !== "") {
          try {
            const providerAnswer = await fetch(
              `https://api.retellai.com/v2/get-call/${encodeURIComponent(providerReference)}`,
              { headers: { authorization: `Bearer ${RETELL_KEY}` } },
            );
            if (providerAnswer.ok) {
              diagnosticProviderCall = await providerAnswer.json() as Record<string, unknown>;
            }
          } catch {
            // The other retained diagnostics still explain an unreachable provider read.
          }
        }
      }
      const secrets = [RETELL_KEY, MODEL_KEY, projectKey, callbackToken];
      const safe = redact(
        [fixtureOutput, workers?.output() ?? "", tunnel.output()].join("\n"),
        secrets,
      );
      await mkdir(proofDirectory, { recursive: true });
      await writeFile(
        path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.log`),
        safe,
        { encoding: "utf8", mode: 0o600 },
      );
      const diagnosticManifest = redact(
        JSON.stringify({
          commitSha: process.env["GITHUB_SHA"] ?? "local-working-tree",
          connection: CONNECTION,
          mocked: MOCKS,
          outcomes: {
            simulation: "failed",
            failureType: error instanceof Error ? error.name : "unknown",
          },
          ...(diagnosticDetail === undefined ? {} : { evidence: diagnosticDetail }),
          ...(diagnosticGrade === undefined ? {} : { grade: diagnosticGrade }),
          ...(diagnosticBrowser === undefined ? {} : { browser: diagnosticBrowser }),
          ...(diagnosticProviderCall === undefined ? {} : {
            providerCall: safeRetellProviderData(diagnosticProviderCall),
          }),
        }, null, 2),
        secrets,
      ) + "\n";
      await writeFile(
        path.join(proofDirectory, `retell-${CONNECTION}-${MOCKS ? "mocked" : "unmocked"}.json`),
        diagnosticManifest,
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
        if (fixture === undefined) return;
        await writeFile(stopPath, "stop\n", { encoding: "utf8", mode: 0o600 });
      });
      await clean(async () => {
        if (fixture !== undefined) await waitForChild(fixture, 60_000);
      });
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
