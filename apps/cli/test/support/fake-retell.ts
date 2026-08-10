/**
 * Retell, faked, speaking the shapes its published SDK speaks.
 *
 * The CLI talks to Retell over plain HTTP, so that is the seam a check stands
 * in at: a server on this machine answering `/v2/list-agents`, `/get-agent/…`,
 * `/get-chat-agent/…`, `/get-retell-llm/…`, `/get-conversation-flow/…`,
 * `/list-phone-numbers` and `/get-phone-number/…` with the fields the SDK's own
 * types name. Nothing in CI ever reaches the real Retell, and no real key
 * exists anywhere near these checks.
 *
 * **The number rows carry `inbound_agents` and nothing else about routing**,
 * which is the shape the real service answers with — every number on the
 * account this effort ran against reports its assignment there and carries no
 * single-agent field at all.
 *
 * It is exactly as strict as Retell is, and never kinder. An agent is served
 * only at the address for its own kind, a required field is always sent, and a
 * key it does not know is refused — because a fake that forgives what the real
 * one refuses is a fake that lets a broken client pass.
 *
 * It records what it was asked, including which key was offered, so a check can
 * assert that the key reached the one place it is supposed to reach.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One agent as the listing answers it. */
export type FakeAgentRow = {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly channel?: "voice" | "chat";
};

/** What `/get-agent/:id` or `/get-chat-agent/:id` answers, and what its engine holds. */
export type FakeAgent = {
  readonly agent_id: string;
  readonly agent_name?: string;
  readonly voice_id?: string;
  readonly channel?: "voice" | "chat";
  readonly response_engine?: Record<string, unknown>;
  /** Anything else this agent carries, kept as Retell would answer it. */
  readonly extra?: Record<string, unknown>;
};

/** A Retell LLM, the commonest response engine. */
export type FakeLlm = {
  readonly llm_id: string;
  readonly general_prompt?: string | null;
  readonly general_tools?: readonly unknown[];
  readonly extra?: Record<string, unknown>;
};

/** One telephone number on the account, as Retell answers it. */
export type FakeNumber = {
  readonly phone_number: string;
  readonly nickname?: string;
  /** Every agent Retell routes an inbound call on it to, with its weight. */
  readonly inbound_agents?: readonly { readonly agent_id: string; readonly weight?: number }[];
  readonly extra?: Record<string, unknown>;
};

/** A conversation flow, the other engine Retell holds the words for. */
export type FakeFlow = {
  readonly conversation_flow_id: string;
  readonly global_prompt?: string | null;
  readonly tools?: readonly unknown[];
  readonly extra?: Record<string, unknown>;
};

export type FakeRetellScript = {
  /** The keys this account answers to. Anything else is refused. */
  readonly keys: readonly string[];
  readonly agents: readonly FakeAgent[];
  readonly llms?: readonly FakeLlm[];
  readonly flows?: readonly FakeFlow[];
  /** The account's telephone numbers. None when omitted. */
  readonly numbers?: readonly FakeNumber[];
  /**
   * How many agents one listing answers with, so following pages can be
   * checked. The whole account in one answer when omitted.
   */
  readonly pageSize?: number;
  /** Answer every request with this status and body instead. */
  readonly refuseWith?: { readonly status: number; readonly body: unknown };
};

/** One request, as the fake saw it. */
export type FakeRetellRequest = {
  readonly method: string;
  readonly path: string;
  /** The key offered in the header, which is the only place it may appear. */
  readonly key: string;
  /** Everything else about the request, so a check can prove where it was not. */
  readonly body: string;
  readonly query: string;
};

export type FakeRetell = {
  /** The address to point the CLI at. */
  readonly url: string;
  readonly requests: readonly FakeRetellRequest[];
  /** The exact bytes this fake answered a path with, for a byte-for-byte check. */
  answered(path: string): string | undefined;
  close(): Promise<void>;
};

function agentBody(agent: FakeAgent): Record<string, unknown> {
  return {
    agent_id: agent.agent_id,
    ...(agent.agent_name === undefined ? {} : { agent_name: agent.agent_name }),
    ...(agent.voice_id === undefined ? {} : { voice_id: agent.voice_id }),
    ...(agent.response_engine === undefined ? {} : { response_engine: agent.response_engine }),
    version: 0,
    last_modification_timestamp: 1_700_000_000_000,
    ...(agent.extra ?? {}),
  };
}

function llmBody(llm: FakeLlm): Record<string, unknown> {
  return {
    llm_id: llm.llm_id,
    version: 0,
    general_prompt: llm.general_prompt ?? null,
    general_tools: llm.general_tools ?? [],
    last_modification_timestamp: 1_700_000_000_000,
    ...(llm.extra ?? {}),
  };
}

function flowBody(flow: FakeFlow): Record<string, unknown> {
  return {
    conversation_flow_id: flow.conversation_flow_id,
    version: 0,
    global_prompt: flow.global_prompt ?? null,
    tools: flow.tools ?? [],
    nodes: [],
    last_modification_timestamp: 1_700_000_000_000,
    ...(flow.extra ?? {}),
  };
}

function numberBody(number: FakeNumber): Record<string, unknown> {
  return {
    phone_number: number.phone_number,
    phone_number_type: "retell-telnyx",
    phone_number_pretty: number.phone_number,
    ...(number.nickname === undefined ? {} : { nickname: number.nickname }),
    inbound_agents: (number.inbound_agents ?? []).map((held) => ({
      weight: held.weight ?? 1,
      agent_id: held.agent_id,
    })),
    last_modification_timestamp: 1_700_000_000_000,
    ...(number.extra ?? {}),
  };
}

export async function startFakeRetell(script: FakeRetellScript): Promise<FakeRetell> {
  const requests: FakeRetellRequest[] = [];
  const answers = new Map<string, string>();

  const server: Server = createServer(
    (incoming: IncomingMessage, outgoing: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");

        const at = new URL(incoming.url ?? "/", "http://retell.invalid");
        const key = (incoming.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");

        requests.push({
          method: incoming.method ?? "GET",
          path: at.pathname,
          key,
          body: raw,
          query: at.search,
        });

        const send = (status: number, body: unknown): void => {
          const text = JSON.stringify(body);
          if (status >= 200 && status < 300) answers.set(at.pathname, text);
          outgoing.writeHead(status, { "content-type": "application/json" });
          outgoing.end(text);
        };

        if (script.refuseWith !== undefined) {
          send(script.refuseWith.status, script.refuseWith.body);
          return;
        }

        if (!script.keys.includes(key)) {
          // What Retell answers a key it does not know.
          send(401, { error_message: "Invalid API key" });
          return;
        }

        if (incoming.method === "POST" && at.pathname === "/v2/list-agents") {
          // Retell pages its listing: a caller reads `items`, then asks again
          // with `pagination_key` for as long as `has_more` is true.
          const size = script.pageSize ?? script.agents.length;
          const from = Number(at.searchParams.get("pagination_key") ?? "0");
          const page = size < 1 ? script.agents : script.agents.slice(from, from + size);
          const next = from + page.length;

          send(200, {
            items: page.map((agent) => ({
              agent_id: agent.agent_id,
              agent_name: agent.agent_name ?? "",
              channel: agent.channel ?? "voice",
              tags: {},
              user_modified_timestamp: 1_700_000_000_000,
            })),
            has_more: next < script.agents.length,
            ...(next < script.agents.length ? { pagination_key: String(next) } : {}),
          });
          return;
        }

        // Two addresses, one for each kind of agent, and neither answers for
        // the other — which is how a client that knocks on the wrong door is
        // caught here rather than on somebody's real account.
        for (const [prefix, channel] of [
          ["/get-agent/", "voice"],
          ["/get-chat-agent/", "chat"],
        ] as const) {
          if (incoming.method !== "GET" || !at.pathname.startsWith(prefix)) continue;
          const id = decodeURIComponent(at.pathname.slice(prefix.length));
          const agent = script.agents.find(
            (held) => held.agent_id === id && (held.channel ?? "voice") === channel,
          );
          if (agent === undefined) {
            send(404, { error_message: "agent not found" });
            return;
          }
          send(200, agentBody(agent));
          return;
        }

        if (incoming.method === "GET" && at.pathname === "/list-phone-numbers") {
          // A bare array, which is what Retell answers here — not the paged
          // envelope the agent listing uses.
          send(200, (script.numbers ?? []).map(numberBody));
          return;
        }

        if (incoming.method === "GET" && at.pathname.startsWith("/get-phone-number/")) {
          const wanted = decodeURIComponent(at.pathname.slice("/get-phone-number/".length));
          const number = (script.numbers ?? []).find(
            (held) => held.phone_number === wanted,
          );
          if (number === undefined) {
            send(404, { error_message: "phone number not found" });
            return;
          }
          send(200, numberBody(number));
          return;
        }

        if (incoming.method === "GET" && at.pathname.startsWith("/get-retell-llm/")) {
          const id = decodeURIComponent(at.pathname.slice("/get-retell-llm/".length));
          const llm = (script.llms ?? []).find((held) => held.llm_id === id);
          if (llm === undefined) {
            send(404, { error_message: "llm not found" });
            return;
          }
          send(200, llmBody(llm));
          return;
        }

        if (incoming.method === "GET" && at.pathname.startsWith("/get-conversation-flow/")) {
          const id = decodeURIComponent(at.pathname.slice("/get-conversation-flow/".length));
          const flow = (script.flows ?? []).find((held) => held.conversation_flow_id === id);
          if (flow === undefined) {
            send(404, { error_message: "conversation flow not found" });
            return;
          }
          send(200, flowBody(flow));
          return;
        }

        send(404, { error_message: `nothing serves ${at.pathname}` });
      })();
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    answered: (path) => answers.get(path),
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
