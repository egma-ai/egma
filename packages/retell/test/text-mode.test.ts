import { describe, expect, it } from "vitest";

import {
  exchangeInTextMode,
  NO_RESUME,
  WIRE,
  type RetellCredential,
} from "../src/index.ts";

/**
 * Text mode verb, against a Retell that only exists in this file.
 *
 * Nothing here reaches a network. What is proved is what a developer would
 * otherwise have to trust a live account for: the request Retell would have
 * received, and the facts the verb reads back out of an answer.
 */

const KEY = "retell-secret-key-9f2b1c";
const key: RetellCredential = { reveal: () => KEY };
const AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";

type Seen = {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
};

/** A stand-in Retell: the requests it saw, and the answer it gave to each. */
function retell(answers: readonly (() => Response)[]): {
  readonly fetchImpl: typeof fetch;
  readonly seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({
      method: init?.method ?? "GET",
      url: String(input),
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {},
      authorization: headers["authorization"] ?? null,
    });
    const answer = answers[seen.length - 1];
    return answer === undefined
      ? new Response("{}", { status: 500 })
      : answer();
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

const REACH = (fetchImpl: typeof fetch) => ({
  url: "https://retell.invalid",
  fetchImpl,
});

describe("one text-mode exchange", () => {
  it("sends the history and reads the agent's new messages back", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          [WIRE.messages]: [
            { role: "agent", content: "Acme Dental, how can I help?" },
            {
              role: "tool_call_invocation",
              name: "check_availability",
              arguments: '{"day":"Thursday"}',
            },
            { role: "tool_call_result", name: "check_availability", content: '{"slots":2}' },
            { role: "agent", content: "Thursday at two is free." },
          ],
          [WIRE.agentEnded]: false,
        }),
    ]);

    const answered = await exchangeInTextMode(
      key,
      {
        agentId: AGENT,
        agentVersion: 106,
        messages: [{ role: "user", content: "I need to move my appointment." }],
      },
      REACH(fetchImpl),
    );

    expect(answered.kind).toBe("exchanged");
    if (answered.kind !== "exchanged") return;
    expect(answered.reply.messages.map((one) => one.role)).toEqual([
      "agent",
      "tool_call_invocation",
      "tool_call_result",
      "agent",
    ]);
    expect(answered.reply.messages[0]?.content).toBe(
      "Acme Dental, how can I help?",
    );
    expect(answered.reply.messages[1]?.name).toBe("check_availability");
    expect(answered.reply.messages[1]?.arguments).toBe('{"day":"Thursday"}');
    expect(answered.reply.agentEnded).toBe(false);

    const sent = seen[0];
    expect(sent?.method).toBe("POST");
    // The agent is named in the path, exactly as the plug names it.
    expect(sent?.url).toBe(`https://retell.invalid${WIRE.path}/${AGENT}`);
    expect(sent?.authorization).toBe(`Bearer ${KEY}`);
    expect(sent?.body[WIRE.messages]).toEqual([
      { role: "user", content: "I need to move my appointment." },
    ]);
  });

  it("names its version on every request, and never leans on the default", async () => {
    // The whole point of the resolve at run start. Retell's own default is the
    // newest version, and the newest version is the one a concurrent edit has
    // just created — so an exchange that said nothing could land somewhere
    // else between one persona turn and the next.
    const { fetchImpl, seen } = retell([
      () => json({ [WIRE.messages]: [] }),
      () => json({ [WIRE.messages]: [] }),
      () => json({ [WIRE.messages]: [] }),
    ]);

    for (const messages of [
      [],
      [{ role: "user", content: "hello" }],
      [
        { role: "user", content: "hello" },
        { role: "agent", content: "hi" },
        { role: "user", content: "Thursday please" },
      ],
    ]) {
      await exchangeInTextMode(
        key,
        { agentId: AGENT, agentVersion: 106, messages },
        REACH(fetchImpl),
      );
    }

    expect(seen).toHaveLength(3);
    for (const sent of seen) {
      expect(sent.body[WIRE.agentVersion]).toBe(106);
    }
    // Never the word, on any request: a name is what a concurrent branch moves.
    expect(JSON.stringify(seen)).not.toContain("latest");
  });

  it("opens with an empty history and no resume state", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          [WIRE.messages]: [{ role: "agent", content: "Acme Dental." }],
          [WIRE.nodeId]: "node_greeting",
        }),
    ]);

    const opened = await exchangeInTextMode(
      key,
      { agentId: AGENT, agentVersion: 3, messages: [], resume: NO_RESUME },
      REACH(fetchImpl),
    );

    expect(opened.kind).toBe("exchanged");
    if (opened.kind !== "exchanged") return;
    expect(opened.reply.messages[0]?.content).toBe("Acme Dental.");
    expect(opened.reply.resume.nodeId).toBe("node_greeting");

    const sent = seen[0];
    expect(sent?.body[WIRE.messages]).toEqual([]);
    // A resume state naming nothing is absent rather than sent empty: an empty
    // node id is not the same as no node id.
    expect(Object.keys(sent?.body ?? {})).not.toContain(WIRE.nodeId);
    expect(Object.keys(sent?.body ?? {})).not.toContain(WIRE.stateName);
  });

  it("threads variables and resume state from one turn into the next", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          [WIRE.messages]: [{ role: "agent", content: "Which day?" }],
          [WIRE.dynamicVariables]: {
            egma_simulation: "sim_1",
            booked_day: "Thursday",
          },
          [WIRE.nodeId]: "node_booking",
          [WIRE.componentId]: "component_day",
          [WIRE.stateName]: "collecting",
        }),
      () => json({ [WIRE.messages]: [], [WIRE.agentEnded]: true }),
    ]);

    const first = await exchangeInTextMode(
      key,
      {
        agentId: AGENT,
        agentVersion: 106,
        messages: [{ role: "user", content: "Thursday" }],
        dynamicVariables: { egma_simulation: "sim_1" },
      },
      REACH(fetchImpl),
    );
    expect(first.kind).toBe("exchanged");
    if (first.kind !== "exchanged") return;
    expect(first.reply.dynamicVariables).toEqual({
      egma_simulation: "sim_1",
      booked_day: "Thursday",
    });
    expect(first.reply.resume).toEqual({
      nodeId: "node_booking",
      componentId: "component_day",
      stateName: "collecting",
    });

    const second = await exchangeInTextMode(
      key,
      {
        agentId: AGENT,
        agentVersion: 106,
        messages: [
          { role: "user", content: "Thursday" },
          { role: "agent", content: "Which day?" },
          { role: "user", content: "That is all, thank you." },
        ],
        dynamicVariables: first.reply.dynamicVariables,
        resume: first.reply.resume,
      },
      REACH(fetchImpl),
    );
    expect(second.kind).toBe("exchanged");
    if (second.kind !== "exchanged") return;
    expect(second.reply.agentEnded).toBe(true);

    const sent = seen[1];
    expect(sent?.body[WIRE.dynamicVariables]).toEqual({
      egma_simulation: "sim_1",
      booked_day: "Thursday",
    });
    expect(sent?.body[WIRE.nodeId]).toBe("node_booking");
    expect(sent?.body[WIRE.componentId]).toBe("component_day");
    expect(sent?.body[WIRE.stateName]).toBe("collecting");
  });

  it("carries its mocked answers on the request and writes nothing", async () => {
    const { fetchImpl, seen } = retell([
      () =>
        json({
          [WIRE.messages]: [
            {
              role: "tool_call_invocation",
              name: "check_availability",
              arguments: "{}",
            },
            { role: "agent", content: "Two o'clock is free." },
          ],
        }),
    ]);

    await exchangeInTextMode(
      key,
      {
        agentId: AGENT,
        agentVersion: 106,
        messages: [{ role: "user", content: "Any slots?" }],
        mockTools: [
          {
            toolName: "check_availability",
            answer: { answer: { slots: ["14:00"] } },
          },
          { toolName: "charge_card", answer: { error: "card declined" } },
        ],
      },
      REACH(fetchImpl),
    );

    expect(seen).toHaveLength(1);
    // One request, and it is the exchange itself. No draft is branched, no
    // engine is written, nothing is pinned — the answers ride along.
    expect(seen[0]?.method).toBe("POST");
    // Untagged and JSON-encoded, with a flag for which branch it is: Retell
    // serves the answer either way and says which one happened in its own
    // words, so egma's own tag never travels.
    expect(seen[0]?.body[WIRE.mockTools]).toEqual([
      {
        [WIRE.mockToolName]: "check_availability",
        [WIRE.mockToolMatch]: WIRE.matchAnything,
        [WIRE.mockToolOutput]: JSON.stringify({ slots: ["14:00"] }),
        [WIRE.mockToolResult]: true,
      },
      {
        [WIRE.mockToolName]: "charge_card",
        [WIRE.mockToolMatch]: WIRE.matchAnything,
        [WIRE.mockToolOutput]: JSON.stringify("card declined"),
        [WIRE.mockToolResult]: false,
      },
    ]);
  });

  it("says nothing about mocks or variables when it has none", async () => {
    const { fetchImpl, seen } = retell([() => json({ [WIRE.messages]: [] })]);

    await exchangeInTextMode(
      key,
      {
        agentId: AGENT,
        agentVersion: 1,
        messages: [],
        mockTools: [],
        dynamicVariables: {},
      },
      REACH(fetchImpl),
    );

    const keys = Object.keys(seen[0]?.body ?? {});
    expect(keys).not.toContain(WIRE.mockTools);
    expect(keys).not.toContain(WIRE.dynamicVariables);
  });

  it("lays a reply's variables over what it sent, losing none to a delta", async () => {
    // Whether a reply names every variable or only the ones that changed is
    // not settled. Laying them over loses nothing under either shape, and
    // behaves identically under the whole one — so a delta-shaped answer
    // cannot quietly drop a variable this simulation was conducted with.
    const { fetchImpl } = retell([
      () =>
        json({
          [WIRE.messages]: [],
          [WIRE.dynamicVariables]: { booked_day: "Thursday" },
        }),
      () =>
        json({
          [WIRE.messages]: [],
          // The other spelling, which is the one that is only a guess.
          dynamic_variables: { booked_day: "Friday" },
        }),
    ]);

    const sent = { egma_simulation: "sim_1", caller_name: "Eleanor" };
    for (const expected of ["Thursday", "Friday"]) {
      const answered = await exchangeInTextMode(
        key,
        {
          agentId: AGENT,
          agentVersion: 106,
          messages: [],
          dynamicVariables: sent,
        },
        REACH(fetchImpl),
      );
      expect(answered.kind).toBe("exchanged");
      if (answered.kind !== "exchanged") return;
      expect(answered.reply.dynamicVariables).toEqual({
        ...sent,
        booked_day: expected,
      });
    }
  });

  it("keeps a message whose role Egma has never seen", async () => {
    // Never dropped in silence: a role Egma does not know is still something
    // the agent did, and a record that left it out would claim the agent was
    // quiet when it was not.
    const { fetchImpl } = retell([
      () =>
        json({
          [WIRE.messages]: [
            { role: "sms_sent", content: "Booking confirmed", to: "+15551234567" },
          ],
        }),
    ]);

    const answered = await exchangeInTextMode(
      key,
      { agentId: AGENT, agentVersion: 9, messages: [] },
      REACH(fetchImpl),
    );
    expect(answered.kind).toBe("exchanged");
    if (answered.kind !== "exchanged") return;
    expect(answered.reply.messages[0]?.role).toBe("sms_sent");
    expect(answered.reply.messages[0]?.verbatim["to"]).toBe("+15551234567");
  });

  it("answers each failure in the words every other verb uses", async () => {
    for (const [status, expected] of [
      [401, "invalid-key"],
      [404, "gone"],
      [429, "refused"],
      [500, "refused"],
    ] as const) {
      const { fetchImpl } = retell([() => json({ message: KEY }, status)]);
      const answered = await exchangeInTextMode(
        key,
        { agentId: AGENT, agentVersion: 1, messages: [] },
        REACH(fetchImpl),
      );
      expect(answered.kind).toBe(expected);
      // Retell's own body never leaves this client, so a platform that echoed
      // the key back cannot put it in a refusal.
      expect(JSON.stringify(answered)).not.toContain(KEY);
    }
  });

  it("refuses an answer that carries no messages at all", async () => {
    const { fetchImpl } = retell([() => json({ ok: true })]);
    const answered = await exchangeInTextMode(
      key,
      { agentId: AGENT, agentVersion: 1, messages: [] },
      REACH(fetchImpl),
    );
    expect(answered).toEqual({
      kind: "refused",
      reason: "Retell answered a text-mode exchange without a message list.",
    });
  });
});
