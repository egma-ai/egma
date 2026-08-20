import { describe, expect, it } from "vitest";

import {
  getRetellCall,
  hydrateRetellCall,
  listTerminalCalls,
  type RetellCallPageRequest,
} from "../src/retell/api.ts";

const WINDOW: RetellCallPageRequest = {
  retellAgentId: "agent_voice_1",
  from: new Date("2026-07-20T00:00:00.000Z"),
  to: new Date("2026-08-19T00:00:00.000Z"),
  paginationKey: "opaque/first+cursor",
  limit: 25,
};

describe("Retell production call reads", () => {
  it("lists one v3 page with typed terminal filters and Retell's opaque cursor", async () => {
    let request: { readonly url: string; readonly init: RequestInit } | undefined;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = { url: String(input), init: init ?? {} };
      return new Response(
        JSON.stringify({
          items: [
            {
              call_id: "call_1",
              agent_id: "agent_voice_1",
              call_status: "not_connected",
              call_type: "web_call",
              access_token: "web-call-access-token",
              custom_sip_headers: {
                Authorization: "Bearer customer-secret",
                "X-Customer-Route": "support",
              },
            },
          ],
          has_more: true,
          pagination_key: "opaque/next+cursor",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const answer = await listTerminalCalls("retell-api-key", WINDOW, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(request?.url).toBe("https://retell.invalid/v3/list-calls");
    expect(JSON.parse(String(request?.init.body))).toEqual({
      filter_criteria: {
        agent: [{ agent_id: "agent_voice_1" }],
        call_status: {
          type: "enum",
          op: "in",
          value: ["ended", "error", "not_connected"],
        },
        end_timestamp: {
          type: "range",
          op: "bt",
          value: [1_784_505_600_000, 1_787_097_600_000],
        },
      },
      sort_order: "ascending",
      limit: 25,
      pagination_key: "opaque/first+cursor",
    });
    expect(answer).toEqual({
      kind: "calls",
      calls: [
        {
          call_id: "call_1",
          agent_id: "agent_voice_1",
          call_status: "not_connected",
          call_type: "web_call",
          access_token: "[REDACTED]",
          custom_sip_headers: {
            Authorization: "[REDACTED]",
            "X-Customer-Route": "support",
          },
        },
      ],
      hasMore: true,
      paginationKey: "opaque/next+cursor",
    });
  });

  it("refuses a page that cannot advance the fixed scan", async () => {
    for (const paginationKey of ["", "opaque/earlier+cursor"] as const) {
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            items: [],
            has_more: true,
            ...(paginationKey === "" ? {} : { pagination_key: paginationKey }),
          }),
          { status: 200 },
        )) as typeof fetch;

      const answer = await listTerminalCalls(
        "retell-api-key",
        {
          ...WINDOW,
          seenPaginationKeys: new Set(["opaque/earlier+cursor"]),
        },
        { url: "https://retell.invalid", fetchImpl },
      );

      expect(answer).toEqual({
        kind: "refused",
        reason: "provider-contract",
      });
    }
  });

  it("refuses a v3 page item with no usable call id", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          items: [{ agent_id: "agent_voice_1", call_status: "ended" }],
          has_more: false,
        }),
        { status: 200 },
      )) as typeof fetch;

    await expect(
      listTerminalCalls("retell-api-key", WINDOW, {
        url: "https://retell.invalid",
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: "refused", reason: "invalid-response" });
  });

  it("hydrates a v3 item through Get Call before it is normalized", async () => {
    let requested = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      requested = String(input);
      return new Response(
        JSON.stringify({
          call_id: "call/needs+escaping",
          agent_id: "agent_voice_1",
          call_status: "ended",
          call_type: "web_call",
          start_timestamp: 1_786_000_000_000,
          end_timestamp: 1_786_000_074_000,
          access_token: "hydrated-web-call-token",
          custom_sip_headers: {
            "Proxy-Authorization": "Basic customer-secret",
            "X-Customer-Route": "support",
          },
          transcript_with_tool_calls: [
            { role: "user", content: "Hello", words: [] },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const answer = await hydrateRetellCall(
      "retell-api-key",
      {
        call_id: "call/needs+escaping",
        agent_version: 7,
        access_token: "listed-web-call-token",
      },
      { url: "https://retell.invalid", fetchImpl },
    );

    expect(requested).toBe(
      "https://retell.invalid/v2/get-call/call%2Fneeds%2Bescaping",
    );
    expect(answer).toEqual({
      kind: "call",
      call: {
        call_id: "call/needs+escaping",
        agent_version: 7,
        agent_id: "agent_voice_1",
        call_status: "ended",
        call_type: "web_call",
        start_timestamp: 1_786_000_000_000,
        end_timestamp: 1_786_000_074_000,
        access_token: "[REDACTED]",
        custom_sip_headers: {
          "Proxy-Authorization": "[REDACTED]",
          "X-Customer-Route": "support",
        },
        transcript_with_tool_calls: [
          { role: "user", content: "Hello", words: [] },
        ],
      },
    });
  });

  it("separates a missing call from a malformed full document", async () => {
    const missing = await getRetellCall("retell-api-key", "call_missing", {
      url: "https://retell.invalid",
      fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    expect(missing).toEqual({ kind: "not-found" });

    const malformed = await getRetellCall("retell-api-key", "call_wanted", {
      url: "https://retell.invalid",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ call_id: "call_other" }), {
          status: 200,
        })) as typeof fetch,
    });
    expect(malformed).toEqual({
      kind: "refused",
      reason: "invalid-response",
    });
  });

  it("returns a safe rate-limit fact without Retell's raw error body", async () => {
    const providerSecret = "SENTINEL-provider-error-access-token";
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          message: `Retell echoed ${providerSecret}`,
          access_token: providerSecret,
        }),
        {
          status: 429,
          headers: { "retry-after": "12" },
        },
      )) as typeof fetch;

    const answer = await listTerminalCalls("retell-api-key", WINDOW, {
      url: "https://retell.invalid",
      fetchImpl,
    });

    expect(answer).toEqual({
      kind: "refused",
      reason: "rate-limited",
      status: 429,
      retryAfterMilliseconds: 12_000,
    });
    expect(JSON.stringify(answer)).not.toContain(providerSecret);
  });

  it("treats a response body read failure as unreachable without exposing its cause", async () => {
    const providerSecret = "SENTINEL-provider-body-read-secret";
    const response = new Response("", { status: 200 });
    Object.defineProperty(response, "text", {
      value: async () => {
        throw new DOMException(providerSecret, "AbortError");
      },
    });

    const answer = await listTerminalCalls("retell-api-key", WINDOW, {
      url: "https://retell.invalid",
      fetchImpl: (async () => response) as typeof fetch,
    });

    expect(answer).toEqual({
      kind: "unreachable",
      reason: "Retell at https://retell.invalid did not answer",
    });
    expect(JSON.stringify(answer)).not.toContain(providerSecret);
  });
});
