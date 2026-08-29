import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  mockedToolsFor,
  mockToolUrl,
  SIMULATION_VARIABLE,
  toolCoverageOf,
  toolsOf,
  writeEngineTools,
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
  it("changes a conversation flow's URLs, headers and query params, and nothing else", () => {
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
      // Emptied beside the headers, and for the same reason: a static query
      // param is a backend constant, and secrets travel in them.
      expect(after["query_params"]).toEqual({});
      // Everything that is not one of the three is byte-identical.
      const strip = (one: Record<string, unknown>) => {
        const { url, headers, query_params, ...rest } = one;
        void url;
        void headers;
        void query_params;
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

  /**
   * The flow lane's whole-object comparison, applied to the lane that needs it
   * more.
   *
   * A Retell LLM's states go back whole — Retell has no per-state patch — so
   * this walks every tool in both arrays and asserts that nothing but `url` and
   * `headers` moved on an intercepted one, that a built-in is the same object it
   * arrived as, and that every state's own non-tool fields survive the trip.
   */
  it("changes nothing but URLs, headers and query params in a Retell LLM", () => {
    const { tools } = mockedToolsFor(llm, TARGET);
    const strip = (one: Record<string, unknown>) => {
      const { url, headers, query_params, ...rest } = one;
      void url;
      void headers;
      void query_params;
      return rest;
    };

    const sameToolArray = (
      written: readonly unknown[],
      original: readonly unknown[],
      where: string,
    ): void => {
      expect(written, where).toHaveLength(original.length);
      for (const [index, before] of original.entries()) {
        const was = before as Record<string, unknown>;
        const after = written[index] as Record<string, unknown>;
        if (was["type"] !== "custom") {
          // Not intercepted: the same object, not a copy of it.
          expect(after, `${where}[${index}]`).toBe(before);
          continue;
        }
        expect(after["url"], `${where}[${index}] url`).toBe(
          mockToolUrl(TARGET, was["name"] as string),
        );
        expect(after["headers"], `${where}[${index}] headers`).toEqual({});
        expect(
          after["query_params"],
          `${where}[${index}] query params`,
        ).toEqual({});
        expect(JSON.stringify(strip(after)), `${where}[${index}]`).toBe(
          JSON.stringify(strip(was)),
        );
      }
    };

    sameToolArray(
      tools["general_tools"] as readonly unknown[],
      llm.document["general_tools"] as readonly unknown[],
      "general_tools",
    );

    const writtenStates = tools["states"] as readonly Record<
      string,
      unknown
    >[];
    const originalStates = llm.document["states"] as readonly Record<
      string,
      unknown
    >[];
    expect(writtenStates).toHaveLength(originalStates.length);
    for (const [index, before] of originalStates.entries()) {
      const after = writtenStates[index] as Record<string, unknown>;
      sameToolArray(
        (after["tools"] ?? []) as readonly unknown[],
        (before["tools"] ?? []) as readonly unknown[],
        `states[${index}].tools`,
      );
      // Everything a state is besides its tools — its name, its prompt, its
      // edges — goes back exactly as it was read. This is the lane where that
      // has to be proved rather than assumed, because this is the lane where
      // those fields are resent at all.
      const withoutTools = (one: Record<string, unknown>) => {
        const { tools: held, ...rest } = one;
        void held;
        return rest;
      };
      expect(
        JSON.stringify(withoutTools(after)),
        `states[${index}] non-tool fields`,
      ).toBe(JSON.stringify(withoutTools(before)));
    }
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
    expect(Object.hasOwn(first as object, "query_params")).toBe(true);
    expect(first?.["query_params"]).toEqual({});
  });

  it("sends none of them to Retell either, on the wire or in a refusal", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      sent.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    }) as typeof fetch;

    const { tools } = mockedToolsFor(flow, TARGET);
    const written = await writeEngineTools(
      { reveal: () => "retell-key-abc123" },
      { reference: FLOW_REFERENCE, version: 106, tools },
      { url: "https://retell.invalid", fetchImpl },
    );

    // What went out carries no credential of the customer's…
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("FIXTURESECRET");
    // …and the refusal that came back carries neither theirs nor egma's.
    expect(JSON.stringify(written)).not.toContain("FIXTURESECRET");
    expect(JSON.stringify(written)).not.toContain("retell-key-abc123");
  });

  it("keeps a thrown transport failure clear of them too", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;

    const { tools } = mockedToolsFor(llm, TARGET);
    const written = await writeEngineTools(
      { reveal: () => "retell-key-abc123" },
      { reference: LLM_REFERENCE, version: 13, tools },
      { url: "https://retell.invalid", fetchImpl },
    );

    expect(written.kind).toBe("unreachable");
    const said = JSON.stringify(written);
    expect(said).not.toContain("FIXTURESECRET");
    expect(said).not.toContain("retell-key-abc123");
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
