/**
 * The tools an engine declares, and which of them Egma can route.
 *
 * Two things live here, and both are reads of a configuration rather than acts
 * against an account: where an engine keeps its tools, and whether Egma can
 * stand in front of one. Nothing here writes, nothing here needs a run, and
 * nothing here assumes a mocked run is what is being prepared — a surface that
 * only wants to *show* a developer what their agent declares asks exactly
 * these two questions.
 */

import type { EngineConfiguration } from "./versions.ts";
import { plain } from "./transport.ts";

/**
 * Where one tool sits in the document it came from.
 *
 * Kept because a write has to put the tool back where it was. A conversation
 * flow has one array; a Retell LLM has a general array **and** one per state,
 * and a transform that walked only the first would silently leave every
 * state's tools pointing at the customer's real backend.
 */
export type ToolLocation =
  /** A conversation flow's one top-level `tools` array. */
  | { readonly array: "tools" }
  /** A Retell LLM's `general_tools`. */
  | { readonly array: "general_tools" }
  /** A Retell LLM's `states[stateIndex].tools`. */
  | { readonly array: "states"; readonly stateIndex: number }
  /**
   * Either engine's `mcps` array, which both of them carry beside their tools.
   *
   * Read although nothing here routes one, because a caller asking what an
   * agent can do has to be told about **every** tool it can call. An MCP
   * server is one, it reaches the customer's own server for real on every
   * simulation, and a read that left it out would say the agent had fewer
   * tools than it has.
   */
  | { readonly array: "mcps" };

/** One declared tool, with where it was found and what it is. */
export type EngineTool = {
  /**
   * What the model calls it. Falls back to Retell's own id and then to the
   * tool's type, so a list of an agent's tools never carries a blank entry — a
   * nameless tool is still a tool a developer has to be told about.
   */
  readonly name: string;
  /** Retell's own word for the kind of tool, verbatim. */
  readonly type: string;
  readonly location: ToolLocation;
  /** Where in its own array it sits. */
  readonly index: number;
  /** The tool exactly as Retell holds it. Never rewritten here. */
  readonly verbatim: Readonly<Record<string, unknown>>;
};

/**
 * The one tool type Egma stands in front of.
 *
 * A custom tool is a webhook: Retell posts to a URL the configuration holds,
 * so putting a per-call variable in front of that URL is the whole of the
 * interception.
 */
export const INTERCEPTED_TOOL_TYPE = "custom";

/**
 * Whether a mocked draft makes this tool routable.
 *
 * **Everything else runs for real, and that is the settled answer.** Two kinds
 * of tool are not custom webhooks and never can be: the ones Retell executes
 * inside its own infrastructure — a code tool, a transfer, an SMS, a digit
 * press, a variable extraction, an end-call, its own Cal.com booking — where
 * no URL leads at all; and MCP servers, which Retell reaches over their own
 * protocol from an array this transform never writes. Both run against the
 * customer's own world on every simulation, mocked run or not.
 *
 * Egma used to sort every tool into three classes and stamp them onto the
 * record. That stamp is gone: a simulation is answered for exactly the tools
 * its own test names, every answered call is on the transcript, and a second
 * summarised version of the same fact is a field two readers could come to
 * disagree about. What is left is this one question, which is the only one the
 * transform ever needed.
 */
export function isIntercepted(tool: EngineTool): boolean {
  return tool.type === INTERCEPTED_TOOL_TYPE;
}

/** What an `mcps` entry's type is, since the entries carry no `type` field. */
export const MCP_TOOL_TYPE = "mcp";

function toolFrom(
  row: unknown,
  location: ToolLocation,
  index: number,
): EngineTool | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const held = row as Record<string, unknown>;
  const declared = plain(held["type"]);
  // An `mcps` entry is an MCP server by the array it is in; the entries there
  // carry a name and a URL and no type at all.
  const type =
    declared !== ""
      ? declared
      : location.array === "mcps"
        ? MCP_TOOL_TYPE
        : "";
  const name = plain(held["name"]);
  const id = plain(held["tool_id"]) || plain(held["mcp_id"]);
  return {
    name: name !== "" ? name : id !== "" ? id : type,
    type,
    location,
    index,
    verbatim: held,
  };
}

function toolsInArray(
  value: unknown,
  location: (index: number) => ToolLocation,
): EngineTool[] {
  if (!Array.isArray(value)) return [];
  const tools: EngineTool[] = [];
  for (const [index, row] of value.entries()) {
    const tool = toolFrom(row, location(index), index);
    if (tool !== null) tools.push(tool);
  }
  return tools;
}

/**
 * Every tool one engine declares, in the order the document declares them.
 *
 * A conversation flow keeps one array. A Retell LLM keeps a general array and
 * one per state, and **both** are walked: a multi-prompt agent puts most of its
 * tools in its states, so an engine read that stopped at `general_tools` would
 * report a nearly empty agent and mock nearly nothing.
 */
export function toolsOf(engine: EngineConfiguration): readonly EngineTool[] {
  const { document } = engine;
  const mcps = toolsInArray(document["mcps"], () => ({ array: "mcps" }));

  if (engine.reference.type === "conversation-flow") {
    return [
      ...toolsInArray(document["tools"], () => ({ array: "tools" })),
      ...mcps,
    ];
  }

  const tools: EngineTool[] = [
    ...toolsInArray(document["general_tools"], () => ({
      array: "general_tools",
    })),
  ];

  const states = document["states"];
  if (Array.isArray(states)) {
    for (const [stateIndex, state] of states.entries()) {
      if (typeof state !== "object" || state === null) continue;
      tools.push(
        ...toolsInArray((state as Record<string, unknown>)["tools"], () => ({
          array: "states",
          stateIndex,
        })),
      );
    }
  }
  return [...tools, ...mcps];
}
