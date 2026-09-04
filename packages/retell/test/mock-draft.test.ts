import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EGMA_URL_VARIABLE_DEFAULT,
  isIntercepted,
  mockedToolsFor,
  mockToolUrl,
  mockToolVariable,
  toolsOf,
  trimmedEgmaDefaults,
  writeEngineTools,
  type EngineConfiguration,
  type EngineReference,
  type MockedTools,
} from "../src/index.ts";

/**
 * The transform, checked against captured configurations of both engines.
 *
 * Every promise the draft makes is a promise about these bytes: the contract
 * the model reads is unchanged, the customer's own URL survives byte for byte
 * behind the one prefix that is added, their headers and query params are not
 * touched at all, every tool egma cannot stand in front of is named on the
 * record, and every routing variable is declared with a single-space default.
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

/** Where one mocked call is routed, once a simulation is being conducted. */
const TARGET = {
  base: "https://mock.egma.example/mock-tools",
  simulationId: "sim_01JABCDEF",
} as const;

/** The draft, or a loud failure naming the refusal that came back instead. */
function mocked(engine: EngineConfiguration): MockedTools {
  const draft = mockedToolsFor(engine);
  if (draft.kind !== "mocked") {
    throw new Error(`the transform refused: ${draft.reason}`);
  }
  return draft;
}

describe("the mocked draft's transform", () => {
  it("prefixes a conversation flow's URLs and touches nothing else", () => {
    const { tools } = mocked(flow);
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
      const variable = mockToolVariable(before["name"] as string);
      // The one field that moves, and it only grows a prefix: the customer's
      // own URL is still there, byte for byte, behind it.
      expect(after["url"]).toBe(`{{${variable}}}${String(before["url"])}`);
      // Headers and query params are the customer's, carried verbatim: the
      // same version serves the tools a test does not mock, and those calls
      // authenticate exactly as production does.
      expect(after["headers"]).toEqual(before["headers"]);
      expect(after["query_params"]).toEqual(before["query_params"]);
      // Everything that is not the URL is byte-identical.
      const strip = (one: Record<string, unknown>) => {
        const { url, ...rest } = one;
        void url;
        return rest;
      };
      expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
    }
  });

  it("keeps the contract the model reads byte-identical", () => {
    const { tools } = mocked(flow);
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
        "headers",
        "query_params",
      ]) {
        expect(JSON.stringify(after[field])).toBe(
          JSON.stringify(before[field]),
        );
      }
    }
  });

  it("leaves the flow's node references and every other key alone", () => {
    const { tools } = mocked(flow);
    // The write body holds the tool array and nothing else: nodes, prompts and
    // the MCP list are never resent, so they cannot be resent wrong. The
    // defaults ride beside it rather than inside it.
    expect(Object.keys(tools)).toEqual(["tools"]);
  });

  it("declares one single-space default per routing variable, beside the customer's own", () => {
    const { defaults, variables } = mocked(flow);

    expect(variables).toEqual([
      { tool: "get_availability", variable: "egma_url_get_availability" },
      { tool: "book_appointment", variable: "egma_url_book_appointment" },
      {
        tool: "price list/lookup?v=2",
        variable: mockToolVariable("price list/lookup?v=2"),
      },
    ]);

    for (const { variable } of variables) {
      // One space, never the empty string. Retell stores an empty default as
      // absent, and an absent variable leaves the braces literal — which is
      // not a URL, so every call that did not mock the tool would fail.
      expect(defaults[variable]).toBe(" ");
      expect(defaults[variable]).toBe(EGMA_URL_VARIABLE_DEFAULT);
    }
    // And the customer's own default is still there, unchanged: the map is
    // written whole, so writing egma's alone would delete theirs.
    expect(defaults["clinic_name"]).toBe("Remedy");
    expect(Object.keys(defaults)).toHaveLength(4);
  });

  it("names a plain tool after itself and a punctuated one after its digest", () => {
    // Letters, digits and underscores: the name is the variable.
    expect(mockToolVariable("book_appointment")).toBe(
      "egma_url_book_appointment",
    );
    expect(mockToolVariable("Book2")).toBe("egma_url_Book2");

    // Anything else is sanitized, and the exact name's digest is appended — so
    // two names that sanitize alike still get two variables, which is the
    // whole reason the digest is there.
    const dashed = mockToolVariable("price-list");
    const dotted = mockToolVariable("price.list");
    expect(dashed).toMatch(/^egma_url_price_list_[0-9a-f]{8}$/u);
    expect(dotted).toMatch(/^egma_url_price_list_[0-9a-f]{8}$/u);
    expect(dashed).not.toBe(dotted);

    // The digest is the first eight hex digits of the exact name's SHA-256.
    expect(mockToolVariable("price list/lookup?v=2")).toBe(
      "egma_url_price_list_lookup_v_2_505e156d",
    );
  });

  it("refuses two tools that would share one routing variable, before anything is written", () => {
    // The same name twice in one engine. Egma answers a call by the tool's
    // name, so one variable cannot decide for two of them.
    const twice: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        tools: [
          { type: "custom", name: "book", url: "https://one.example/book" },
          { type: "custom", name: "book", url: "https://two.example/book" },
        ],
      },
    };
    const refused = mockedToolsFor(twice);
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.reason).toContain("egma_url_book");
    expect(refused.reason).toContain("two custom tools");
  });

  it("refuses a tool whose variable the customer already fills", () => {
    const taken: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        default_dynamic_variables: { egma_url_book: "https://mine.example" },
        tools: [
          { type: "custom", name: "book", url: "https://one.example/book" },
        ],
      },
    };
    const refused = mockedToolsFor(taken);
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.reason).toContain("egma_url_book");
    expect(refused.reason).toContain("will not overwrite a variable of yours");
  });

  it("builds the address one mocked call is routed to, with the fragment that hides the rest", () => {
    const url = mockToolUrl(TARGET, "price list/lookup?v=2");
    expect(url).toBe(
      "https://mock.egma.example/mock-tools/sim_01JABCDEF/" +
        "price%20list%2Flookup%3Fv%3D2#",
    );
    // The trailing `#` is the whole of how the customer's own URL is hidden:
    // it trails behind as a fragment, and an HTTP client never sends one.
    expect(url.endsWith("#")).toBe(true);
  });

  it("walks both of a Retell LLM's tool arrays", () => {
    const { tools, defaults } = mocked(llm);

    const general = tools["general_tools"] as readonly Record<
      string,
      unknown
    >[];
    expect(general[0]?.["url"]).toBe(
      "{{egma_url_lookup_patient}}https://api.example.com/patients/lookup",
    );
    // The built-in beside it is untouched and carries no URL at all.
    expect(general[1]).toEqual({
      type: "end_call",
      name: "end_call",
      description: "Ends the conversation.",
    });

    const states = tools["states"] as readonly Record<string, unknown>[];
    const triage = (states[0]?.["tools"] as Record<string, unknown>[])[0];
    const booking = (states[1]?.["tools"] as Record<string, unknown>[])[0];
    expect(triage?.["url"]).toBe(
      "{{egma_url_triage_symptoms}}https://api.example.com/triage",
    );
    expect(booking?.["url"]).toBe(
      "{{egma_url_book_slot}}https://api.example.com/appointments",
    );

    // A state with no tools survives the walk unchanged.
    expect(states[2]).toEqual(
      (llm.document["states"] as readonly unknown[])[2],
    );

    // Every custom tool of both arrays is declared, and the practice's own
    // default is still beside them.
    expect(defaults).toEqual({
      practice_name: "Northgate Dental",
      egma_url_lookup_patient: " ",
      egma_url_triage_symptoms: " ",
      egma_url_book_slot: " ",
    });
  });

  /**
   * The flow lane's whole-object comparison, applied to the lane that needs it
   * more.
   *
   * A Retell LLM's states go back whole — Retell has no per-state patch — so
   * this walks every tool in both arrays and asserts that nothing but `url`
   * moved on an intercepted one, that a built-in is the same object it arrived
   * as, and that every state's own non-tool fields survive the trip.
   */
  it("changes nothing but the URL prefix in a Retell LLM", () => {
    const { tools } = mocked(llm);
    const strip = (one: Record<string, unknown>) => {
      const { url, ...rest } = one;
      void url;
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
          `{{${mockToolVariable(was["name"] as string)}}}${String(was["url"])}`,
        );
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

  it("leaves an MCP server exactly as it found it, on both engines", () => {
    // MCP entries are never rewritten and are never resent: they live in an
    // array the write body does not carry at all.
    for (const engine of [flow, llm]) {
      const { tools, variables } = mocked(engine);
      expect(Object.keys(tools)).not.toContain("mcps");
      expect(variables.map((one) => one.tool)).not.toContain("inventory");
      expect(variables.map((one) => one.tool)).not.toContain("formulary");
      expect(JSON.stringify(tools)).not.toContain("mcp.example.com");
    }
  });

  it("routes a custom tool and nothing else, on either engine", () => {
    // The whole of the classification, and the whole of what is left of it: a
    // custom tool is a webhook Egma can put a variable in front of. Everything
    // else — the tools Retell runs inside its own infrastructure, and an MCP
    // server it reaches over its own protocol — runs for real, untouched.
    for (const engine of [flow, llm]) {
      const { variables } = mocked(engine);
      const custom = toolsOf(engine).filter((tool) => tool.type === "custom");
      expect(variables.map((one) => one.tool)).toEqual(
        custom.map((tool) => tool.name),
      );
      for (const tool of toolsOf(engine)) {
        expect(isIntercepted(tool), `${tool.name} (${tool.type})`).toBe(
          tool.type === "custom",
        );
      }
    }
  });

  it("routes nothing at all for a tool type it has never seen", () => {
    const invented: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        tools: [{ type: "quantum_teleport", name: "beam_caller" }],
      },
    };
    const draft = mocked(invented);
    expect(draft.variables).toEqual([]);
    // The tool array still goes back whole, and the entry is the object that
    // arrived rather than a copy of it.
    expect(draft.tools["tools"]).toEqual(invented.document["tools"]);
  });

  /**
   * The knowing trade of ADR-0022, asserted so nobody "fixes" it back.
   *
   * The transform used to empty every intercepted tool's headers and query
   * params. It may not any more: one temporary version now serves every test
   * of a run, and a test that does not mock a tool reaches the customer's real
   * backend from that same version — which it cannot do with its credentials
   * emptied. What keeps those credentials out of egma is the endpoint, which
   * drops every header and query param that arrives and reads only the
   * platform's signature.
   */
  it("carries the customer's own headers and query params through, unchanged", () => {
    const { tools } = mocked(flow);
    const first = (tools["tools"] as Record<string, unknown>[])[0];
    expect(first?.["headers"]).toEqual({
      Authorization: "Bearer sk_live_FIXTURESECRET_availability_9f2b1c",
      "X-Tenant-Key": "tenant_FIXTURESECRET_remedy_4a71de",
    });
    expect(first?.["query_params"]).toEqual({ locale: "en-US" });
  });

  it("sends Egma's own key nowhere, on the wire or in a refusal", async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      sent.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    }) as typeof fetch;

    const { tools, defaults } = mocked(flow);
    const written = await writeEngineTools(
      { reveal: () => "retell-key-abc123" },
      { reference: FLOW_REFERENCE, version: 106, tools, defaults },
      { url: "https://retell.invalid", fetchImpl },
    );

    // The tools and the defaults travel as one PATCH: a version whose tools
    // name a variable it has no default for is a call with nowhere to go.
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "default_dynamic_variables",
      "tools",
    ]);
    expect(
      (body["default_dynamic_variables"] as Record<string, unknown>)[
        "egma_url_get_availability"
      ],
    ).toBe(" ");
    // What goes back to Retell is what came from Retell. Egma's own key is in
    // none of it, and in none of the refusal either.
    expect(sent[0]).not.toContain("retell-key-abc123");
    expect(JSON.stringify(written)).not.toContain("retell-key-abc123");
  });

  it("keeps a thrown transport failure clear of every key too", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;

    const { tools, defaults } = mocked(llm);
    const written = await writeEngineTools(
      { reveal: () => "retell-key-abc123" },
      { reference: LLM_REFERENCE, version: 13, tools, defaults },
      { url: "https://retell.invalid", fetchImpl },
    );

    expect(written.kind).toBe("unreachable");
    const said = JSON.stringify(written);
    expect(said).not.toContain("FIXTURESECRET");
    expect(said).not.toContain("retell-key-abc123");
  });

  it("writes nothing at all for an engine that declares no tools", () => {
    const bare: EngineConfiguration = {
      reference: LLM_REFERENCE,
      document: { general_prompt: "hello" },
    };
    expect(mockedToolsFor(bare)).toEqual({
      kind: "mocked",
      tools: {},
      // Nothing to route, so the customer's defaults are not rewritten either.
      defaults: {},
      variables: [],
    });
  });

  it("names every routing default the version read back does not hold as one space", () => {
    const { variables } = mocked(flow);
    const asWritten: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        default_dynamic_variables: Object.fromEntries(
          variables.map(({ variable }) => [variable, " "]),
        ),
      },
    };
    expect(trimmedEgmaDefaults(asWritten, variables)).toEqual([]);

    // Trimmed to nothing, which is exactly what Retell does when it treats an
    // empty default as absent — and the reading that makes every unmocked call
    // of the run fail on a URL that is not a URL.
    const trimmed: EngineConfiguration = {
      reference: FLOW_REFERENCE,
      document: {
        default_dynamic_variables: {
          ...(asWritten.document["default_dynamic_variables"] as Record<
            string,
            unknown
          >),
          egma_url_book_appointment: "",
        },
      },
    };
    expect(trimmedEgmaDefaults(trimmed, variables)).toEqual([
      "egma_url_book_appointment",
    ]);

    // And a version that answers with no defaults at all names every one.
    expect(
      trimmedEgmaDefaults(
        { reference: FLOW_REFERENCE, document: {} },
        variables,
      ),
    ).toEqual(variables.map((one) => one.variable));
  });
});
