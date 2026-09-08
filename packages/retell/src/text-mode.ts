/**
 * Retell voice-agent testing through text completion, with full history per request.
 * Require an explicit agent version and carry mock answers in the request;
 * this module creates no temporary agent version.
 *
 * Request types come from the pinned Retell SDK. Keep the Python plug aligned.
 */

import type { PlaygroundCompletionParams } from "retell-sdk/resources/playground";

import {
  ask,
  failureIn,
  parsed,
  plain,
  unreachableFrom,
  type RetellCredential,
  type RetellFailure,
  type RetellReach,
} from "./transport.ts";

/**
 * Every name this module puts on the wire, and the only place any of them is
 * written. See the note at the top of the file.
 */
export const WIRE = {
  /** Where one exchange is asked for. The agent's own id follows it. */
  path: "/agent-playground-completion",
  agentVersion: "version",
  /** The history going out, and the agent's new messages coming back. */
  messages: "messages",
  dynamicVariables: "dynamic_variables",
  /** Prefer the documented field; accept the legacy response spelling. */
  replyVariables: [
    "dynamic_variables",
    "retell_llm_dynamic_variables",
  ] as readonly string[],
  /** The answers this exchange carries with it, in place of a draft. */
  mockTools: "tool_mocks",
  mockToolName: "tool_name",
  /** How a native mock is matched: by name, whatever the arguments were. */
  mockToolMatch: "input_match_rule",
  matchAnything: { type: "any" },
  /** The value the tool is given, JSON-encoded and untagged. */
  mockToolOutput: "output",
  /** Whether the call succeeded — how Retell is told to serve a failure. */
  mockToolResult: "result",
  /** Where a conversation flow is, threaded turn by turn. */
  nodeId: "current_node_id",
  componentId: "component_id",
  /** Where a Retell LLM is, threaded the same way. */
  stateName: "current_state",
  /** The agent saying the exchange is over. */
  agentEnded: "call_ended",
} as const;

/**
 * One message, in Retell's own vocabulary and never translated into egma's.
 *
 * `role` is whatever Retell said — `agent`, `user`, `tool_call_invocation`,
 * `tool_call_result`, or a word Retell has added since — and `verbatim` is the
 * message whole. Both are kept because a role egma has never seen is still
 * something the agent did, and dropping it would leave a record claiming the
 * agent was silent when it was not.
 */
export type TextModeMessage = {
  readonly role: string;
  /** What was said, or `""` for a message that carried no words. */
  readonly content: string;
  /** The tool's name on an invocation or a result, else `""`. */
  readonly name: string;
  /** The arguments exactly as Retell encoded them, else `""`. */
  readonly arguments: string;
  /** The message exactly as Retell holds it. Never rewritten here. */
  readonly verbatim: Readonly<Record<string, unknown>>;
};

/** One turn of history, as a request carries it. */
export type TextModeTurn = {
  readonly role: "agent" | "user";
  readonly content: string;
};

/**
 * One authored answer or error per tool, matched regardless of arguments.
 * Convert the tag to Retell's result format. Omitted tools use their real implementation.
 */
export type TextModeMockTool = {
  readonly toolName: string;
  readonly answer:
    | { readonly answer: unknown }
    | { readonly error: string };
};

/**
 * Where the agent is between two turns.
 *
 * A conversation flow reports its node, and a component inside it where one is
 * named; a Retell LLM reports its state. Threaded forward unread: what these
 * mean is Retell's business, and egma's job is to hand back exactly what it was
 * given.
 */
export type TextModeResume = {
  readonly nodeId: string;
  readonly componentId: string;
  readonly stateName: string;
};

/** A resume state naming nothing at all, which is how an exchange opens. */
export const NO_RESUME: TextModeResume = {
  nodeId: "",
  componentId: "",
  stateName: "",
};

/** One exchange, whole: what egma sends and what it sends it about. */
export type TextModeExchange = {
  readonly agentId: string;
  /**
   * The version to conduct against. Required, and always sent — see the note
   * at the top of the file.
   */
  readonly agentVersion: number;
  /** The whole history so far. Empty opens the exchange. */
  readonly messages: readonly TextModeTurn[];
  /** The variables this simulation is conducted with, rendered by Retell. */
  readonly dynamicVariables?: Readonly<Record<string, string>> | undefined;
  /** The answers this exchange carries. Absent where the run has none. */
  readonly mockTools?: readonly TextModeMockTool[] | undefined;
  /** Where the agent was left. Absent, or `NO_RESUME`, opens the exchange. */
  readonly resume?: TextModeResume | undefined;
};

/** What one exchange came back with. */
export type TextModeReply = {
  /** The agent's new messages, in the order Retell reported them. */
  readonly messages: readonly TextModeMessage[];
  /** The variables as they now stand, to carry into the next request. */
  readonly dynamicVariables: Readonly<Record<string, string>>;
  /** Where the agent now is, to carry into the next request. */
  readonly resume: TextModeResume;
  /** Whether the agent ended the exchange with this answer. */
  readonly agentEnded: boolean;
};

export type TextModeExchanged =
  | { readonly kind: "exchanged"; readonly reply: TextModeReply }
  | RetellFailure;

function messageFrom(row: unknown): TextModeMessage | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const held = row as Record<string, unknown>;
  const role = plain(held["role"]);
  if (role === "") return null;
  return {
    role,
    content: typeof held["content"] === "string" ? held["content"] : "",
    name: plain(held["name"]),
    arguments: typeof held["arguments"] === "string" ? held["arguments"] : "",
    verbatim: held,
  };
}

/**
 * The variables off a reply: names against strings, and nothing else.
 *
 * A value Retell answered that is not a string is dropped rather than coerced.
 * A rendered variable is a string, and `String(value)` on something else would
 * put `[object Object]` into the next request as if the agent had set it there.
 */
function variablesIn(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const held: Record<string, string> = {};
  for (const [name, one] of Object.entries(value as Record<string, unknown>)) {
    if (typeof one === "string") held[name] = one;
  }
  return held;
}

function resumeIn(document: Readonly<Record<string, unknown>>): TextModeResume {
  return {
    nodeId: plain(document[WIRE.nodeId]),
    componentId: plain(document[WIRE.componentId]),
    stateName: plain(document[WIRE.stateName]),
  };
}

/**
 * One answer as the wire carries it: untagged, JSON-encoded, with a flag for
 * which branch it is.
 */
function mockOnTheWire(mock: TextModeMockTool): PlaygroundCompletionParams.ToolMock {
  const fails = "error" in mock.answer;
  const held = fails ? mock.answer.error : mock.answer.answer;
  return {
    [WIRE.mockToolName]: mock.toolName,
    [WIRE.mockToolMatch]: WIRE.matchAnything,
    // **Encoded whatever it is, strings included.** The transport carries a
    // string, so an answer that happens to be one is tempting to pass through
    // — and passing it through would send `card declined` where the plug
    // sends `"card declined"`. Every failure branch is a string, so that one
    // exception would have made the two halves of egma disagree about every
    // error mock on this lane.
    [WIRE.mockToolOutput]: JSON.stringify(held ?? null),
    [WIRE.mockToolResult]: !fails,
  };
}

/** The body of one exchange, with nothing in it egma was not given. */
type PlaygroundBody = Omit<PlaygroundCompletionParams, "version">;

function bodyOf(exchange: TextModeExchange): PlaygroundBody {
  const body: PlaygroundBody = {
    [WIRE.messages]: exchange.messages.map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  };

  // Absent stays absent throughout: an empty variable block is a value Retell
  // renders, and an empty mock list is a claim that the run answers for
  // nothing — neither is the same as saying nothing at all.
  const variables = exchange.dynamicVariables ?? {};
  if (Object.keys(variables).length > 0) {
    body[WIRE.dynamicVariables] = { ...variables };
  }

  const mocks = exchange.mockTools ?? [];
  if (mocks.length > 0) body[WIRE.mockTools] = mocks.map(mockOnTheWire);

  const resume = exchange.resume ?? NO_RESUME;
  if (resume.nodeId !== "") body[WIRE.nodeId] = resume.nodeId;
  if (resume.componentId !== "") body[WIRE.componentId] = resume.componentId;
  if (resume.stateName !== "") body[WIRE.stateName] = resume.stateName;

  return body;
}

/**
 * One text-mode exchange: the history out, the agent's new messages back.
 *
 * The one verb this lane adds, and it neither opens nor closes anything —
 * there is nothing on Retell's side to open or close. A simulation is a
 * sequence of these, each carrying forward the variables and the resume state
 * the last one answered with.
 */
export async function exchangeInTextMode(
  key: RetellCredential,
  exchange: TextModeExchange,
  reach: RetellReach = {},
): Promise<TextModeExchanged> {
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "POST",
      path: `${WIRE.path}/${encodeURIComponent(exchange.agentId)}?version=${exchange.agentVersion}`,
      body: bodyOf(exchange),
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  if (failure !== undefined) return failure;

  const document = parsed(answer);
  const rows = document[WIRE.messages];
  if (!Array.isArray(rows)) {
    return {
      kind: "refused",
      reason: "Retell answered a text-mode exchange without a message list.",
    };
  }

  const messages: TextModeMessage[] = [];
  for (const row of rows) {
    const message = messageFrom(row);
    if (message !== null) messages.push(message);
  }

  // **Laid over what was sent rather than replacing it.** Whether a reply
  // names every variable or only the ones that changed is not settled, so a
  // delta-shaped answer must not silently drop the rest: laying them over
  // loses nothing under either shape, and behaves identically under the whole
  // one. The first name present wins, because only the outbound spelling is
  // well attested.
  const named = WIRE.replyVariables.find((one) => one in document);
  const dynamicVariables = {
    ...(exchange.dynamicVariables ?? {}),
    ...(named === undefined ? {} : variablesIn(document[named])),
  };

  return {
    kind: "exchanged",
    reply: {
      messages,
      dynamicVariables,
      resume: resumeIn(document),
      agentEnded: document[WIRE.agentEnded] === true,
    },
  };
}
