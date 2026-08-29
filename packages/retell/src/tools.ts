/**
 * The tools an engine declares, and how isolated a simulation over it can be.
 *
 * Two things live here, and both are reads of a configuration rather than acts
 * against an account: where an engine keeps its tools, and which of the three
 * honest answers each tool gets when somebody asks whether egma can stand in
 * front of it. Nothing here writes, nothing here needs a run, and nothing here
 * assumes a mocked run is what is being prepared — a surface that only wants to
 * *show* a developer what could be mocked asks exactly these two questions.
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
   * Read although nothing here intercepts one, because the stamp's job is to
   * account for **every** tool the agent can call. An MCP server left off the
   * stamp would be a tool that reached the real world with the record silent
   * about it, which is the one thing a coverage stamp exists to prevent.
   */
  | { readonly array: "mcps" };

/** One declared tool, with where it was found and what it is. */
export type EngineTool = {
  /**
   * What the model calls it. Falls back to Retell's own id and then to the
   * tool's type, so a coverage list never carries a blank entry — a nameless
   * tool is still a tool a developer has to be told about.
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
 * The three honest answers to "how isolated was this simulation from this
 * tool", and the whole vocabulary of the coverage stamp.
 *
 * - `mocked` — egma stands in front of it, so the customer's backend is never
 *   reached.
 * - `notInterceptable` — it executes inside Retell and no URL scheme can reach
 *   it: a code tool, a transfer, an SMS, a digit press, a variable extraction,
 *   an end-call. Two of those act outside the call and really happen, which is
 *   exactly why they are named rather than quietly left out.
 * - `notInThisVersion` — egma could intercept it and does not yet. MCP is the
 *   one egma knows by name; anything Retell has added since is here too,
 *   because "egma does not do this yet" is the only claim egma can honestly
 *   make about a tool type it has never seen. Saying `notInterceptable`
 *   instead would be a promise about somebody else's roadmap.
 */
export const TOOL_COVERAGE_CLASSES = [
  "mocked",
  "notInterceptable",
  "notInThisVersion",
] as const;
export type ToolCoverageClass = (typeof TOOL_COVERAGE_CLASSES)[number];

/** The tool names of one configuration, in their three classes. */
export type ToolCoverage = Readonly<
  Record<ToolCoverageClass, readonly string[]>
>;

/** A coverage stamp over nothing at all — an engine that declares no tools. */
export const NO_TOOLS: ToolCoverage = {
  mocked: [],
  notInterceptable: [],
  notInThisVersion: [],
};

/**
 * The one tool type this version stands in front of.
 *
 * A custom tool is a webhook: Retell posts to a URL the configuration holds,
 * so changing that URL is the whole of the interception.
 */
export const INTERCEPTED_TOOL_TYPE = "custom";

/**
 * The tool types that execute inside Retell, where no URL leads.
 *
 * Both spellings of the two that have moved are listed rather than normalised,
 * because the stamp has to be right about a configuration written under either
 * one, and a stamp that guessed would be wrong about a real transfer.
 */
const NEVER_INTERCEPTABLE: ReadonlySet<string> = new Set([
  "code",
  "transfer_call",
  "transfer",
  "send_sms",
  "sms",
  "press_digit",
  "dtmf",
  "extract_dynamic_variable",
  "end_call",
  "agent_swap",
  // Retell calls Cal.com itself, from inside its own infrastructure. The
  // configuration holds no URL of the customer's to swap.
  "book_appointment_cal",
  "check_availability_cal",
]);

/** Which class one tool falls in. */
export function coverageClassOf(tool: EngineTool): ToolCoverageClass {
  if (tool.type === INTERCEPTED_TOOL_TYPE) return "mocked";
  if (NEVER_INTERCEPTABLE.has(tool.type)) return "notInterceptable";
  return "notInThisVersion";
}

/** Whether a mocked draft rewrites this tool's URL. */
export function isIntercepted(tool: EngineTool): boolean {
  return coverageClassOf(tool) === "mocked";
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

/**
 * The coverage stamp for a set of tools.
 *
 * Names, in the order the configuration declares them, with duplicates kept:
 * two states can declare a tool of the same name, and collapsing them would
 * report one tool where the agent has two.
 */
export function toolCoverageOf(
  tools: readonly EngineTool[],
): ToolCoverage {
  const stamp: Record<ToolCoverageClass, string[]> = {
    mocked: [],
    notInterceptable: [],
    notInThisVersion: [],
  };
  for (const tool of tools) stamp[coverageClassOf(tool)].push(tool.name);
  return stamp;
}
