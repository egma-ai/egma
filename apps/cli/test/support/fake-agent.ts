/**
 * A scripted coding agent, for tests.
 *
 * It is a real subprocess speaking the real protocol over stdio — the same wire
 * egma drives Claude Code and Codex over — and it does exactly what its script
 * says, in order, every time. No model, no network, no clock to wait on.
 *
 * Run it as `node fake-agent.ts <script.json>`. Everything it observes that a
 * test might want to assert on is written to a file in the working folder, so
 * tests assert on what landed rather than on what happened inside egma.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

type Location = { path: string };

export type FakeStep =
  | { kind: "say"; text: string }
  | {
      kind: "tool-call";
      id: string;
      title: string;
      toolKind?: acp.ToolKind;
      locations?: Location[];
      /** The arguments the call carries — a terminal call's command lives here. */
      rawInput?: Record<string, unknown>;
    }
  | { kind: "tool-call-update"; id: string; status: acp.ToolCallStatus; title?: string }
  | {
      kind: "ask-permission";
      id: string;
      title: string;
      toolKind?: acp.ToolKind;
      locations?: Location[];
      rawInput?: Record<string, unknown>;
      recordAs: string;
    }
  | { kind: "read-file"; path: string; recordAs: string }
  | { kind: "write-file"; path: string; content: string; recordAs?: string }
  /** Noise on standard error, the way a real agent writes its own progress. */
  | { kind: "grumble"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "stop"; reason: acp.StopReason };

export type FakeScript = {
  /** Modes the agent claims to offer, so the mode belt has something to set. */
  modes?: acp.SessionModeState;
  /** Start a long-running child, to prove egma ends the whole tree. */
  spawnChild?: boolean;
  /** Where the record of what happened is written, relative to the folder. */
  reportFile?: string;
  /**
   * Refuse the first session with "log in first", the way a cold machine does,
   * and work normally once the client has authenticated. The login methods the
   * agent advertises; omit for the ordinary one it runs itself.
   */
  authRequiredUntilLogin?: { methods?: acp.AuthMethod[] };
  steps: FakeStep[];
  /**
   * Steps to play instead when the session's folder contains this fragment.
   * A repository whose prompts live somewhere else is two folders and two
   * answers, and one scripted agent has to give both.
   */
  stepsByFolder?: { contains: string; steps: FakeStep[] }[];
  /**
   * Steps to play instead when the instructions contain this fragment.
   *
   * One walk sends the same agent several tasks in the same folder — find the
   * voice agent, turn what the developer already had into files, write the
   * rest — and a scripted agent has to answer each of them differently. The
   * fragment is matched against the task egma actually sent, so a check says
   * which task it is scripting rather than counting turns.
   */
  stepsByTask?: { contains: string; steps: FakeStep[] }[];
};

const DEFAULT_REPORT_FILE = "fake-agent-report.json";

function loadScript(): FakeScript {
  const file = process.argv[2];
  if (file === undefined) throw new Error("the fake agent needs a script file");
  return JSON.parse(readFileSync(file, "utf8")) as FakeScript;
}

type Report = {
  protocolVersion: number | null;
  clientCapabilities: unknown;
  modeSetTo: string | null;
  observations: Record<string, unknown>;
  childPid: number | null;
  /** Every set of instructions the client sent, in order. */
  instructions: string[];
  /** The folder of each session the client opened, in order. */
  folders: string[];
  /** Which login method the client picked, if it had to log in at all. */
  loggedInWith: string | null;
};

/**
 * The report this run adds to, which may already have somebody else's in it.
 *
 * One walk dispatches several tasks and each one starts a fresh agent, so a
 * report that began empty every time would leave a check able to see only the
 * last task. It is read back and carried on instead, which is what makes
 * "every set of instructions the client sent, in order" true across a walk.
 */
function reportSoFar(file: string): Report {
  const fresh: Report = {
    protocolVersion: null,
    clientCapabilities: null,
    modeSetTo: null,
    observations: {},
    childPid: null,
    instructions: [],
    folders: [],
    loggedInWith: null,
  };
  try {
    return { ...fresh, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Report>) };
  } catch {
    return fresh;
  }
}

async function run(): Promise<void> {
  const script = loadScript();

  let cwd = process.cwd();
  const report = reportSoFar(
    path.resolve(cwd, script.reportFile ?? DEFAULT_REPORT_FILE),
  );
  const reportPath = (): string => path.resolve(cwd, script.reportFile ?? DEFAULT_REPORT_FILE);
  const flush = (): void => {
    writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };

  if (script.spawnChild === true) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
      stdio: "ignore",
    });
    report.childPid = child.pid ?? null;
  }

  const modes: acp.SessionModeState = script.modes ?? {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Ask every time" },
      { id: "bypassPermissions", name: "Do not ask" },
    ],
  };

  let sessionId = "";
  let loggedIn = script.authRequiredUntilLogin === undefined;

  /** The steps for this task, in the folder the session was opened in. */
  function stepsFor(folder: string, instructions: string): FakeStep[] {
    const byTask = (script.stepsByTask ?? []).find((entry) =>
      instructions.includes(entry.contains),
    );
    if (byTask !== undefined) return byTask.steps;
    const matched = (script.stepsByFolder ?? []).find((entry) => folder.includes(entry.contains));
    return matched?.steps ?? script.steps;
  }

  async function play(
    client: acp.AgentContext,
    signal: AbortSignal,
    instructions: string,
  ): Promise<acp.StopReason> {
    for (const step of stepsFor(cwd, instructions)) {
      if (signal.aborted) return "cancelled";

      switch (step.kind) {
        case "say":
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: step.text },
            },
          });
          break;

        case "tool-call":
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: step.id,
              title: step.title,
              kind: step.toolKind ?? "read",
              status: "in_progress",
              locations: step.locations ?? [],
              ...(step.rawInput === undefined ? {} : { rawInput: step.rawInput }),
            },
          });
          break;

        case "tool-call-update":
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: step.id,
              status: step.status,
              ...(step.title === undefined ? {} : { title: step.title }),
            },
          });
          break;

        case "ask-permission": {
          const answer = await client.request<acp.RequestPermissionResponse>(
            acp.methods.client.session.requestPermission,
            {
              sessionId,
              toolCall: {
                toolCallId: step.id,
                title: step.title,
                kind: step.toolKind ?? "read",
                status: "pending",
                locations: step.locations ?? [],
                ...(step.rawInput === undefined ? {} : { rawInput: step.rawInput }),
              },
              options: [
                { kind: "allow_once", name: "Allow", optionId: "allow" },
                { kind: "reject_once", name: "Refuse", optionId: "reject" },
              ],
            },
          );
          report.observations[step.recordAs] =
            answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
          flush();
          break;
        }

        case "read-file": {
          try {
            const answer = await client.request<acp.ReadTextFileResponse>(
              acp.methods.client.fs.readTextFile,
              { sessionId, path: path.resolve(cwd, step.path) },
            );
            report.observations[step.recordAs] = { read: answer.content.length };
          } catch (error) {
            report.observations[step.recordAs] = {
              refusedWith: error instanceof Error ? error.message : String(error),
            };
          }
          flush();
          break;
        }

        case "write-file": {
          try {
            await client.request(acp.methods.client.fs.writeTextFile, {
              sessionId,
              path: path.resolve(cwd, step.path),
              content: step.content,
            });
            if (step.recordAs !== undefined) report.observations[step.recordAs] = "written";
          } catch (error) {
            if (step.recordAs !== undefined) {
              report.observations[step.recordAs] = {
                refusedWith: error instanceof Error ? error.message : String(error),
              };
            }
          }
          flush();
          break;
        }

        case "grumble":
          process.stderr.write(`${step.text}\n`);
          break;

        case "wait":
          await new Promise((resolve) => setTimeout(resolve, step.ms));
          break;

        case "stop":
          return step.reason;
      }
    }
    return "end_turn";
  }

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const running = new Map<string, AbortController>();

  await acp
    .agent({ name: "fake-agent" })
    .onRequest(acp.methods.agent.initialize, (ctx) => {
      report.protocolVersion = Math.min(ctx.params.protocolVersion, acp.PROTOCOL_VERSION);
      report.clientCapabilities = ctx.params.clientCapabilities ?? null;
      const login = script.authRequiredUntilLogin;
      return {
        protocolVersion: report.protocolVersion,
        agentCapabilities: { loadSession: false },
        ...(login === undefined
          ? {}
          : { authMethods: login.methods ?? [{ id: "own-login", name: "Log in to Fake Agent" }] }),
      };
    })
    .onRequest(acp.methods.agent.authenticate, (ctx) => {
      report.loggedInWith = ctx.params.methodId;
      loggedIn = true;
      flush();
      return {};
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      // A cold machine says this before it says anything else, and says it
      // once: after its own login has run, the same request works.
      if (!loggedIn) throw new acp.RequestError(-32000, "Authentication required");
      cwd = ctx.params.cwd;
      sessionId = "fake-1";
      report.folders.push(cwd);
      flush();
      return { sessionId, modes };
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      report.modeSetTo = ctx.params.modeId;
      flush();
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      let instructions = "";
      for (const block of ctx.params.prompt) {
        if (block.type === "text") {
          report.instructions.push(block.text);
          instructions += block.text;
        }
      }
      flush();
      const controller = new AbortController();
      running.set(sessionId, controller);
      const stopReason = await play(ctx.client, controller.signal, instructions);
      running.delete(sessionId);
      flush();
      return { stopReason };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      running.get(ctx.params.sessionId)?.abort();
    })
    .connect(stream).closed;
}

await run();
