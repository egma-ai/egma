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
  steps: FakeStep[];
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
};

async function run(): Promise<void> {
  const script = loadScript();
  const report: Report = {
    protocolVersion: null,
    clientCapabilities: null,
    modeSetTo: null,
    observations: {},
    childPid: null,
  };

  let cwd = process.cwd();
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

  async function play(client: acp.AgentContext, signal: AbortSignal): Promise<acp.StopReason> {
    for (const step of script.steps) {
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
      return {
        protocolVersion: report.protocolVersion,
        agentCapabilities: { loadSession: false },
      };
    })
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      cwd = ctx.params.cwd;
      sessionId = "fake-1";
      flush();
      return { sessionId, modes };
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      report.modeSetTo = ctx.params.modeId;
      flush();
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const controller = new AbortController();
      running.set(sessionId, controller);
      const stopReason = await play(ctx.client, controller.signal);
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
