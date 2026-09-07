/**
 * Pure transform that adds per-tool routing variables to captured engine config.
 * Prefix each custom-tool URL while preserving its original bytes, tool schema,
 * headers, query parameters, and node references. Unmocked simulations still need
 * the original backend credentials.
 *
 * Per call, a mock URL ending in # hides the original URL in the fragment;
 * an empty prefix leaves it unchanged. See EGMA_URL_VARIABLE_DEFAULT for the
 * required stored fallback. The mock endpoint must ignore customer headers and query data.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_DYNAMIC_VARIABLES,
  type EngineConfiguration,
} from "./versions.ts";
import { isIntercepted, toolsOf, type EngineTool } from "./tools.ts";

/**
 * What every variable this transform writes is named after.
 *
 * Reserved on a test's own `retell_dynamic_variables` at the save door, so an
 * authored name can never take the place of a routing one. The prefix is
 * spelled here and nowhere else, so the writer, the claim and the refusal
 * cannot come to disagree about it.
 */
export const EGMA_URL_VARIABLE_PREFIX = "egma_url_";

/**
 * Stored routing-variable default: one space. Retell treats an empty default as
 * absent, leaving literal {{…}} in the URL. A space remains set and is removed
 * by URL parsing, preserving the original backend URL. Verified live on 2026-09-03.
 */
export const EGMA_URL_VARIABLE_DEFAULT = " ";

/** One intercepted tool and the per-call variable that routes it. */
export type MockToolVariable = {
  /** The tool's own name, as the model calls it and as the test names it. */
  readonly tool: string;
  /** `egma_url_…`, the name Retell renders per call. */
  readonly variable: string;
};

/**
 * Build a variable name from the tool name. Preserve plain alphanumeric/underscore
 * names; sanitize others and append the original name's digest to avoid collisions.
 */
export function mockToolVariable(toolName: string): string {
  if (/^[A-Za-z0-9_]+$/u.test(toolName)) {
    return `${EGMA_URL_VARIABLE_PREFIX}${toolName}`;
  }
  const sanitized = toolName.replaceAll(/[^A-Za-z0-9_]/gu, "_");
  const digest = createHash("sha256")
    .update(toolName, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${EGMA_URL_VARIABLE_PREFIX}${sanitized}_${digest}`;
}

/** What the URL one mocked call is routed to is built out of. */
export type MockEndpointTarget = {
  /**
   * Where Egma answers, with no trailing slash — the public base a self-hoster
   * configures. Retell refuses localhost and private addresses for a tool URL,
   * so this is a public address or nothing works.
   */
  readonly base: string;
  /** The simulation whose test's answers this call is to be served from. */
  readonly simulationId: string;
};

/**
 * Build the encoded simulation/tool endpoint followed by #.
 * The original tool URL follows as a fragment and is not sent in the HTTP request.
 */
export function mockToolUrl(
  target: MockEndpointTarget,
  toolName: string,
): string {
  const base = target.base.replace(/\/+$/u, "");
  return (
    `${base}/${encodeURIComponent(target.simulationId)}` +
    `/${encodeURIComponent(toolName)}#`
  );
}

/** What a mocked draft is written from. */
export type MockedTools = {
  /**
   * Minimal engine update containing rewritten tool URLs. Conversation flows need
   * only tools. Retell LLM per-state tools require resending the full states array;
   * preserve every other state field from the captured version.
   */
  readonly tools: Readonly<Record<string, unknown>>;
  /**
   * The whole `default_dynamic_variables` map to write beside them: the
   * customer's own, unchanged, plus one single-space default per routing
   * variable.
   *
   * Empty when this engine declares no tool Egma stands in front of, and then
   * the key is not written at all — a version with nothing to route has no
   * business having its defaults rewritten.
   */
  readonly defaults: Readonly<Record<string, unknown>>;
  /** Each intercepted tool's routing variable, in declaration order. */
  readonly variables: readonly MockToolVariable[];
};

/**
 * The transform's answer: the draft to write, or the reason nothing may be.
 *
 * A refusal is answered **before anything is written**, because both of its
 * causes make a routing variable ambiguous, and an ambiguous variable is a
 * tool call landing somewhere nobody chose.
 */
export type MockedDraft =
  | ({ readonly kind: "mocked" } & MockedTools)
  | { readonly kind: "refused"; readonly reason: string };

/** The engine's own default variables, or an empty map where it has none. */
function declaredDefaults(
  engine: EngineConfiguration,
): Readonly<Record<string, unknown>> {
  const held = engine.document[DEFAULT_DYNAMIC_VARIABLES];
  if (typeof held !== "object" || held === null || Array.isArray(held)) {
    return {};
  }
  return held as Record<string, unknown>;
}

/**
 * One tool as the draft holds it: the same tool, with its URL routable.
 *
 * The original URL is kept byte for byte, whatever it is — a customer's own
 * `{{clinic_host}}` inside it included, because the prefix is rendered from the
 * same variable set as theirs and neither disturbs the other.
 */
function prefixed(
  tool: EngineTool,
  variable: string,
): Record<string, unknown> {
  const held = tool.verbatim["url"];
  // A custom tool with no URL at all is already a tool no call could reach.
  // The prefix alone still routes it to Egma on a mocked call, which is more
  // than it had, and `""` on an unmocked one leaves it exactly as broken as it
  // was found. Nothing here invents a URL for it.
  const original = typeof held === "string" ? held : "";
  return {
    ...tool.verbatim,
    url: `{{${variable}}}${original}`,
    // `headers` and `query_params` are **not** touched. See the note at the
    // top of this file: one version serves mocked and unmocked calls alike, so
    // a tool whose credentials were emptied here would fail for every test
    // that does not name it.
  };
}

/**
 * The tools of one engine, made routable — and the variables that route them.
 *
 * Both engines are walked here rather than at the call site, because "which
 * arrays hold tools" is a fact about Retell and belongs where the rest of that
 * knowledge is. A conversation flow has one array; a Retell LLM has its general
 * array and one per state, and every state's array is walked.
 */
export function mockedToolsFor(engine: EngineConfiguration): MockedDraft {
  const tools = toolsOf(engine);
  const { document } = engine;
  const customerDefaults = declaredDefaults(engine);

  /**
   * Each intercepted tool's variable, and the two ways the naming can fail.
   *
   * Both are refused here, before a single request goes out, because both
   * leave a tool that cannot be routed honestly: two tools sharing one
   * variable would be answered or passed through together whatever the tests
   * asked for, and a variable the customer already fills would take Egma's
   * routing value from Egma.
   */
  const variables: MockToolVariable[] = [];
  const claimed = new Map<string, string>();
  /**
   * Each intercepted tool's routing variable, by the tool's own name, so the
   * rewrite below reads the name this loop settled on rather than working it
   * out a second time. Two tools cannot share a name here: the same name gives
   * the same variable, which is refused above.
   */
  const variableOf = new Map<string, string>();
  for (const tool of tools) {
    if (!isIntercepted(tool)) continue;
    const variable = mockToolVariable(tool.name);
    const already = claimed.get(variable);
    if (already !== undefined) {
      return {
        kind: "refused",
        reason:
          `This agent declares two custom tools Egma would route with the ` +
          `same per-call variable (${variable}): ` +
          (already === tool.name
            ? `both are named "${tool.name}"`
            : `"${already}" and "${tool.name}"`) +
          ". Egma decides per call which tools it answers, and one variable " +
          "cannot answer for two tools, so it wrote nothing and stopped. " +
          "Give the tools different names in Retell and start the run again.",
      };
    }
    if (Object.hasOwn(customerDefaults, variable)) {
      return {
        kind: "refused",
        reason:
          `This agent already carries a default dynamic variable named ` +
          `${variable}, which is the name Egma routes the tool ` +
          `"${tool.name}" with. Egma will not overwrite a variable of yours, ` +
          "so it wrote nothing and stopped. Rename that variable in Retell, " +
          "or rename the tool, and start the run again.",
      };
    }
    claimed.set(variable, tool.name);
    variableOf.set(tool.name, variable);
    variables.push({ tool: tool.name, variable });
  }

  /**
   * The entries of one array that this draft rewrites, by their index in it:
   * every intercepted tool held there, with its own routing variable written in
   * front of the URL the customer wrote.
   *
   * Keyed by index because that is how the array goes back — the rewritten
   * entries take their own places and every other row is copied across
   * untouched.
   */
  const prefixedAt = (
    array: "tools" | "general_tools" | "states",
    stateIndex: number | null,
  ): Map<number, Record<string, unknown>> => {
    const rewritten = new Map<number, Record<string, unknown>>();
    for (const tool of tools) {
      if (!isIntercepted(tool)) continue;
      if (tool.location.array !== array) continue;
      if (
        tool.location.array === "states" &&
        tool.location.stateIndex !== stateIndex
      ) {
        continue;
      }
      const variable = variableOf.get(tool.name);
      // Every intercepted tool was given one above, so this is the type's
      // question rather than the product's.
      if (variable === undefined) continue;
      rewritten.set(tool.index, prefixed(tool, variable));
    }
    return rewritten;
  };

  /** One array rewritten: prefixed entries replaced, everything else as-is. */
  const rewrite = (
    value: unknown,
    rewritten: Map<number, Record<string, unknown>>,
  ): readonly unknown[] =>
    Array.isArray(value)
      ? value.map((row, index) => rewritten.get(index) ?? row)
      : [];

  // The defaults go back whole: the customer's own, unchanged, and one
  // single-space entry per routing variable beside them. Written in one PATCH
  // with the tools, because a version whose tools name a variable it has no
  // default for is a version whose unmocked calls have nowhere to go.
  const defaults: Record<string, unknown> = {};
  if (variables.length > 0) {
    // Verbatim, whatever they hold. Coercing a customer's own default to text
    // here would be Egma rewriting their configuration on the way past.
    for (const [name, value] of Object.entries(customerDefaults)) {
      defaults[name] = value;
    }
    for (const { variable } of variables) {
      defaults[variable] = EGMA_URL_VARIABLE_DEFAULT;
    }
  }

  if (engine.reference.type === "conversation-flow") {
    return {
      kind: "mocked",
      tools: Array.isArray(document["tools"])
        ? { tools: rewrite(document["tools"], prefixedAt("tools", null)) }
        : {},
      defaults,
      variables,
    };
  }

  const written: Record<string, unknown> = {};
  if (Array.isArray(document["general_tools"])) {
    written["general_tools"] = rewrite(
      document["general_tools"],
      prefixedAt("general_tools", null),
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
        tools: rewrite(held["tools"], prefixedAt("states", stateIndex)),
      };
    });
  }

  return { kind: "mocked", tools: written, defaults, variables };
}

/**
 * Which routing defaults an engine reads back with the wrong value, if any.
 *
 * The read-back guard's whole question, asked here so the builder and any
 * proof of it ask it the same way. A default that is no longer exactly one
 * space is a default Retell trimmed, stored as absent, or somebody edited —
 * and every one of those turns an unmocked call's URL into the literal
 * `{{egma_url_…}}`, which fails rather than reaching the customer's backend.
 */
export function trimmedEgmaDefaults(
  engine: EngineConfiguration,
  variables: readonly MockToolVariable[],
): readonly string[] {
  const defaults = declaredDefaults(engine);
  return variables
    .map(({ variable }) => variable)
    .filter((variable) => defaults[variable] !== EGMA_URL_VARIABLE_DEFAULT);
}
