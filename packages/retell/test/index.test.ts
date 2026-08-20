import { describe, expect, it } from "vitest";

import {
  RETELL_REDACTED,
  listAgents,
  listNumbers,
  safeRetellProviderData,
  type RetellCredential,
} from "../src/index.ts";

const key: RetellCredential = { reveal: () => "retell-test-key" };

describe("Retell agent discovery", () => {
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
  it("removes access tokens and authentication header values", () => {
    expect(
      safeRetellProviderData({
        call_id: "call_1",
        access_token: "web-call-token",
        llm_token_usage: { values: [42], average: 42 },
        custom_sip_headers: {
          Authorization: "Bearer customer-secret",
          "X-Api-Key": "customer-api-key",
          "X-Customer-Route": "support",
        },
        nested: {
          headers: [
            { name: "Proxy-Authorization", value: "Basic customer-secret" },
            { name: "X-Customer-Region", value: "west" },
          ],
        },
      }),
    ).toEqual({
      call_id: "call_1",
      access_token: RETELL_REDACTED,
      llm_token_usage: { values: [42], average: 42 },
      custom_sip_headers: {
        Authorization: RETELL_REDACTED,
        "X-Api-Key": RETELL_REDACTED,
        "X-Customer-Route": "support",
      },
      nested: {
        headers: [
          { name: "Proxy-Authorization", value: RETELL_REDACTED },
          { name: "X-Customer-Region", value: "west" },
        ],
      },
    });
  });
});
