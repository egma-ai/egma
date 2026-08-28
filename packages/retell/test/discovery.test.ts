import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { discoverTools, seededAnswerFor, type EngineConfiguration } from "../src/index.ts";

/**
 * What ticking the box finds, and what it seeds.
 *
 * Read off the captured configurations rather than off a hand-written tool, so
 * that a seed is proved against the shapes Retell really answers with —
 * including the tool whose name carries characters a URL has to encode and the
 * MCP server that carries no `type` field at all.
 */

const flow = (): EngineConfiguration => ({
  reference: {
    type: "conversation-flow",
    engineId: "conversation_flow_2346a0e8367c",
    version: 105,
  },
  document: JSON.parse(
    readFileSync(new URL("./fixtures/conversation-flow.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>,
});

const llm = (): EngineConfiguration => ({
  reference: { type: "retell-llm", engineId: "llm_5f1c02", version: 105 },
  document: JSON.parse(
    readFileSync(new URL("./fixtures/retell-llm.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>,
});

describe("what a tick discovers", () => {
  it("puts every tool in its honest class, and seeds only the ones Egma answers", () => {
    const found = discoverTools(flow());

    expect(found.coverage).toEqual({
      mocked: ["get_availability", "book_appointment", "price list/lookup?v=2"],
      notInterceptable: [
        "normalise_phone",
        "transfer_to_front_desk",
        "text_directions",
        "end_call",
      ],
      notInThisVersion: ["inventory"],
    });

    // A seed for each tool Egma stands in front of, and none for the rest: an
    // answer for a tool nothing can intercept would be an answer nobody serves.
    const seeded = found.tools.filter((tool) => tool.seededAnswer !== null);
    expect(seeded.map((tool) => tool.name)).toEqual([
      "get_availability",
      "book_appointment",
      "price list/lookup?v=2",
    ]);
  });

  it("warns about the two tools that act outside the call, and refuses nothing", () => {
    const found = discoverTools(flow());

    expect(found.warnings).toEqual([
      {
        toolName: "transfer_to_front_desk",
        toolType: "transfer_call",
        effect: "transfers the call to a real destination",
      },
      {
        toolName: "text_directions",
        toolType: "send_sms",
        effect: "sends a real text message",
      },
    ]);
    // A warning is not a refusal: the tick still discovers everything else.
    expect(found.tools.length).toBeGreaterThan(found.warnings.length);
  });

  it("reads both of a Retell LLM's tool arrays", () => {
    const found = discoverTools(llm());
    const names = found.tools.map((tool) => tool.name);
    // A multi-prompt agent keeps most of its tools in its states.
    expect(names.length).toBeGreaterThan(1);
    expect(found.coverage.mocked.length).toBeGreaterThan(0);
  });
});

describe("the answer a tick seeds", () => {
  it("is the shape the tool's own declaration asks to read out of it", () => {
    const found = discoverTools(flow());
    const availability = found.tools.find((tool) => tool.name === "get_availability");
    // `response_variables: { slots: "$.slots" }` — so the answer carries
    // `slots`, which is the key the agent's own extraction reads.
    expect(availability?.seededAnswer).toEqual({ slots: "" });
  });

  it("is a minimal success object where the tool declares no shape", () => {
    const found = discoverTools(flow());
    const booking = found.tools.find((tool) => tool.name === "book_appointment");
    expect(booking?.seededAnswer).toEqual({ success: true });
  });

  it("builds the nesting a dotted path asks for", () => {
    expect(
      seededAnswerFor({
        name: "lookup",
        type: "custom",
        location: { array: "tools" },
        index: 0,
        verbatim: {
          response_variables: { city: "$.address.city", name: "$.name" },
        },
      }),
    ).toEqual({ address: { city: "" }, name: "" });
  });

  it("falls back rather than guessing at a path it cannot read", () => {
    // A filter or an index names a shape this cannot build, and a seed built
    // out of a misread path is an answer the extraction silently finds nothing
    // in. So it says the one thing that is true instead.
    expect(
      seededAnswerFor({
        name: "lookup",
        type: "custom",
        location: { array: "tools" },
        index: 0,
        verbatim: { response_variables: { first: "$.slots[0].id" } },
      }),
    ).toEqual({ success: true });
  });

  it("is the same answer every time it is derived", () => {
    const once = discoverTools(flow());
    const twice = discoverTools(flow());
    expect(once.tools).toEqual(twice.tools);
  });
});
