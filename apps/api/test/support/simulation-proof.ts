import { loadIngestionSettings } from "@egma/ingestion";
import { spawn, type ChildProcess } from "node:child_process";
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
const QUICK_TUNNEL_ATTEMPTS = 3;
type TunnelLaunch = (
  command: string,
  arguments_: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

type NamedTunnelSettings = {
  readonly id: string;
  readonly url: string;
  readonly credentialsFile: string;
};

export function namedTunnelSettings(
  env: NodeJS.ProcessEnv = process.env,
): NamedTunnelSettings | undefined {
  const values = {
    id: env["SIMULATION_E2E_TUNNEL_ID"]?.trim() ?? "",
    url: env["SIMULATION_E2E_TUNNEL_URL"]?.trim() ?? "",
    credentialsFile: env["SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE"]?.trim() ?? "",
  };
  const configured = Object.values(values).filter((value) => value !== "").length;
  if (configured === 0) return undefined;
  if (configured !== 3) {
    throw new Error(
      "a named simulation tunnel requires SIMULATION_E2E_TUNNEL_ID, " +
      "SIMULATION_E2E_TUNNEL_URL, and SIMULATION_E2E_TUNNEL_CREDENTIALS_FILE",
    );
  }
  let address: URL;
  try {
    address = new URL(values.url);
  } catch {
    throw new Error("SIMULATION_E2E_TUNNEL_URL must be an HTTPS origin");
  }
  if (address.protocol !== "https:" || address.pathname !== "/" ||
      address.search !== "" || address.hash !== "" ||
      address.username !== "" || address.password !== "") {
    throw new Error("SIMULATION_E2E_TUNNEL_URL must be an HTTPS origin");
  }
  return { ...values, url: address.origin };
}

export async function startPublicTunnel(localUrl: string, dependencies: {
  readonly env?: NodeJS.ProcessEnv;
  readonly launch?: TunnelLaunch;
  readonly now?: () => number;
  readonly pause?: (milliseconds: number) => Promise<void>;
} = {}): Promise<{
  process: ChildProcess;
  url: string;
  output: () => string;
}> {
  const env = dependencies.env ?? process.env;
  const named = namedTunnelSettings(env);
  const launch = dependencies.launch ?? ((command, arguments_, options) =>
    spawn(command, arguments_, options));
  const pause = dependencies.pause ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const deadline = now() + PUBLIC_TUNNEL_READY_MILLISECONDS;
  const failed: string[] = [];
  const timedOut = (said = "") => new Error(
    `cloudflared did not publish a URL within 60s:\n${[...failed, said].join("\n")}`,
  );
  const pauseBeforeDeadline = async (milliseconds: number, said = "") => {
    const remaining = deadline - now();
    if (remaining <= 0) throw timedOut(said);
    await pause(Math.min(milliseconds, remaining));
  };
  const attempts = named === undefined ? QUICK_TUNNEL_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (now() >= deadline) throw timedOut();
    const child = launch(
      env["SIMULATION_E2E_CLOUDFLARED"] ?? "cloudflared",
      named === undefined
        ? ["tunnel", "--no-autoupdate", "--url", localUrl]
        : [
            "tunnel",
            "--no-autoupdate",
            "--url",
            localUrl,
            "run",
            "--credentials-file",
            named.credentialsFile,
            named.id,
          ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let said = "";
    child.stdout?.on("data", (piece: Buffer) => { said += piece.toString("utf8"); });
    child.stderr?.on("data", (piece: Buffer) => { said += piece.toString("utf8"); });
    // The close event follows process exit and completion of its stdio streams.
    const closed = child.exitCode !== null &&
      (child.stdout === null || child.stdout.readableEnded) &&
      (child.stderr === null || child.stderr.readableEnded)
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve()));
    if (named !== undefined) {
      return { process: child, url: named.url, output: () => said };
    }
    for (;;) {
      const found = quickTunnelUrl(said);
      if (found !== undefined) {
        return {
          process: child,
          url: found,
          output: () => [...failed, said].join("\n"),
        };
      }
      if (child.exitCode !== null) {
        await closed;
        failed.push(
          `quick tunnel attempt ${attempt} exited with ${String(child.exitCode)}:\n${said}`,
        );
        await stopChild(child);
        if (attempt === attempts) {
          throw new Error(
            `cloudflared exited before publishing a URL after ${attempts} attempts:\n${failed.join("\n")}`,
          );
        }
        await pauseBeforeDeadline(250 * 2 ** (attempt - 1));
        break;
      }
      if (now() >= deadline) {
        child.kill("SIGTERM");
        throw timedOut(said);
      }
      await pauseBeforeDeadline(100, said);
    }
  }
  throw new Error("cloudflared did not start");
}

/** Wait until the public tunnel reaches the fixture server. */
export async function waitForPublicTunnel(
  tunnel: { process: ChildProcess; url: string; output: () => string },
  healthPath: string,
): Promise<void> {
  const deadline = Date.now() + PUBLIC_TUNNEL_READY_MILLISECONDS;
  let lastFailure: unknown;

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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
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
  const humanNeedle = comparableText(expected.humanIncludes);
  const agentNeedle = comparableText(expected.agentIncludes);
  expect(turns.some((turn) =>
    turn.kind === "turn:human" && comparableText(turn.text ?? "").includes(humanNeedle)
  )).toBe(true);
  expect(turns.some((turn) =>
    turn.kind === "turn:agent" && comparableText(turn.text ?? "").includes(agentNeedle)
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
  expect(comparableText(shown)).toContain(comparableText(expected.humanIncludes));
  expect(comparableText(shown)).toContain(comparableText(expected.agentIncludes));
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
