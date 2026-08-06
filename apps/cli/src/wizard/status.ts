/**
 * Turning what the agent does into lines a developer can read.
 *
 * egma approves everything, so the developer's protection is that they see
 * everything. Only structured updates become status lines; the agent's own
 * prose is collected separately and never streamed word by word, because a wall
 * of text is not visibility.
 *
 * A line has to name the file the agent touched, or it is not something anybody
 * can check — and an agent often announces a tool call before it has worked out
 * which file it means. Nothing is held back waiting for that: the action is
 * shown the moment it starts, and the file follows on its own line as soon as
 * the agent says which one it is.
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

function describe(title: string, file: string | null, cwd: string): string {
  if (file === null) return title;
  const shortened = shorten(file, cwd);
  return title.includes(shortened) ? title : `${title} ${shortened}`;
}

type Action = { title: string; file: string | null; failureShown: boolean };

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
        failureShown: false,
      };
      this.actions.set(update.toolCallId, action);
      return [`${ACTION_MARK} ${describe(action.title, action.file, this.cwd)}`];
    }

    if (update.sessionUpdate !== "tool_call_update") return [];

    const lines: string[] = [];
    let action = this.actions.get(update.toolCallId) ?? null;
    if (action === null) {
      action = { title: update.title ?? "Working", file: fileNamedBy(update), failureShown: false };
      this.actions.set(update.toolCallId, action);
      lines.push(`${ACTION_MARK} ${describe(action.title, action.file, this.cwd)}`);
    } else if (action.file === null) {
      const named = fileNamedBy(update);
      if (named !== null) {
        action.file = named;
        lines.push(`${DETAIL_MARK} ${shorten(named, this.cwd)}`);
      }
    }

    if (update.status === "failed" && !action.failureShown) {
      action.failureShown = true;
      lines.push(`${FAILURE_MARK} ${describe(action.title, action.file, this.cwd)} did not work`);
    }

    return lines;
  }
}

/** The coding agent's own words, for the summary — not for the stream. */
export function drivenAgentTextIn(update: SessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return update.content.type === "text" ? update.content.text : "";
}
