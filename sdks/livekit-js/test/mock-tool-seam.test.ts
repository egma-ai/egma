import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANSWER_TOO_LARGE,
  HELLO_TIMEOUT_SECONDS,
  HELLO_METHOD,
  LARGEST_PAYLOAD_BYTES,
  LONGEST_DECLARED_DELAY_SECONDS,
  MALFORMED_REQUEST,
  MAX_ROUND_TRIP_SECONDS,
  PROTOCOL_VERSION,
  RESPONSE_TIMEOUT_SECONDS,
  SERVING_MARGIN_SECONDS,
  TOOL_METHOD,
  UNKNOWN_TOOL,
  UNSUPPORTED_PROTOCOL_VERSION,
  SeamError,
  fitsOnTheWire,
  helloRequest,
  isEgmaNotListeningYet,
  isEgmaNotReached,
  isEgmaRefusal,
  mockedToolsIn,
  servedIn,
  toolRequest,
} from "../src/mock-tool-seam.ts";

type Contract = {
  protocol_version: number;
  methods: {
    hello: string;
    tool: string;
  };
  limits: {
    largest_payload_bytes: number;
    longest_delay_milliseconds: number;
  };
  refusals: Array<{ code: number }>;
  reserved_for_the_transport: {
    from: number;
    to: number;
  };
  messages: Record<string, { bytes: string }>;
};

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/simulation-contract/fixtures/seam/mock-tool-exchange.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Contract;

function message(name: string): string {
  const entry = contract.messages[name];
  if (entry === undefined) {
    throw new Error(`missing mock-tool contract message: ${name}`);
  }
  return entry.bytes;
}

describe("mock-tool exchange", () => {
  it("uses the contract version and method names", () => {
    expect(PROTOCOL_VERSION).toBe(contract.protocol_version);
    expect(HELLO_METHOD).toBe(contract.methods.hello);
    expect(TOOL_METHOD).toBe(contract.methods.tool);
  });

  it("keeps the contract limits and classifies refusal codes", () => {
    expect(LARGEST_PAYLOAD_BYTES).toBe(contract.limits.largest_payload_bytes);
    expect(LONGEST_DECLARED_DELAY_SECONDS * 1_000).toBe(
      contract.limits.longest_delay_milliseconds,
    );
    expect(RESPONSE_TIMEOUT_SECONDS).toBe(
      LONGEST_DECLARED_DELAY_SECONDS +
        SERVING_MARGIN_SECONDS +
        MAX_ROUND_TRIP_SECONDS,
    );
    expect(HELLO_TIMEOUT_SECONDS).toBe(
      MAX_ROUND_TRIP_SECONDS + SERVING_MARGIN_SECONDS,
    );

    expect(
      new Set([
        MALFORMED_REQUEST,
        UNKNOWN_TOOL,
        ANSWER_TOO_LARGE,
        UNSUPPORTED_PROTOCOL_VERSION,
      ]),
    ).toEqual(new Set(contract.refusals.map(({ code }) => code)));
    for (const { code } of contract.refusals) {
      expect(isEgmaRefusal(code)).toBe(true);
    }
    expect(isEgmaRefusal(900)).toBe(false);
    expect(isEgmaRefusal(contract.reserved_for_the_transport.from)).toBe(false);

    for (const code of [1400, 1401, 1403, 1404, 1503]) {
      expect(isEgmaNotReached(code)).toBe(true);
    }
    expect(isEgmaNotReached(1402)).toBe(false);
    expect(isEgmaNotListeningYet(1400)).toBe(true);
    expect(isEgmaNotListeningYet(1401)).toBe(false);
  });

  it("builds the golden hello and reads the covered tool names", () => {
    const census = (
      JSON.parse(message("hello_request")) as {
        tools: Array<Record<string, unknown>>;
      }
    ).tools;

    expect(helloRequest(census)).toBe(message("hello_request"));
    expect(mockedToolsIn(message("hello_reply"))).toEqual(["check_calendar"]);
  });

  it("builds both call shapes and reads both tagged replies", () => {
    const asked = JSON.parse(message("tool_request")) as {
      name: string;
      arguments: Record<string, unknown>;
    };

    expect(toolRequest(asked.name, asked.arguments)).toBe(
      message("tool_request"),
    );
    expect(toolRequest(asked.name, undefined)).toBe(
      message("tool_request_without_arguments"),
    );
    expect(servedIn(message("tool_reply_answer"))).toEqual({
      failed: false,
      value: { slots: [] },
    });
    expect(servedIn(message("tool_reply_error"))).toEqual({
      failed: true,
      message: "the calendar service is unavailable",
    });
  });

  it("measures the payload cap in UTF-8 bytes", () => {
    const exact = "é".repeat(LARGEST_PAYLOAD_BYTES / 2);
    expect(() => fitsOnTheWire("tool call", exact)).not.toThrow();

    expect(() => fitsOnTheWire("tool call", `${exact}a`)).toThrow(
      new SeamError(
        `tool call is ${LARGEST_PAYLOAD_BYTES + 1} bytes, and one message of this exchange holds at most ${LARGEST_PAYLOAD_BYTES}`,
      ),
    );
  });

  it("refuses malformed replies instead of guessing an answer", () => {
    for (const reply of [
      "not-json",
      "[]",
      '{"protocol_version":true,"mocked_tools":[]}',
      '{"protocol_version":2,"mocked_tools":[]}',
      '{"protocol_version":1,"mocked_tools":"check_calendar"}',
      '{"protocol_version":1,"mocked_tools":[""]}',
    ]) {
      expect(() => mockedToolsIn(reply)).toThrow(SeamError);
    }
    expect(
      mockedToolsIn(
        '{"protocol_version":1,"mocked_tools":[" check_calendar ","check_calendar"]}',
      ),
    ).toEqual(["check_calendar"]);

    for (const reply of ["not-json", "[]", "{}", '{"error":42}']) {
      expect(() => servedIn(reply)).toThrow(SeamError);
    }
    expect(servedIn('{"answer":"success","error":"failure"}')).toEqual({
      failed: true,
      message: "failure",
    });
  });

  it("writes a value JSON cannot name as text", () => {
    expect(toolRequest("lookup_account", { account_id: 42n })).toBe(
      '{"name":"lookup_account","arguments":{"account_id":"42"}}',
    );
  });
});
