/**
 * Driving the wizard's turns through one coding-agent process and ACP session.
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
import type { DrivenAgentLaunch } from "./coding-agents.ts";

/** How one turn with the coding agent ended. */
export type DriveResult =
  | { readonly kind: "done"; readonly summary: string }
  /** The agent said it could not go on, and egma ended the task on that word. */
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "interrupted" }
  /** egma could not start this coding agent, or it does not speak the protocol. */
  | { readonly kind: "unreachable"; readonly reason: string }
  | { readonly kind: "needs-login"; readonly drivenAgentName: string }
  | { readonly kind: "failed"; readonly reason: string };

export type DrivenAgentTurn = {
  readonly instructions: string;
  /**
   * Sees the coding agent's own words as they arrive, in order. Answer a reason
   * to end this turn now, or `null` to let it carry on.
   */
  readonly watch?: (text: string) => string | null;
};

/** One coding agent and one ACP session, kept for the wizard's whole flow. */
export interface DrivenAgent {
  readonly id: string;
  readonly name: string;
  run(turn: DrivenAgentTurn): Promise<DriveResult>;
}

export type DrivenAgentOptions = {
  readonly launch: DrivenAgentLaunch;
  readonly cwd: string;
  readonly ui: WizardUI;
  /** Aborts the flow and shuts the agent down. */
  readonly signal: AbortSignal;
  /** Where the agent's own noise goes. Omit to drop it. */
  readonly logStderr?: (chunk: string) => void;
  /** Told when the coding agent has to log in before egma can drive it. */
  readonly onLogin?: (drivenAgentName: string) => void;
};

/** JSON-RPC code the protocol reserves for "this agent is not logged in". */
const AUTH_REQUIRED = -32000;

/** How long a shut-down agent gets to leave before it is killed outright. */
const SHUTDOWN_GRACE_MS = 2_000;

/** How long a cancelled turn gets to acknowledge the protocol cancellation. */
const CANCEL_GRACE_MS = 2_000;

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

/**
 * Why the agent never got as far as speaking the protocol.
 *
 * A command that is not on this machine, and a command that is but exits
 * immediately, look the same from here and mean the same thing: there is no
 * coding agent at the other end of this. It is held rather than thrown because
 * it happens off to one side of the request egma is waiting on.
 */
type Startup = { failure: string | null };

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

  const startup: Startup = { failure: null };
  child.once("error", (error: Error) => {
    startup.failure ??= error.message;
  });
  child.once("exit", (code) => {
    startup.failure ??= `it stopped straight away${code === null ? "" : ` (exit ${code})`}`;
  });

  return { child, handle: new DrivenAgentProcess(child), startup };
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

function extensionParams(params: unknown): Record<string, unknown> {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  throw new acp.RequestError(-32602, "Cursor sent invalid extension parameters.");
}

const CURSOR_QUESTION_SKIPPED = "Egma owns this wizard's questions.";
const CURSOR_PLAN_REJECTED = "Egma does not need a separate plan approval.";

/**
 * The login egma can hand the developer to.
 *
 * A coding agent advertises how it wants to be logged in. Some of those ways
 * are the agent's own — it opens its own browser page, or runs its own
 * command — and those are the ones egma can hand off to and then carry on from.
 * A method that asks for an environment variable is not a handoff: egma would
 * have to collect a secret it has no business holding, so it is left alone and
 * the developer is told to log in themselves.
 */
function ownLoginMethod(response: acp.InitializeResponse): string | null {
  for (const method of response.authMethods ?? []) {
    const kind = (method as { type?: string }).type;
    if (kind === undefined || kind === "terminal") return method.id;
  }
  return null;
}

function reasonFrom(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

function after<T>(milliseconds: number, answer: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(answer), milliseconds);
    timer.unref();
  });
}

/** A driver that gives every turn the same startup failure. */
function unavailable(launch: DrivenAgentLaunch, result: DriveResult): DrivenAgent {
  return {
    id: launch.id,
    name: launch.name,
    run: () => Promise.resolve(result),
  };
}

/**
 * Keep one coding-agent process and one ACP session for the supplied work.
 *
 * The callback may send several turns. They all share the coding agent's
 * context, mode, permissions and working folder. Process and session lifetime
 * are hidden here, so no wizard step can accidentally start a second context.
 */
export async function withDrivenAgent<T>(
  options: DrivenAgentOptions,
  use: (agent: DrivenAgent) => Promise<T>,
): Promise<T> {
  const { launch, cwd, ui, signal } = options;
  if (signal.aborted) return use(unavailable(launch, { kind: "interrupted" }));

  const { child, handle, startup } = start(launch, cwd, options.logStderr);
  let reached = false;
  let handedToWizard = false;
  let wizardFinished = false;
  let wizardAnswer!: T;
  let wizardWork: Promise<T> | null = null;
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
      return use(
        unavailable(launch, {
          kind: "failed",
          reason: `Egma could not talk to ${launch.name}.`,
        }),
      );
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
    );

    return await acp
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
      // Cursor can block a prompt on either extension. Egma owns the wizard's
      // questions and does not run Cursor in plan mode, so both get an explicit
      // answer instead of leaving the session waiting forever.
      .onRequest("cursor/ask_question", extensionParams, () => ({
        outcome: { outcome: "skipped", reason: CURSOR_QUESTION_SKIPPED },
      }))
      .onRequest("cursor/create_plan", extensionParams, () => ({
        outcome: { outcome: "rejected", reason: CURSOR_PLAN_REJECTED },
      }))
      .onNotification("cursor/update_todos", extensionParams, () => undefined)
      .onNotification("cursor/task", extensionParams, () => undefined)
      .onNotification("cursor/generate_image", extensionParams, () => undefined)
      .connectWith(stream, async (ctx) => {
        const greeting = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });
        reached = true;

        const meta = sessionMetaFor(launch.id);
        const request: acp.NewSessionRequest = {
          cwd,
          mcpServers: [],
          ...(meta === null ? {} : { _meta: meta }),
        };

        const useSession = async (): Promise<T> =>
          ctx.buildSession(request).withSession(async (session) => {
            const mode = zeroPromptMode(session.modes);
            if (mode !== null) {
              await ctx.request(acp.methods.agent.session.setMode, {
                sessionId: session.sessionId,
                modeId: mode,
              });
            }

            let running = false;
            let usable = true;
            const agent: DrivenAgent = {
              id: launch.id,
              name: launch.name,
              run: async (turn): Promise<DriveResult> => {
                if (signal.aborted || interrupted) return { kind: "interrupted" };
                if (!usable) {
                  return {
                    kind: "failed",
                    reason: `${launch.name}'s ACP session stopped. Run Egma again to start a new context.`,
                  };
                }
                if (running) {
                  return {
                    kind: "failed",
                    reason: `Egma tried to give ${launch.name} two tasks at once.`,
                  };
                }

                running = true;
                try {
                  const prompt = session.prompt(turn.instructions);
                  prompt.catch(() => undefined);

                  const actions = new ActionStream(cwd);
                  let spoken = "";
                  let stoppedBecause: string | null = null;
                  for (;;) {
                    const next = session.nextUpdate();
                    const message =
                      stoppedBecause === null
                        ? await next
                        : await Promise.race([
                            next,
                            after(CANCEL_GRACE_MS, { kind: "cancel-timeout" } as const),
                          ]);

                    if (message.kind === "cancel-timeout") {
                      usable = false;
                      handle.shutDown();
                      return {
                        kind: "failed",
                        reason: `${launch.name} did not stop after Egma cancelled its task. Run Egma again to start a new context.`,
                      };
                    }
                    if (message.kind === "stop") {
                      return stoppedBecause === null
                        ? { kind: "done", summary: spoken.trim() }
                        : { kind: "aborted", reason: stoppedBecause };
                    }

                    for (const line of actions.lines(message.update)) ui.pushStatus(line);
                    const said = drivenAgentTextIn(message.update);
                    if (said === "") continue;
                    spoken += said;

                    if (stoppedBecause !== null) continue;
                    const reason = turn.watch?.(said) ?? null;
                    if (reason === null) continue;
                    stoppedBecause = reason;
                    await ctx
                      .notify(acp.methods.agent.session.cancel, {
                        sessionId: session.sessionId,
                      })
                      .catch(() => undefined);
                  }
                } catch (error) {
                  if (interrupted || signal.aborted) return { kind: "interrupted" };
                  usable = false;
                  if (isAuthRequired(error)) {
                    return { kind: "needs-login", drivenAgentName: launch.name };
                  }
                  return { kind: "failed", reason: reasonFrom(error) };
                } finally {
                  running = false;
                }
              },
            };

            handedToWizard = true;
            wizardWork = use(agent);
            const answer = await wizardWork;
            wizardAnswer = answer;
            wizardFinished = true;
            return answer;
          });

        try {
          return await useSession();
        } catch (error) {
          if (!isAuthRequired(error)) throw error;
          const method = ownLoginMethod(greeting);
          if (method === null) throw error;
          options.onLogin?.(launch.name);
          await ctx.request(acp.methods.agent.authenticate, { methodId: method });
          // The refused request created no session and carried no task. After
          // login this retry creates the one successful session that receives
          // every wizard turn.
          return useSession();
        }
      });
  } catch (error) {
    // An error after the callback began belongs to the wizard, not to ACP
    // startup. Preserve it instead of turning a platform fault into an agent
    // fault.
    // A global stop ends the whole process group immediately. The SDK can then
    // report that closed pipe while it tears the already-finished session
    // down. The wizard's own interrupted result is the useful answer; the
    // teardown error is only a consequence of honoring Ctrl-C.
    if (handedToWizard && interrupted) {
      if (wizardFinished) return wizardAnswer;
      if (wizardWork !== null) {
        try {
          return await wizardWork;
        } catch {
          // The original ACP close below is the more useful failure.
        }
      }
    }
    if (handedToWizard) throw error;
    const result: DriveResult = interrupted
      ? { kind: "interrupted" }
      : !reached
        ? { kind: "unreachable", reason: startup.failure ?? reasonFrom(error) }
        : isAuthRequired(error)
          ? { kind: "needs-login", drivenAgentName: launch.name }
          : { kind: "failed", reason: reasonFrom(error) };
    return use(unavailable(launch, result));
  } finally {
    signal.removeEventListener("abort", onAbort);
    handle.shutDown();
  }
}
