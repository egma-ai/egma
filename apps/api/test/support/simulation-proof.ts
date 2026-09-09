import { loadIngestionSettings } from "@egma/ingestion";
import { spawn, type ChildProcess } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { isDeepStrictEqual } from "node:util";
import type { Page } from "playwright-core";
import { expect } from "vitest";

import { makeLog } from "../../../grader/src/log.ts";
import { startService } from "../../../grader/src/service.ts";
import type { BlobStore } from "../../src/recordings/signed-link.ts";

export function quickTunnelUrl(output: string): string | undefined {
  if (!output.includes("Your quick Tunnel has been created!")) return undefined;
  return [...output.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gu)]
    .find((match) => match[1] !== "api")?.[0];
}

const PUBLIC_TUNNEL_READY_MILLISECONDS = 60_000;

export async function startPublicTunnel(localUrl: string): Promise<{
  process: ChildProcess;
  url: string;
  output: () => string;
}> {
  const child = spawn(
    process.env["SIMULATION_E2E_CLOUDFLARED"] ?? "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", localUrl],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let said = "";
  child.stdout?.on("data", (piece: Buffer) => { said += piece.toString("utf8"); });
  child.stderr?.on("data", (piece: Buffer) => { said += piece.toString("utf8"); });
  const deadline = Date.now() + PUBLIC_TUNNEL_READY_MILLISECONDS;
  for (;;) {
    const found = quickTunnelUrl(said);
    if (found !== undefined) return { process: child, url: found, output: () => said };
    if (child.exitCode !== null) {
      throw new Error(`cloudflared exited with ${String(child.exitCode)}:\n${said}`);
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`cloudflared did not publish a URL within 60s:\n${said}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait until the published hostname resolves and reaches the fixture server. */
export async function waitForPublicTunnel(
  tunnel: { process: ChildProcess; url: string; output: () => string },
  healthPath: string,
): Promise<void> {
  const deadline = Date.now() + PUBLIC_TUNNEL_READY_MILLISECONDS;
  let lastFailure: unknown;

  const hostname = new URL(tunnel.url).hostname;
  if (!hostname.endsWith(".trycloudflare.com")) {
    throw new Error("the quick tunnel URL is outside trycloudflare.com");
  }
  const discovery = new Resolver({ timeout: 2_000, tries: 1 });
  const names = await discovery.resolveNs("trycloudflare.com");
  const addresses = (await Promise.all(names.map(async (name) =>
    await discovery.resolve4(name)
  ))).flat();
  if (addresses.length === 0) {
    throw new Error("trycloudflare.com has no reachable authoritative nameserver");
  }
  const authoritative = new Resolver({ timeout: 2_000, tries: 1 });
  authoritative.setServers(addresses);
  for (;;) {
    if (tunnel.process.exitCode !== null) {
      throw new Error(`cloudflared exited before publishing DNS:\n${tunnel.output()}`);
    }
    try {
      if ((await authoritative.resolve4(hostname)).length > 0) break;
    } catch (cause) {
      lastFailure = cause;
    }
    if (Date.now() > deadline) {
      throw new Error(
        "the public tunnel was not published by its authoritative DNS within 60s",
        { cause: lastFailure },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  for (;;) {
    if (tunnel.process.exitCode !== null) {
      throw new Error(`cloudflared exited before its public URL was reachable:\n${tunnel.output()}`);
    }
    let response: Response | undefined;
    try {
      response = await fetch(`${tunnel.url}${healthPath}`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (cause) {
      // DNS publication, edge routing, and the connector can settle separately.
      lastFailure = cause;
    }
    if (response !== undefined) {
      if (response.status === 204) return;
      if (response.status < 500) {
        throw new Error(
          `the public tunnel health route answered HTTP ${response.status}`,
        );
      }
      lastFailure = new Error(
        `the public tunnel health route answered HTTP ${response.status}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        "the public tunnel did not become reachable within 60s",
        { cause: lastFailure },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

/** Wait for a fixture's own cleanup and fail on timeout or an unsuccessful exit. */
export async function waitForChild(
  child: ChildProcess,
  timeoutMilliseconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`fixture did not exit within ${timeoutMilliseconds}ms`));
          }, timeoutMilliseconds);
        }),
      ]);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (child.exitCode !== 0) {
    throw new Error(
      child.signalCode === null
        ? `fixture exited with ${String(child.exitCode)}`
        : `fixture exited after ${child.signalCode}`,
    );
  }
}

export function startFullPathWorkers(options: {
  readonly apiOrigin: string;
  readonly serviceToken: string;
  readonly claimant: string;
  readonly simulatorDirectory: string;
  readonly walDirectory: string;
  readonly recordingStore: BlobStore;
  readonly modelKey: string;
}): {
  readonly simulator: ChildProcess;
  readonly output: () => string;
  stop(): Promise<void>;
} {
  let output = "";
  const simulator = spawn("uv", ["run", "--frozen", "python", "-m", "egma_simulator"], {
    cwd: options.simulatorDirectory,
    env: {
      ...process.env,
      EGMA_SIMULATOR_CONTROL_PLANE_URL: options.apiOrigin,
      EGMA_SIMULATOR_SERVICE_TOKEN: options.serviceToken,
      EGMA_SIMULATOR_CLAIMANT: `${options.claimant}-simulator`,
      EGMA_SIMULATOR_CLAIM_WAIT_SECONDS: "2",
      EGMA_SIMULATOR_HEARTBEAT_SECONDS: "1",
      EGMA_SIMULATOR_WAL_DIR: options.walDirectory,
      EGMA_SIMULATOR_S3_ENDPOINT: options.recordingStore.publicUrl,
      EGMA_SIMULATOR_S3_BUCKET: options.recordingStore.bucket,
      EGMA_SIMULATOR_S3_REGION: options.recordingStore.region,
      EGMA_SIMULATOR_S3_ACCESS_KEY_ID: options.recordingStore.accessKeyId,
      EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY: options.recordingStore.secretAccessKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  simulator.stdout?.on("data", (piece: Buffer) => { output += piece.toString("utf8"); });
  simulator.stderr?.on("data", (piece: Buffer) => { output += piece.toString("utf8"); });
  const grader = startService({
    config: {
      ingestion: loadIngestionSettings({}, { role: "ingest" }),
      databaseUrl: "",
      clickhouseUrl: "",
      claimant: `${options.claimant}-grader`,
      stripeSecretKey: undefined,
      capacity: 1,
      concurrencyCap: undefined,
      heartbeatSeconds: 1,
      leaseSeconds: 3_600,
      sweepSeconds: 1,
      logLevel: "ERROR",
    },
    log: makeLog("ERROR", `${options.claimant}-grader`),
    providerCredentials: { async load() { return { openai: options.modelKey }; } },
  });
  return {
    simulator,
    output: () => output,
    async stop() {
      const stopped = stopChild(simulator);
      grader.stop();
      await grader.finished;
      await stopped;
    },
  };
}

type EvidenceSpan = {
  readonly spanId?: string;
  readonly startedAt?: string;
  readonly kind?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolArguments?: string;
  readonly toolResult?: string;
  readonly toolProvenance?: string;
  readonly pov?: string;
  readonly spans?: readonly EvidenceSpan[];
};

export type ExpectedTool = {
  readonly name: string;
  readonly arguments: unknown;
  readonly result: unknown;
  readonly provenance?: "mocked";
};

function flatten(spans: readonly EvidenceSpan[]): EvidenceSpan[] {
  return spans.flatMap((span) => [span, ...flatten(span.spans ?? [])]);
}

function decode(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  let decoded: unknown = value;
  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth += 1) {
    try { decoded = JSON.parse(decoded) as unknown; } catch { break; }
  }
  return decoded;
}

/** Assert the provider POV that the product displays, including exact tools. */
export function assertPublicEvidence(
  body: Record<string, unknown>,
  expected: {
    readonly pov: "agent" | "persona";
    readonly humanIncludes: string;
    readonly agentIncludes: string;
    readonly tools: readonly ExpectedTool[];
    readonly recording: boolean;
  },
): void {
  expect(body).toMatchObject({
    status: "completed",
    gradingState: "complete",
    ...(expected.pov === "agent" ? { agentPovComplete: true } : {}),
    hasRecording: expected.recording,
  });
  const transcript = body.transcript as {
    turns?: EvidenceSpan[];
    spans?: EvidenceSpan[];
  };
  const turns = (transcript.turns ?? []).filter((turn) => turn.pov === expected.pov);
  expect(turns.length).toBeGreaterThanOrEqual(2);
  expect(turns.every((turn) => (turn.text?.trim().length ?? 0) > 0)).toBe(true);
  const identities = turns.map((turn) => turn.spanId);
  expect(identities.every((identity) => typeof identity === "string" && identity !== "")).toBe(true);
  expect(new Set(identities).size).toBe(identities.length);
  expect(turns.every((turn, index) =>
    index === 0 || Date.parse(turn.startedAt ?? "") >= Date.parse(turns[index - 1]?.startedAt ?? "")
  )).toBe(true);
  expect(turns.some((turn) =>
    turn.kind === "turn:human" && turn.text?.toLowerCase().includes(expected.humanIncludes)
  )).toBe(true);
  expect(turns.some((turn) =>
    turn.kind === "turn:agent" && turn.text?.toLowerCase().includes(expected.agentIncludes)
  )).toBe(true);

  const tools = flatten([
    ...(transcript.spans ?? []),
    ...turns.flatMap((turn) => turn.spans ?? []),
  ]).filter((span) => span.kind === "tool" && span.pov === expected.pov);
  for (const wanted of expected.tools) {
    const calls = tools.filter((span) =>
      span.toolName === wanted.name &&
      isDeepStrictEqual(decode(span.toolArguments), wanted.arguments)
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      expect(decode(call.toolArguments)).toEqual(wanted.arguments);
      expect(decode(call.toolResult)).toEqual(wanted.result);
      expect(call.toolProvenance).toBe(wanted.provenance);
    }
  }
}

/** Assert the same completed evidence through its customer-facing page. */
export async function assertEvidencePage(
  page: Page,
  expected: {
    readonly humanIncludes: string;
    readonly agentIncludes: string;
    readonly recording: boolean;
    readonly sourceLabel: string;
    readonly gradeResult: "passed" | "failed";
  },
): Promise<void> {
  const results = page.getByRole("tab", { name: "Results summary", exact: true });
  await results.waitFor();
  await results.click();
  const resultPanel = page.getByRole("tabpanel");
  await expect.poll(() => resultPanel.innerText()).toContain("Graders");
  expect(await resultPanel.innerText()).toContain(
    expected.gradeResult === "passed" ? "Passed" : "Failed",
  );

  const transcript = page.getByRole("tab", {
    name: expected.recording ? "Transcript & audio" : "Transcript",
    exact: true,
  });
  await transcript.click();
  const transcriptPanel = page.getByRole("tabpanel");
  const shown = await transcriptPanel.innerText();
  expect(shown).toContain("User");
  expect(shown).toContain("Agent");
  expect(shown).toContain(expected.sourceLabel);
  expect(shown.toLowerCase()).toContain(expected.humanIncludes);
  expect(shown.toLowerCase()).toContain(expected.agentIncludes);
  expect(shown).not.toContain("LiveKit transcript unavailable");
  if (expected.recording) {
    const player = transcriptPanel.getByLabel("Simulation recording");
    await player.waitFor({ state: "attached" });
    expect(await player.getAttribute("src")).toContain("X-Amz-Signature=");
    await player.evaluate((element) => {
      (element as unknown as { load(): void }).load();
    });
    await expect.poll(async () => player.evaluate((element) => {
      const media = element as unknown as {
        readyState: number;
        duration: number;
        error: unknown;
      };
      return {
        ready: media.readyState >= 1,
        finiteDuration: Number.isFinite(media.duration) && media.duration > 0,
        noError: media.error === null,
      };
    }), { timeout: 15_000 }).toEqual({
      ready: true,
      finiteDuration: true,
      noError: true,
    });
  }
}

export function assertValidGrade(
  stored: {
    readonly result: "passed" | "failed" | "errored";
    readonly score: number | null;
    readonly graderPassThreshold: number;
    readonly details: Readonly<Record<string, unknown>>;
  },
  publicEvidence: Record<string, unknown>,
): { readonly result: "passed" | "failed"; readonly score: number } {
  expect(["passed", "failed"]).toContain(stored.result);
  expect(stored.details.error).toBeUndefined();
  expect(typeof stored.score).toBe("number");
  const score = stored.score as number;
  expect(Number.isFinite(score)).toBe(true);
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(1);
  expect(Number.isFinite(stored.graderPassThreshold)).toBe(true);
  expect(stored.graderPassThreshold).toBeGreaterThanOrEqual(0);
  expect(stored.graderPassThreshold).toBeLessThanOrEqual(1);
  expect(stored.result).toBe(
    score >= stored.graderPassThreshold ? "passed" : "failed",
  );
  const publicGrades = publicEvidence.grades as Array<Record<string, unknown>>;
  expect(publicGrades).toHaveLength(1);
  expect(publicGrades[0]).toMatchObject({
    result: stored.result,
    score,
    passThreshold: stored.graderPassThreshold,
  });
  return { result: stored.result as "passed" | "failed", score };
}
