/**
 * The one transform: an engine's tools, pointed at egma instead of at the
 * customer's backend.
 *
 * It is a pure function of a configuration and an address. It reaches nothing,
 * writes nothing, and holds nothing — which is what lets the whole promise be
 * checked against a captured configuration rather than against an account.
 *
 * **Exactly three fields change per intercepted tool.** The URL becomes egma's
 * mock endpoint, and the headers and the query params are emptied. Name,
 * description and parameters are the tool's contract — the part the model reads
 * — and they stay byte-identical, so the agent under test reasons and asks
 * exactly as it does in production. Node references by tool id are untouched
 * for the same reason: they name tools, and no tool is renamed.
 *
 * **Headers and query params are emptied rather than carried.** Both are where
 * a backend's credentials live — a static query param is a backend constant
 * exactly as a header is — and a mocked run must never be the reason a
 * customer's API token travelled somewhere new. The request *body* is
 * untouched: it is the model's own arguments, and a future argument-matching
 * feature reads it.
 */

import type { EngineConfiguration } from "./versions.ts";
import {
  isIntercepted,
  toolCoverageOf,
  toolsOf,
  type EngineTool,
  type ToolCoverage,
} from "./tools.ts";

/**
 * The dynamic variable the swapped URL carries the simulation in.
 *
 * Retell renders it per call from the values handed to call creation, and a
 * custom tool configured args-at-root posts no call envelope at all — so the
 * URL is the only channel identity can ride. The name is here rather than at
 * each end so the writer and the caller cannot spell it differently.
 */
export const SIMULATION_VARIABLE = "egma_simulation";

/** What the swapped URL is built out of. */
export type MockEndpointTarget = {
  /**
   * Where egma answers, with no trailing slash — the public base a self-hoster
   * configures. Retell refuses localhost and private addresses for a tool URL,
   * so this is a public address or nothing works.
   */
  readonly base: string;
  /** The run whose frozen world answers these calls. */
  readonly runId: string;
};

/** What a mocked draft is written from. */
export type MockedTools = {
  /**
   * The body to write onto the draft's engine version. It carries the smallest
   * set of top-level keys the engine's own update endpoint can express, and
   * **that set is not the same for both engines**:
   *
   * - **A conversation flow** keeps its tools in one top-level `tools` array,
   *   so the body is that array and nothing else. Prompts, nodes, the MCP list
   *   and every other key are never resent, and therefore cannot be resent
   *   wrong.
   * - **A Retell LLM** keeps per-state tools inside its `states` array, and
   *   Retell offers no way to patch one state. So the body carries `states`
   *   **whole** — every state's prompt, edges and remaining fields travel back
   *   exactly as they were read, alongside its rewritten tool array. Nothing is
   *   altered, but more than the tools is resent, and that is a real difference
   *   worth knowing when a write is being reviewed.
   *
   * Under both, every value that goes back came from the version that was read
   * moments earlier and is byte-identical to it except for the two fields each
   * intercepted tool is allowed to change.
   */
  readonly tools: Readonly<Record<string, unknown>>;
  /** What the transform did and did not stand in front of. */
  readonly coverage: ToolCoverage;
};

/**
 * The URL one intercepted tool is pointed at.
 *
 * Three segments after the base: the run, the simulation as the dynamic
 * variable Retell fills per call, and the tool's own name. The name is
 * percent-encoded here and decoded at the endpoint, so any name Retell accepts
 * routes correctly — reserved characters and slashes included. The variable's
 * braces are **not** encoded: encoded braces are not a placeholder, and Retell
 * would post to a literal `%7B%7Begma_simulation%7D%7D`.
 */
export function mockToolUrl(
  target: MockEndpointTarget,
  toolName: string,
): string {
  const base = target.base.replace(/\/+$/u, "");
  return (
    `${base}/${encodeURIComponent(target.runId)}` +
    `/{{${SIMULATION_VARIABLE}}}` +
    `/${encodeURIComponent(toolName)}`
  );
}

/** One tool as the draft holds it: the same tool, pointed somewhere else. */
function swapped(
  tool: EngineTool,
  target: MockEndpointTarget,
): Record<string, unknown> {
  return {
    ...tool.verbatim,
    url: mockToolUrl(target, tool.name),
    // Emptied, never dropped: a tool whose `headers` key vanished would be a
    // tool whose configuration changed shape, and the promise is that only the
    // three values move. The query params go the same way and for the same
    // reason — they are backend constants, and secrets travel in them.
    headers: {},
    query_params: {},
  };
}

/**
 * The tools of one engine, pointed at egma — and the stamp saying which ones
 * were not.
 *
 * Both engines are walked here rather than at the call site, because "which
 * arrays hold tools" is a fact about Retell and belongs where the rest of that
 * knowledge is. A conversation flow has one array; a Retell LLM has its general
 * array and one per state, and every state's array is walked.
 */
export function mockedToolsFor(
  engine: EngineConfiguration,
  target: MockEndpointTarget,
): MockedTools {
  const tools = toolsOf(engine);
  const coverage = toolCoverageOf(tools);
  const { document } = engine;

  const swapAt = (
    array: "tools" | "general_tools" | "states",
    stateIndex: number | null,
  ): Map<number, Record<string, unknown>> => {
    const at = new Map<number, Record<string, unknown>>();
    for (const tool of tools) {
      if (!isIntercepted(tool)) continue;
      if (tool.location.array !== array) continue;
      if (
        tool.location.array === "states" &&
        tool.location.stateIndex !== stateIndex
      ) {
        continue;
      }
      at.set(tool.index, swapped(tool, target));
    }
    return at;
  };

  /** One array rewritten: swapped entries replaced, everything else as-is. */
  const rewrite = (
    value: unknown,
    at: Map<number, Record<string, unknown>>,
  ): readonly unknown[] =>
    Array.isArray(value) ? value.map((row, index) => at.get(index) ?? row) : [];

  if (engine.reference.type === "conversation-flow") {
    return {
      tools: Array.isArray(document["tools"])
        ? { tools: rewrite(document["tools"], swapAt("tools", null)) }
        : {},
      coverage,
    };
  }

  const written: Record<string, unknown> = {};
  if (Array.isArray(document["general_tools"])) {
    written["general_tools"] = rewrite(
      document["general_tools"],
      swapAt("general_tools", null),
    );
  }

  const states = document["states"];
  if (Array.isArray(states)) {
    written["states"] = states.map((state, stateIndex) => {
      if (typeof state !== "object" || state === null || Array.isArray(state)) {
        return state;
      }
      const held = state as Record<string, unknown>;
      if (!Array.isArray(held["tools"])) return state;
      return {
        ...held,
        tools: rewrite(held["tools"], swapAt("states", stateIndex)),
      };
    });
  }

  return { tools: written, coverage };
}
