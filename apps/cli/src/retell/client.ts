/**
 * Retell's public HTTP API, spoken directly from the terminal.
 *
 * The key belongs to the customer and the account belongs to the customer, so
 * the two requests that use it are made from the customer's own machine and
 * their answers are read here. Nothing about this goes through egma.
 *
 * A Retell voice agent is in two halves, and both are pulled: the agent itself
 * carries the voice and the telephony, and a response engine carries the words
 * and the tools. Which engine an agent has decides which second request is made
 * — and one of the three shapes keeps its words in the customer's own service,
 * where there is nothing for egma to read. That is a real answer, not a failure.
 *
 * **Every document is kept exactly as it arrived**, as text, beside whatever is
 * read out of it. It is the platform's rule for anything a provider sends, and
 * it is the reason a field egma has no place for today is still there tomorrow.
 *
 * Every ending is a value rather than an exception, because a key that is wrong
 * and an account that is empty are different things to say to a developer, and
 * neither is a fault.
 *
 * The provider's own names are used for the provider's own objects — its
 * addresses, its field names, and the three kinds of response engine it offers.
 * Renaming somebody else's API in a client for it would make the client harder
 * to check against their documentation, which is the one thing this file has to
 * stay true to. Everything egma reads out of them is named in egma's words.
 */

import type { Fetch } from "../platform/device-flow.ts";
import type { RetellKey } from "./key.ts";

/** Retell's own address. `RetellReach.url` points somewhere else in a check. */
export const RETELL_API = "https://api.retellai.com";

/** How many agents one listing request asks for. */
const PAGE_SIZE = 1000;

/** Where following pagination stops, so a bad answer cannot loop forever. */
const MAX_PAGES = 20;

/** Where Retell is, and what talks to it. */
export type RetellReach = {
  /** Retell's API. Retell's own address when omitted. */
  readonly url?: string | undefined;
  readonly fetchImpl?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

/** One agent on the account, as a listing names it. */
export type RetellAgent = {
  readonly id: string;
  /** What the customer calls it, or `""` when they have never named it. */
  readonly name: string;
  /** Retell calls this the channel; it is what egma calls a modality. */
  readonly modality: "voice" | "chat";
};

/** A document Retell answered with, exactly as it arrived. */
export type RetellDocument = {
  /** Which half of the agent this is. */
  readonly of: "agent" | "response-engine";
  /** The body as text, unparsed and unaltered. */
  readonly body: string;
};

/** What one agent is made of, and everything it was read out of. */
export type RetellConfig = {
  readonly agentId: string;
  readonly name: string;
  readonly modality: "voice" | "chat";
  /** The voice the agent speaks with, as Retell identifies it. */
  readonly voice: string | null;
  /** Which of Retell's three response engines carries the words. */
  readonly engine: "retell-llm" | "custom-llm" | "conversation-flow";
  /**
   * The words the agent runs on, or `null` when Retell does not hold them —
   * an agent whose model the customer runs themselves keeps its prompt in
   * their own service, and egma inventing one from silence would be worse than
   * egma saying it has none.
   */
  readonly prompt: string | null;
  /** The tools as Retell holds them, unread and unaltered. */
  readonly tools: readonly unknown[];
  /** Everything above, in the form it arrived in. */
  readonly documents: readonly RetellDocument[];
};

export type ListedAgents =
  | { readonly kind: "agents"; readonly agents: readonly RetellAgent[] }
  /** Retell would not take the key. */
  | { readonly kind: "invalid-key" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export type PulledConfig =
  | { readonly kind: "config"; readonly config: RetellConfig }
  | { readonly kind: "invalid-key" }
  /** The agent was listed a moment ago and is not there now. */
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * A string off the wire with nothing in it a terminal would obey.
 *
 * An agent's name is drawn on a screen, and a terminal reads a control
 * character as an instruction rather than as text. They come out at the one
 * edge that reads the wire, so nothing below here has to remember.
 */
function plain(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";
}

/** What a developer is told when Retell never answered. */
export class RetellUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`Retell at ${url} did not answer. Check this machine's network, then try again.`, {
      cause,
    });
    this.name = "RetellUnreachableError";
  }
}

type Answer = {
  readonly status: number;
  /** The body as it arrived, which is what gets kept. */
  readonly body: string;
};

function base(reach: RetellReach): string {
  return (reach.url ?? RETELL_API).replace(/\/+$/u, "");
}

/**
 * One request, with the key in the header and nowhere else.
 *
 * The key is read here and only here on the way out to Retell. Nothing about
 * the request is logged, and nothing about a failure repeats what was sent.
 */
async function ask(
  key: RetellKey,
  reach: RetellReach,
  request: { readonly method: "GET" | "POST"; readonly path: string; readonly body?: unknown },
): Promise<Answer> {
  const url = `${base(reach)}${request.path}`;
  const fetchImpl = reach.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${key.reveal()}`,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(reach.signal === undefined ? {} : { signal: reach.signal }),
    });
  } catch (cause) {
    throw new RetellUnreachableError(base(reach), cause);
  }

  return { status: response.status, body: await response.text() };
}

/** What Retell said went wrong, in words egma can put on a screen. */
function refusalIn(answer: Answer): string {
  try {
    const held = JSON.parse(answer.body) as Record<string, unknown>;
    for (const field of ["error_message", "message", "error", "detail"]) {
      const said = plain(held[field]);
      if (said !== "") return said;
    }
  } catch {
    // A refusal that is not JSON says nothing useful, and repeating a page of
    // HTML at a terminal is worse than saying what the number means.
  }
  return `Retell answered ${answer.status}`;
}

function parsed(answer: Answer): Record<string, unknown> {
  try {
    const held = JSON.parse(answer.body) as unknown;
    return typeof held === "object" && held !== null ? (held as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A listed agent, or `null` for a row that is not one. */
function agentFrom(row: unknown): RetellAgent | null {
  if (typeof row !== "object" || row === null) return null;
  const held = row as Record<string, unknown>;
  const id = plain(held["agent_id"]);
  if (id === "") return null;
  return {
    id,
    name: plain(held["agent_name"]),
    modality: held["channel"] === "chat" ? "chat" : "voice",
  };
}

/**
 * Every agent on the account the key belongs to.
 *
 * This is also how the key is checked: there is no cheaper request that proves
 * a key works, and the answer to it is the next thing the flow needs anyway.
 */
export async function listAgents(key: RetellKey, reach: RetellReach = {}): Promise<ListedAgents> {
  const agents: RetellAgent[] = [];
  let paginationKey: string | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await ask(key, reach, {
        method: "POST",
        path:
          paginationKey === undefined
            ? `/v2/list-agents?limit=${PAGE_SIZE}`
            : `/v2/list-agents?limit=${PAGE_SIZE}&pagination_key=${encodeURIComponent(paginationKey)}`,
        body: {},
      });

      if (answer.status === 401 || answer.status === 403) return { kind: "invalid-key" };
      if (answer.status < 200 || answer.status >= 300) {
        return { kind: "refused", reason: refusalIn(answer) };
      }

      const held = parsed(answer);
      const items = Array.isArray(held["items"]) ? (held["items"] as unknown[]) : [];
      for (const row of items) {
        const agent = agentFrom(row);
        if (agent !== null) agents.push(agent);
      }

      const next = plain(held["pagination_key"]);
      if (held["has_more"] !== true || next === "") break;
      paginationKey = next;
    }
  } catch (cause) {
    if (cause instanceof RetellUnreachableError) {
      return { kind: "unreachable", reason: cause.message };
    }
    throw cause;
  }

  return { kind: "agents", agents };
}

/** Which second request an agent's response engine calls for, if any. */
function enginePath(engine: Record<string, unknown>): { path: string; version: unknown } | null {
  const type = plain(engine["type"]);
  const version = engine["version"];
  if (type === "retell-llm") {
    const id = plain(engine["llm_id"]);
    return id === "" ? null : { path: `/get-retell-llm/${encodeURIComponent(id)}`, version };
  }
  if (type === "conversation-flow") {
    const id = plain(engine["conversation_flow_id"]);
    return id === "" ? null : { path: `/get-conversation-flow/${encodeURIComponent(id)}`, version };
  }
  return null;
}

function engineKind(engine: Record<string, unknown>): RetellConfig["engine"] {
  const type = plain(engine["type"]);
  if (type === "custom-llm") return "custom-llm";
  if (type === "conversation-flow") return "conversation-flow";
  return "retell-llm";
}

/**
 * The words and the tools out of a response engine.
 *
 * Retell's two hosted engines each have their own name for the prompt, and
 * neither is read out of the other: a flow's `global_prompt` and an LLM's
 * `general_prompt` are the same idea under different names, and guessing
 * between them would put an empty prompt on screen for one of the two.
 */
function wordsIn(
  kind: RetellConfig["engine"],
  document: Record<string, unknown>,
): { prompt: string | null; tools: readonly unknown[] } {
  if (kind === "conversation-flow") {
    const prompt = document["global_prompt"];
    return {
      prompt: typeof prompt === "string" ? prompt : null,
      tools: Array.isArray(document["tools"]) ? (document["tools"] as unknown[]) : [],
    };
  }
  const prompt = document["general_prompt"];
  return {
    prompt: typeof prompt === "string" ? prompt : null,
    tools: Array.isArray(document["general_tools"]) ? (document["general_tools"] as unknown[]) : [],
  };
}

/**
 * Where one agent's own document is.
 *
 * One listing answers with both kinds of agent, and each kind is then read at
 * its own address: Retell serves a chat agent from `/get-chat-agent/` and
 * answers `/get-agent/` for it with nothing. Which kind this is comes from the
 * listing, so the right door is known before it is knocked on — asking the
 * wrong one would tell a developer their agent had gone away.
 */
function agentPath(agent: RetellAgent): string {
  const id = encodeURIComponent(agent.id);
  return agent.modality === "chat" ? `/get-chat-agent/${id}` : `/get-agent/${id}`;
}

/**
 * One agent's whole configuration, in both halves and in both forms.
 *
 * `modality` comes from the listing rather than from the agent document,
 * because that is where Retell says it — the agent itself does not carry it.
 */
export async function pullAgent(
  key: RetellKey,
  agent: RetellAgent,
  reach: RetellReach = {},
): Promise<PulledConfig> {
  let answer: Answer;
  try {
    answer = await ask(key, reach, { method: "GET", path: agentPath(agent) });
  } catch (cause) {
    if (cause instanceof RetellUnreachableError) {
      return { kind: "unreachable", reason: cause.message };
    }
    throw cause;
  }

  if (answer.status === 401 || answer.status === 403) return { kind: "invalid-key" };
  if (answer.status === 404) return { kind: "gone" };
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "refused", reason: refusalIn(answer) };
  }

  const documents: RetellDocument[] = [{ of: "agent", body: answer.body }];
  const document = parsed(answer);
  const rawEngine = document["response_engine"];
  const engine =
    typeof rawEngine === "object" && rawEngine !== null
      ? (rawEngine as Record<string, unknown>)
      : {};
  const kind = engineKind(engine);

  let prompt: string | null = null;
  let tools: readonly unknown[] = [];

  const second = enginePath(engine);
  if (second !== null) {
    let engineAnswer: Answer;
    try {
      engineAnswer = await ask(key, reach, {
        method: "GET",
        path:
          typeof second.version === "number"
            ? `${second.path}?version=${second.version}`
            : second.path,
      });
    } catch (cause) {
      if (cause instanceof RetellUnreachableError) {
        return { kind: "unreachable", reason: cause.message };
      }
      throw cause;
    }

    if (engineAnswer.status === 401 || engineAnswer.status === 403) return { kind: "invalid-key" };
    if (engineAnswer.status === 404) return { kind: "gone" };
    if (engineAnswer.status < 200 || engineAnswer.status >= 300) {
      return { kind: "refused", reason: refusalIn(engineAnswer) };
    }

    documents.push({ of: "response-engine", body: engineAnswer.body });
    const words = wordsIn(kind, parsed(engineAnswer));
    prompt = words.prompt;
    tools = words.tools;
  }

  return {
    kind: "config",
    config: {
      agentId: agent.id,
      // The listing and the agent document can disagree only if the agent was
      // renamed between the two requests; the document is the newer of the two.
      name: plain(document["agent_name"]) === "" ? agent.name : plain(document["agent_name"]),
      modality: agent.modality,
      voice: plain(document["voice_id"]) === "" ? null : plain(document["voice_id"]),
      engine: kind,
      prompt,
      tools,
      documents,
    },
  };
}
