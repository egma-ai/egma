import { describe, expect, it } from "vitest";

import {
  listAgents,
  listNumbers,
  safeRetellProviderData,
  type RetellCredential,
} from "../src/index.ts";

const key: RetellCredential = { reveal: () => "retell-test-key" };

describe("Retell agent discovery", () => {
  it("follows every opaque page and returns every agent in the account", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const cursor = new URL(url).searchParams.get("pagination_key");

      if (cursor === null) {
        return new Response(
          JSON.stringify({
            items: [
              {
                agent_id: "agent_voice_1",
                agent_name: "Voice one",
                channel: "voice",
              },
            ],
            has_more: true,
            pagination_key: "opaque/next+page",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: "agent_chat_2",
              agent_name: "Chat two",
              channel: "chat",
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "agents",
      agents: [
        { id: "agent_voice_1", name: "Voice one", modality: "voice" },
        { id: "agent_chat_2", name: "Chat two", modality: "chat" },
      ],
    });
    expect(asked).toEqual([
      "https://retell.invalid/v2/list-agents?limit=1000",
      "https://retell.invalid/v2/list-agents?limit=1000&pagination_key=opaque%2Fnext%2Bpage",
    ]);
  });

  it("refuses a repeated agent cursor instead of returning duplicate rows", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: `agent_${requests}`,
              agent_name: `Agent ${requests}`,
              channel: "voice",
            },
          ],
          has_more: true,
          pagination_key: "same-cursor",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered an agent page without a new cursor.",
    });
    expect(requests).toBe(2);
  });

  it("refuses a malformed agent page", async () => {
    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
        })) as typeof fetch,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered a malformed agent page.",
    });
  });

  it("continues past twenty agent pages and returns the complete account", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      const hasMore = requests < 21;
      return new Response(
        JSON.stringify({
          items: [
            {
              agent_id: `agent_${requests}`,
              agent_name: `Agent ${requests}`,
              channel: "chat",
            },
          ],
          has_more: hasMore,
          ...(hasMore ? { pagination_key: `cursor_${requests}` } : {}),
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed.kind).toBe("agents");
    if (listed.kind !== "agents") throw new Error("expected every agent page");
    expect(listed.agents).toHaveLength(21);
    expect(listed.agents.at(-1)).toEqual({
      id: "agent_21",
      name: "Agent 21",
      modality: "chat",
    });
    expect(requests).toBe(21);
  });

  it("refuses an agent listing that never reaches its final page", async () => {
    let requests = 0;
    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl: (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            items: [],
            has_more: true,
            pagination_key: `cursor_${requests}`,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered too many agent pages.",
    });
    expect(requests).toBe(100);
  });

  it("admits only rows whose voice or chat channel is explicit", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { agent_id: "agent_voice", agent_name: "Voice", channel: "voice" },
            { agent_id: "agent_chat", agent_name: "Chat", channel: "chat" },
            { agent_id: "agent_missing", agent_name: "Missing" },
            { agent_id: "agent_unknown", agent_name: "Unknown", channel: "video" },
          ],
          has_more: false,
        }),
        { status: 200 },
      )) as typeof fetch;

    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "agents",
      agents: [
        { id: "agent_voice", name: "Voice", modality: "voice" },
        { id: "agent_chat", name: "Chat", modality: "chat" },
      ],
    });
  });

  it("treats a response body read failure as unreachable without exposing its cause", async () => {
    const providerSecret = "SENTINEL-provider-body-read-secret";
    const response = new Response("", { status: 200 });
    Object.defineProperty(response, "text", {
      value: async () => {
        throw new DOMException(providerSecret, "AbortError");
      },
    });

    const listed = await listAgents(key, {
      url: "https://retell.invalid",
      fetchImpl: (async () => response) as typeof fetch,
    });

    expect(listed).toEqual({
      kind: "unreachable",
      reason:
        "Retell at https://retell.invalid did not answer. Check this machine's network, then try again.",
    });
    expect(JSON.stringify(listed)).not.toContain(providerSecret);
  });
});

describe("Retell phone-number discovery", () => {
  it("follows every opaque page from the current v2 listing", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const cursor = new URL(url).searchParams.get("pagination_key");

      if (cursor === null) {
        return new Response(
          JSON.stringify({
            items: [
              {
                phone_number: "+14155550100",
                nickname: "Main",
                inbound_agents: [{ agent_id: "agent_voice_1" }],
              },
            ],
            has_more: true,
            pagination_key: "opaque/next+page",
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          items: [
            {
              phone_number: "+14155550101",
              nickname: "Overflow",
              inbound_agents: [{ agent_id: "agent_voice_2" }],
            },
          ],
          has_more: false,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "numbers",
      numbers: [
        {
          number: "+14155550100",
          label: "Main",
          answeredBy: ["agent_voice_1"],
        },
        {
          number: "+14155550101",
          label: "Overflow",
          answeredBy: ["agent_voice_2"],
        },
      ],
    });
    expect(asked).toEqual([
      "https://retell.invalid/v2/list-phone-numbers?limit=1000&sort_order=ascending",
      "https://retell.invalid/v2/list-phone-numbers?limit=1000&sort_order=ascending&pagination_key=opaque%2Fnext%2Bpage",
    ]);
  });

  it("continues past twenty phone-number pages and returns every route", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      const hasMore = requests < 21;
      return new Response(
        JSON.stringify({
          items: [
            {
              phone_number: `+1415555${String(requests).padStart(4, "0")}`,
              nickname: `Route ${requests}`,
              inbound_agents: [{ agent_id: `agent_${requests}` }],
            },
          ],
          has_more: hasMore,
          ...(hasMore ? { pagination_key: `cursor_${requests}` } : {}),
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed.kind).toBe("numbers");
    if (listed.kind !== "numbers") throw new Error("expected every number page");
    expect(listed.numbers).toHaveLength(21);
    expect(listed.numbers.at(-1)).toEqual({
      number: "+14155550021",
      label: "Route 21",
      answeredBy: ["agent_21"],
    });
    expect(requests).toBe(21);
  });

  it("refuses a repeated phone-number cursor instead of looping", async () => {
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return new Response(
        JSON.stringify({
          items: [],
          has_more: true,
          pagination_key: "same-opaque-cursor",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered a phone-number page without a new cursor.",
    });
    expect(requests).toBe(2);
  });

  it("refuses a phone-number listing that never reaches its final page", async () => {
    let requests = 0;
    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl: (async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            items: [],
            has_more: true,
            pagination_key: `cursor_${requests}`,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered too many phone-number pages.",
    });
    expect(requests).toBe(100);
  });

  it("refuses a response that is not the current pagination envelope", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell answered a malformed phone-number page.",
    });
  });

  it("does not repeat a provider error body", async () => {
    const providerSecret = "provider-echoed-customer-secret";
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error_message: providerSecret }),
        { status: 503 },
      )) as typeof fetch;

    const listed = await listNumbers(key, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(listed).toEqual({
      kind: "refused",
      reason: "Retell is unavailable. Try again.",
    });
    expect(JSON.stringify(listed)).not.toContain(providerSecret);
  });
});

describe("Retell provider data", () => {
  it("omits the access token and the named SIP authentication headers", () => {
    const safe = safeRetellProviderData({
      call_id: "call_1",
      access_token: "web-call-token",
      custom_sip_headers: {
        Authorization: "Bearer customer-secret",
        "proxy-authorization": "Basic customer-secret",
        Cookie: "session=customer",
        "Set-Cookie": "session=customer",
        "API-Key": "customer-api-key",
        "X-Api-Key": "customer-api-key",
        "X-Customer-Route": "support",
      },
    });

    expect(safe).toEqual({
      call_id: "call_1",
      custom_sip_headers: { "X-Customer-Route": "support" },
    });
    // Absent, and nothing standing where they were: a marker is a value, and a
    // value is evidence.
    expect(Object.keys(safe)).not.toContain("access_token");
    expect(JSON.stringify(safe)).not.toContain("REDACTED");
  });

  it("keeps every other field exactly, credential-looking ones included", () => {
    const document = {
      call_id: "call_1",
      transcript: "My password is hunter2 and the token is Bearer abc.123",
      llm_token_usage: { values: [42], average: 42 },
      metadata: { secret: "customer-chose-this-name", api_key: "not-ours" },
      // The six names matter only inside Retell's own named map. A customer's
      // own header collection is customer data.
      nested: {
        headers: [
          { name: "Proxy-Authorization", value: "Basic customer-secret" },
          { name: "X-Customer-Region", value: "west" },
        ],
        access_token: "a field a customer named, not the one Retell mints",
      },
      call_analysis: { custom_analysis_data: { authorization: "kept" } },
    };

    expect(JSON.stringify(safeRetellProviderData(document))).toBe(
      JSON.stringify(document),
    );
  });
});
