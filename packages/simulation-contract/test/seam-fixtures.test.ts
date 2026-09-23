import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The HTTPS exchange a Pipecat bot's SDK speaks is the in-room exchange's
 * messages over another carrier. These tests hold the two fixture files to
 * each other, so a version, a code, a cap or a message cannot move in one
 * and not the other.
 */

const seamDirectory = fileURLToPath(new URL("../fixtures/seam/", import.meta.url));

async function fixture(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(seamDirectory, name), "utf8")) as Record<
    string,
    any
  >;
}

const room = await fixture("mock-tool-exchange.v1.json");
const https = await fixture("sdk-https-exchange.v1.json");

describe("the HTTPS exchange, held to the in-room one", () => {
  it("speaks the same protocol version and carries the same answer cap", () => {
    expect(https.protocol_version).toBe(room.protocol_version);
    expect(https.limits.largest_answer_bytes).toBe(room.limits.largest_payload_bytes);
  });

  it("refuses with the room's codes, and adds only the Flows refusal", () => {
    const roomCodes = (room.refusals as { code: number; means: string }[]).map(
      ({ code, means }) => ({ code, means }),
    );
    const httpsCodes = (https.refusals as { code: number; means: string }[]).map(
      ({ code, means }) => ({ code, means }),
    );
    expect(httpsCodes.slice(0, roomCodes.length)).toEqual(roomCodes);
    expect(httpsCodes.slice(roomCodes.length)).toEqual([
      {
        code: 905,
        means: "A mocked tool that is a Pipecat Flows function, which egma cannot mock yet.",
      },
    ]);
  });

  it("answers a hello and a tool call in the room's own shapes", () => {
    const helloReply = JSON.parse(room.messages.hello_reply.bytes as string);
    expect(Object.keys(https.exchanges.hello.response).sort()).toEqual(
      Object.keys(helloReply).sort(),
    );
    expect(JSON.parse(https.exchanges.hello.bytes as string)).toEqual(
      https.exchanges.hello.response,
    );
    expect(https.exchanges.tool_answer.bytes).toBe(room.messages.tool_reply_answer.bytes);
    expect(https.exchanges.tool_error.bytes).toBe(room.messages.tool_reply_error.bytes);

    const { provider_reference: _reference, ...helloRequest } =
      https.exchanges.hello.request as Record<string, unknown>;
    const roomHello = JSON.parse(room.messages.hello_request.bytes as string);
    expect(Object.keys(helloRequest).sort()).toEqual(Object.keys(roomHello).sort());
  });

  it("names a world, a route and a status for every exchange, and resolves every reference", () => {
    for (const [name, exchange] of Object.entries(
      https.exchanges as Record<string, Record<string, unknown>>,
    )) {
      expect(["hello", "tool", "confirm"], name).toContain(exchange.route);
      expect(typeof exchange.status, name).toBe("number");
      if (exchange.world !== undefined) {
        expect(Object.keys(https.worlds), name).toContain(exchange.world);
      }
      if (exchange.response_is !== undefined) {
        expect(exchange.response_is, name).toBe("not_a_simulation.body");
        expect(exchange.status, name).toBe(https.not_a_simulation.status);
      }
      if (exchange.request_is !== undefined) {
        expect(exchange.request_is, name).toBe("exchanges.hello.request");
      }
    }
  });

  it("answers mocked_tools with every name the world mocks, in authored order", () => {
    const mocked = (https.worlds.calendar.mock_tools as { tool: string }[]).map(
      (entry) => entry.tool,
    );
    expect(https.exchanges.hello.response.mocked_tools).toEqual(mocked);
    expect(https.agent_report.accepted.response.mocked_tools).toEqual(mocked);
    expect(https.exchanges.hello_flows_mocked.response.message).toBe(
      https.agent_report.refused.response.message,
    );
  });
});
