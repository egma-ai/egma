import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  mockedToolsFor,
  mockToolUrl,
  SIMULATION_VARIABLE,
  toolCoverageOf,
  toolsOf,
  type EngineConfiguration,
  type EngineReference,
} from "../src/index.ts";

/**
 * The transform, checked against captured configurations of both engines.
 *
 * Every promise the draft makes is a promise about these bytes: the contract
 * the model reads is unchanged, the two fields that move are the only two that
 * move, every tool egma cannot stand in front of is named on the record, and
 * the customer's own backend credentials are in none of it.
 */

function fixture(name: string): Readonly<Record<string, unknown>> {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const FLOW_REFERENCE: EngineReference = {
  type: "conversation-flow",
  engineId: "conversation_flow_2346a0e8367c",
  version: 105,
};

const LLM_REFERENCE: EngineReference = {
  type: "retell-llm",
  engineId: "llm_7f3c2b19aa04",
  version: 12,
};

const flow: EngineConfiguration = {
  reference: FLOW_REFERENCE,
  document: fixture("conversation-flow"),
};

const llm: EngineConfiguration = {
  reference: LLM_REFERENCE,
  document: fixture("retell-llm"),
};

const TARGET = {
  base: "https://mock.egma.example/retell-tools",
  runId: "run_01JABCDEF",
} as const;

/**
 * Every sentinel secret the fixtures carry, found rather than listed.
 *
 * Found, so that a fixture that gains another credential is covered by this
 * proof the moment it is written, instead of the day somebody remembers to add
 * it to a list here.
 */
function sentinelsIn(document: unknown): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes("FIXTURESECRET")) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(document);
  return [...found];
}

describe("the mocked draft's transform", () => {
  it("changes a conversation flow's URLs and headers, and nothing else", () => {
    const { tools } = mockedToolsFor(flow, TARGET);
    const written = tools["tools"] as readonly Record<string, unknown>[];
    const original = flow.document["tools"] as readonly Record<
      string,
      unknown
    >[];

    expect(written).toHaveLength(original.length);
    for (const [index, before] of original.entries()) {
      const after = written[index] as Record<string, unknown>;
      if (before["type"] !== "custom") {
        // Not intercepted: the same object, not a copy of it.
        expect(after).toBe(before);
        continue;
      }
      expect(after["url"]).toBe(
        mockToolUrl(TARGET, before["name"] as string),
      );
      expect(after["headers"]).toEqual({});
      // Everything that is not one of the two is byte-identical.
      const strip = (one: Record<string, unknown>) => {
        const { url, headers, ...rest } = one;
        void url;
        void headers;
        return rest;
      };
      expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
    }
  });

  it("keeps the contract the model reads byte-identical", () => {
    const { tools } = mockedToolsFor(flow, TARGET);
    const written = tools["tools"] as readonly Record<string, unknown>[];
    const original = flow.document["tools"] as readonly Record<
      string,
      unknown
    >[];

    for (const [index, before] of original.entries()) {
      const after = written[index] as Record<string, unknown>;
      for (const field of [
        "name",
        "description",
        "parameters",
        "tool_id",
        "method",
        "query_params",
        "response_variables",
        "timeout_ms",
        "args_at_root",
        "max_retry",
      ]) {
        expect(JSON.stringify(after[field])).toBe(
          JSON.stringify(before[field]),
        );
      }
    }
  });

  it("leaves the flow's node references and every other key alone", () => {
    const { tools } = mockedToolsFor(flow, TARGET);
    // The write body holds the tool array and nothing else: nodes, prompts and
    // the MCP list are never resent, so they cannot be resent wrong.
    expect(Object.keys(tools)).toEqual(["tools"]);
  });

  it("carries the run, the simulation variable and the encoded tool name", () => {
    const url = mockToolUrl(TARGET, "price list/lookup?v=2");
    expect(url).toBe(
      "https://mock.egma.example/retell-tools/run_01JABCDEF/" +
        `{{${SIMULATION_VARIABLE}}}/price%20list%2Flookup%3Fv%3D2`,
    );
    // The braces are a placeholder Retell fills, so they are never encoded.
    expect(url).toContain("{{egma_simulation}}");
  });

  it("walks both of a Retell LLM's tool arrays", () => {
    const { tools, coverage } = mockedToolsFor(llm, TARGET);

    const general = tools["general_tools"] as readonly Record<
      string,
      unknown
    >[];
    expect(general[0]?.["url"]).toBe(mockToolUrl(TARGET, "lookup_patient"));
    // The built-in beside it is untouched and carries no URL at all.
    expect(general[1]).toEqual({
      type: "end_call",
      name: "end_call",
      description: "Ends the conversation.",
    });

    const states = tools["states"] as readonly Record<string, unknown>[];
    const triage = (states[0]?.["tools"] as Record<string, unknown>[])[0];
    const booking = (states[1]?.["tools"] as Record<string, unknown>[])[0];
    expect(triage?.["url"]).toBe(mockToolUrl(TARGET, "triage_symptoms"));
    expect(booking?.["url"]).toBe(mockToolUrl(TARGET, "book_slot"));

    // A state with no tools survives the walk unchanged.
    expect(states[2]).toEqual(
      (llm.document["states"] as readonly unknown[])[2],
    );

    expect(coverage.mocked).toEqual([
      "lookup_patient",
      "triage_symptoms",
      "book_slot",
    ]);
  });

  it("reports every tool it did not intercept, by class", () => {
    const coverage = toolCoverageOf(toolsOf(flow));

    expect(coverage.mocked).toEqual([
      "get_availability",
      "book_appointment",
      "price list/lookup?v=2",
    ]);
    expect(coverage.notInterceptable).toEqual([
      "normalise_phone",
      "transfer_to_front_desk",
      "text_directions",
      "end_call",
    ]);
    expect(coverage.notInThisVersion).toEqual(["inventory"]);
  });

  it("stamps a Retell LLM's built-ins and MCP server in their own classes", () => {
    const coverage = toolCoverageOf(toolsOf(llm));
    expect(coverage.notInterceptable).toEqual([
      "end_call",
      "transfer_to_practice_manager",
    ]);
    expect(coverage.notInThisVersion).toEqual(["formulary"]);
  });

  it("says 'not in this version' about a tool type it has never seen", () => {
    const invented: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        tools: [{ type: "quantum_teleport", name: "beam_caller" }],
      },
    };
    expect(toolCoverageOf(toolsOf(invented))).toEqual({
      mocked: [],
      notInterceptable: [],
      notInThisVersion: ["beam_caller"],
    });
  });

  it("puts none of the fixtures' secret headers in what it produces", () => {
    for (const engine of [flow, llm]) {
      const sentinels = sentinelsIn(engine.document);
      expect(sentinels.length).toBeGreaterThan(0);

      const produced = JSON.stringify(mockedToolsFor(engine, TARGET));
      for (const sentinel of sentinels) {
        expect(produced).not.toContain(sentinel);
      }
      // And the sentinel's own distinguishing word, in case a header value is
      // ever split or re-encoded on the way out.
      expect(produced).not.toContain("FIXTURESECRET");
    }
  });

  it("empties the header map rather than dropping the key", () => {
    const { tools } = mockedToolsFor(flow, TARGET);
    const first = (tools["tools"] as Record<string, unknown>[])[0];
    expect(Object.hasOwn(first as object, "headers")).toBe(true);
    expect(first?.["headers"]).toEqual({});
  });

  it("writes nothing for an engine that declares no tools", () => {
    const bare: EngineConfiguration = {
      reference: LLM_REFERENCE,
      document: { general_prompt: "hello" },
    };
    expect(mockedToolsFor(bare, TARGET)).toEqual({
      tools: {},
      coverage: { mocked: [], notInterceptable: [], notInThisVersion: [] },
    });
  });
});
