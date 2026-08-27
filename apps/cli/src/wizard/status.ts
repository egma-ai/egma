/**
 * Turning what the agent does into lines a developer can read.
 *
 * egma approves everything, so the developer's protection is that they see
 * everything. Structured updates become compact status lines here. The TUI
 * also streams the agent's own messages through its separate live-message path,
 * so this class does not turn prose into a second copy of those lines.
 *
 * A line has to name the file the agent touched, or it is not something anybody
 * can check — and an agent often announces a tool call before it has worked out
 * which file it means. Nothing is held back waiting for that: the action is
 * shown the moment it starts, and the file follows on its own line as soon as
 * the agent says which one it is.
 *
 * Not every action has a file. A terminal call has a command line instead, and
 * `◆ Terminal` on its own says nothing a developer can check — seven of them in
 * one run says nothing seven times. So the command is read out of the raw
 * arguments the same way the fence reads them, and shown beside the title.
 */

import path from "node:path";

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/** The marker in front of an action the agent took. */
export const ACTION_MARK = "◆";

/** The marker in front of a detail about the action above it. */
export const DETAIL_MARK = "┊";

/** The marker in front of an action that did not work. */
export const FAILURE_MARK = "✗";

/** Keys an agent names a file with in a tool call's raw arguments. */
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "abs_path"];

/** Keys an agent names a command with in a tool call's raw arguments. */
const COMMAND_KEYS = ["command", "cmd", "commandLine", "command_line", "script"];

/** How deep into nested raw arguments a command is looked for. */
const MAX_DEPTH = 8;

/** How much of a command line one status line carries. */
const COMMAND_WIDTH = 72;

/** Keys adapters commonly use for one useful failure reason. */
const FAILURE_KEYS = ["error", "message", "stderr", "reason"];

type Located = {
  readonly locations?: readonly { readonly path?: string }[] | null;
  readonly rawInput?: unknown;
};

function shorten(target: string, cwd: string): string {
  if (!path.isAbsolute(target)) return target;
  const relative = path.relative(cwd, target);
  if (relative === "" || relative.startsWith("..")) return path.basename(target);
  return relative;
}

export function fileNamedBy(update: Located): string | null {
  const located = update.locations?.[0]?.path;
  if (typeof located === "string" && located !== "") return located;

  const raw = update.rawInput;
  if (raw !== null && typeof raw === "object") {
    for (const key of PATH_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && value !== "") return value;
    }
  }
  return null;
}

/** One command, on one line, short enough to sit beside a title. */
function oneLine(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim();
  if (collapsed.length <= COMMAND_WIDTH) return collapsed;
  return `${collapsed.slice(0, COMMAND_WIDTH - 1).trimEnd()}…`;
}

function commandIn(value: unknown, depth: number): string | null {
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return null;
  const held = value as Record<string, unknown>;

  for (const key of COMMAND_KEYS) {
    const named = held[key];
    if (typeof named === "string" && named.trim() !== "") return named;
    if (Array.isArray(named)) {
      // Some agents send the command already split into its words.
      const words = named.filter((word): word is string => typeof word === "string");
      if (words.length > 0) return words.join(" ");
    }
  }

  // An adapter can bury the call one or two objects down, so the search goes
  // as deep as the fence's does rather than only reading the top level.
  for (const nested of Object.values(held)) {
    const found = commandIn(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** The command a tool call is about to run, or `null` when it runs none. */
export function commandNamedBy(update: Located): string | null {
  const found = commandIn(update.rawInput, 0);
  return found === null ? null : oneLine(found);
}

function textContentIn(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const held = item as Record<string, unknown>;
    if (held.type !== "content" || held.content === null || typeof held.content !== "object") {
      continue;
    }
    const content = held.content as Record<string, unknown>;
    if (content.type === "text" && typeof content.text === "string" && content.text.trim() !== "") {
      return content.text;
    }
  }
  return null;
}

function failureIn(value: unknown, depth: number): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = failureIn(nested, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  const held = value as Record<string, unknown>;
  for (const key of FAILURE_KEYS) {
    const found = failureIn(held[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

type FailedUpdate = Located & {
  readonly content?: unknown;
  readonly rawOutput?: unknown;
};

/** A concise failure reason an ACP adapter made available, if it made one available. */
export function failureNamedBy(update: FailedUpdate): string | null {
  const found = textContentIn(update.content) ?? failureIn(update.rawOutput, 0);
  return found === null ? null : oneLine(found);
}

type Action = {
  title: string;
  file: string | null;
  command: string | null;
  failureShown: boolean;
};

function describe(action: Action, cwd: string): string {
  if (action.file !== null) {
    const shortened = shorten(action.file, cwd);
    return action.title.includes(shortened) ? action.title : `${action.title} ${shortened}`;
  }
  if (action.command !== null) return `${action.title} ${DETAIL_MARK} ${action.command}`;
  return action.title;
}

/** One task's worth of actions, turned into lines as the agent takes them. */
export class ActionStream {
  private readonly cwd: string;
  private readonly actions = new Map<string, Action>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /** The lines this update is worth — often none. */
  lines(update: SessionUpdate): string[] {
    if (update.sessionUpdate === "tool_call") {
      const action: Action = {
        title: update.title,
        file: fileNamedBy(update),
        command: commandNamedBy(update),
        failureShown: false,
      };
      this.actions.set(update.toolCallId, action);
      return [`${ACTION_MARK} ${describe(action, this.cwd)}`];
    }

    if (update.sessionUpdate !== "tool_call_update") return [];

    const lines: string[] = [];
    let action = this.actions.get(update.toolCallId) ?? null;
    if (action === null) {
      action = {
        title: update.title ?? "Working",
        file: fileNamedBy(update),
        command: commandNamedBy(update),
        failureShown: false,
      };
      this.actions.set(update.toolCallId, action);
      lines.push(`${ACTION_MARK} ${describe(action, this.cwd)}`);
    } else if (action.file === null) {
      const named = fileNamedBy(update);
      if (named !== null) {
        action.file = named;
        lines.push(`${DETAIL_MARK} ${shorten(named, this.cwd)}`);
      } else if (action.command === null) {
        const command = commandNamedBy(update);
        if (command !== null) {
          action.command = command;
          lines.push(`${DETAIL_MARK} ${command}`);
        }
      }
    }

    if (update.status === "failed" && !action.failureShown) {
      action.failureShown = true;
      lines.push(`${FAILURE_MARK} ${describe(action, this.cwd)} did not work`);
      const reason = failureNamedBy(update);
      if (reason !== null) lines.push(`${DETAIL_MARK} ${reason}`);
    }

    return lines;
  }
}

/** The coding agent's own words, for the summary — not for the stream. */
export function drivenAgentTextIn(update: SessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return update.content.type === "text" ? update.content.text : "";
}
