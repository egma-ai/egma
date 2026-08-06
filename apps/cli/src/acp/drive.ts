/**
 * Driving one task on the developer's own coding agent.
 *
 * The agent runs as a subprocess speaking the protocol over stdio. egma is the
 * client: it approves everything except a fenced file, streams every action it
 * is told about, and owns the subprocess from first byte to last — including
 * when the developer changes their mind halfway through.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type { WizardUI } from "../ui/wizard-ui.ts";
import { ActionStream, drivenAgentTextIn } from "../wizard/status.ts";
import { FENCE_MESSAGE, fenceStatusLine, fencedReferenceIn, isFenced } from "./fence.ts";
import { sessionMetaFor } from "./hardening.ts";
import { zeroPromptMode } from "./modes.ts";
import type { DrivenAgentLaunch } from "./registry.ts";

/** How the one task ended. */
export type DriveResult =
  | { readonly kind: "done"; readonly summary: string }
  | { readonly kind: "interrupted" }
  | { readonly kind: "needs-login"; readonly drivenAgentName: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DriveOptions = {
  readonly launch: DrivenAgentLaunch;
  readonly cwd: string;
  readonly instructions: string;
  readonly ui: WizardUI;
  /** Aborts the task and shuts the agent down. */
  readonly signal: AbortSignal;
  /** Where the agent's own noise goes. Omit to drop it. */
  readonly logStderr?: (chunk: string) => void;
};

/** JSON-RPC code the protocol reserves for "this agent is not logged in". */
const AUTH_REQUIRED = -32000;

/** How long a shut-down agent gets to leave before it is killed outright. */
const SHUTDOWN_GRACE_MS = 2_000;

class DrivenAgentProcess {
  private killed = false;
  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
  }

  /**
   * Ends the agent and everything it started.
   *
   * An adapter starts its own engine, so ending only the process egma spawned
   * leaves the engine behind. The subprocess is therefore started in its own
   * process group and the whole group is ended together.
   */
  shutDown(): void {
    if (this.killed) return;
    this.killed = true;
    const pid = this.child.pid;
    if (pid === undefined) return;

    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32") this.child.kill(signal);
        else process.kill(-pid, signal);
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    };

    signalGroup("SIGTERM");
    const hardStop = setTimeout(() => signalGroup("SIGKILL"), SHUTDOWN_GRACE_MS);
    hardStop.unref();
    this.child.once("exit", () => clearTimeout(hardStop));
  }
}

function start(launch: DrivenAgentLaunch, cwd: string, logStderr?: (chunk: string) => void) {
  const child = spawn(launch.command, [...launch.args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so the whole tree can be ended at once and so a
    // Ctrl-C aimed at the wizard does not race egma's own teardown.
    detached: process.platform !== "win32",
    env: { ...process.env, ...launch.env },
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => logStderr?.(chunk));

  return { child, handle: new DrivenAgentProcess(child) };
}

/**
 * The fence, at the one place both file methods reach it: the developer is
 * told, and the agent is sent elsewhere with the same words either way.
 */
function refuseFencedFile(target: string, ui: WizardUI): void {
  if (!isFenced(target)) return;
  ui.pushStatus(fenceStatusLine(path.basename(target)));
  throw new acp.RequestError(-32602, FENCE_MESSAGE);
}

function readTextFileHandler(cwd: string, ui: WizardUI) {
  return async (params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> => {
    refuseFencedFile(params.path, ui);
    const target = path.resolve(cwd, params.path);
    const whole = await readFile(target, "utf8");
    const line = params.line ?? null;
    const limit = params.limit ?? null;
    if (line === null && limit === null) return { content: whole };

    const lines = whole.split("\n");
    const from = Math.max((line ?? 1) - 1, 0);
    const to = limit === null ? lines.length : from + limit;
    return { content: lines.slice(from, to).join("\n") };
  };
}

function writeTextFileHandler(cwd: string, ui: WizardUI) {
  return async (params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> => {
    refuseFencedFile(params.path, ui);
    await writeFile(path.resolve(cwd, params.path), params.content, "utf8");
    return {};
  };
}

/**
 * The second belt: every permission request is approved, except one.
 *
 * The agent already runs in its most permissive mode, so few requests arrive at
 * all — but an adapter honours the developer's own local settings, and some of
 * those force a question through anyway. Answering them all is what makes zero
 * questions certain rather than likely.
 */
function permissionHandler(ui: WizardUI) {
  return (params: acp.RequestPermissionRequest): acp.RequestPermissionResponse => {
    const fenced = fencedReferenceIn(params.toolCall);
    const options = params.options;

    if (fenced !== null) {
      ui.pushStatus(fenceStatusLine(fenced));
      const refusal =
        options.find((option) => option.kind === "reject_once") ??
        options.find((option) => option.kind === "reject_always");
      if (refusal !== undefined) {
        return { outcome: { outcome: "selected", optionId: refusal.optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    }

    const approval =
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => option.kind === "allow_once") ??
      options[0];
    if (approval === undefined) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: approval.optionId } };
  };
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof acp.RequestError && error.code === AUTH_REQUIRED;
}

function reasonFrom(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/** Runs one task on the agent and returns how it ended. Never throws. */
export async function driveOneTask(options: DriveOptions): Promise<DriveResult> {
  const { launch, cwd, instructions, ui, signal } = options;

  if (signal.aborted) return { kind: "interrupted" };

  const { child, handle } = start(launch, cwd, options.logStderr);

  let interrupted = false;
  const onAbort = (): void => {
    interrupted = true;
    handle.shutDown();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) {
      return { kind: "failed", reason: `egma could not talk to ${launch.name}.` };
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    );

    const summary = await acp
      .client({ name: "egma" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        permissionHandler(ui)(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) =>
        readTextFileHandler(cwd, ui)(ctx.params),
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) =>
        writeTextFileHandler(cwd, ui)(ctx.params),
      )
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            // Reading and writing through egma is what puts the fence in the
            // path of a file the agent asks for.
            fs: { readTextFile: true, writeTextFile: true },
          },
        });

        const meta = sessionMetaFor(launch.id);
        const request: acp.NewSessionRequest = {
          cwd,
          mcpServers: [],
          ...(meta === null ? {} : { _meta: meta }),
        };

        return ctx.buildSession(request).withSession(async (session) => {
          // The first belt: start in the most permissive mode the agent offers,
          // so most requests are never raised at all.
          const mode = zeroPromptMode(session.modes);
          if (mode !== null) {
            await ctx.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: mode,
            });
          }

          const turn = session.prompt(instructions);
          turn.catch(() => undefined);

          const actions = new ActionStream(cwd);
          let spoken = "";
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") return spoken.trim();
            for (const line of actions.lines(message.update)) ui.pushStatus(line);
            spoken += drivenAgentTextIn(message.update);
          }
        });
      });

    if (interrupted) return { kind: "interrupted" };
    return { kind: "done", summary };
  } catch (error) {
    if (interrupted) return { kind: "interrupted" };
    if (isAuthRequired(error)) return { kind: "needs-login", drivenAgentName: launch.name };
    return { kind: "failed", reason: reasonFrom(error) };
  } finally {
    signal.removeEventListener("abort", onAbort);
    handle.shutDown();
  }
}
