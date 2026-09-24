import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The agent's POV of a Pipecat conversation, as the egma SDK writes it, held
 * to the `egma.pipecat` section of span-vocabulary.md. The API's ingest can
 * post these same files through the customer-key door.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(packageRoot, "fixtures", "spans", "agent-pov");
const vocabulary = await readFile(path.join(packageRoot, "span-vocabulary.md"), "utf8");

const SCOPE = "egma.pipecat";

/** Each span name, the kind it lands as, and the attributes it may carry. */
const SPANS: Readonly<Record<string, readonly string[]>> = {
  pipecat_session: ["egma.pipecat.version", "egma.pipecat.transport"],
  user_turn: ["egma.turn.text"],
  agent_turn: ["egma.turn.text", "egma.turn.interrupted"],
  function_call: [
    "egma.tool.name",
    "egma.tool.call_id",
    "egma.tool.arguments",
    "egma.tool.result",
    "egma.tool.error",
  ],
  user_speaking: [],
  agent_speaking: [],
  llm_generation: [],
  tts_synthesis: [],
};

/** Which span a child's parent must be, by the child's own name. */
const PARENTS: Readonly<Record<string, readonly string[]>> = {
  user_turn: ["pipecat_session"],
  agent_turn: ["pipecat_session"],
  function_call: ["agent_turn", "pipecat_session"],
  user_speaking: ["user_turn"],
  agent_speaking: ["agent_turn"],
  llm_generation: ["agent_turn"],
  tts_synthesis: ["agent_turn"],
};

type Attribute = {
  readonly key: string;
  readonly value?: { readonly stringValue?: string; readonly boolValue?: boolean };
};
type Span = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly name: string;
  readonly attributes?: readonly Attribute[];
  readonly status?: { readonly code?: string };
};
type Flush = {
  readonly name: string;
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly Attribute[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string; readonly version?: string };
      readonly spans: readonly Span[];
    }[];
  }[];
};

const flushes: Flush[] = await Promise.all(
  (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map(async (name) => ({
      name,
      ...(JSON.parse(await readFile(path.join(directory, name), "utf8")) as Omit<Flush, "name">),
    })),
);
const simulation = flushes.filter((flush) => flush.name.startsWith("pipecat-simulation-"));
const production = flushes.filter((flush) => flush.name.startsWith("pipecat-production-"));

function spansOf(flush: Flush): Span[] {
  return flush.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => [...scope.spans]),
  );
}

function resourceAttribute(flush: Flush, key: string): string | undefined {
  return flush.resourceSpans[0]?.resource.attributes.find((entry) => entry.key === key)
    ?.value?.stringValue;
}

describe("the egma.pipecat agent POV fixtures", () => {
  it("cover a simulation in two flushes and one production flush", () => {
    expect(simulation.map((flush) => flush.name)).toEqual([
      "pipecat-simulation-flush-1-turns-and-tools.json",
      "pipecat-simulation-flush-2-root.json",
    ]);
    expect(production).toHaveLength(1);
  });

  it("ride the egma.pipecat scope and use only its span names and attributes", () => {
    for (const flush of flushes) {
      for (const resource of flush.resourceSpans) {
        for (const scope of resource.scopeSpans) {
          expect(scope.scope.name, flush.name).toBe(SCOPE);
          for (const span of scope.spans) {
            const allowed = SPANS[span.name];
            expect(allowed, `${flush.name}: ${span.name}`).toBeDefined();
            for (const attribute of span.attributes ?? []) {
              expect(allowed, `${span.name} carries ${attribute.key}`).toContain(attribute.key);
            }
          }
        }
      }
    }
  });

  it("nest every span under the span the vocabulary names as its parent", () => {
    for (const group of [simulation, production]) {
      const spans = group.flatMap(spansOf);
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      for (const span of spans) {
        if (span.name === "pipecat_session") {
          expect(span.parentSpanId).toBe("");
          continue;
        }
        const parent = byId.get(span.parentSpanId);
        expect(parent, `${span.name} ${span.spanId} has no parent in the trace`).toBeDefined();
        expect(PARENTS[span.name], `${span.name} under ${parent?.name}`).toContain(parent?.name);
      }
    }
  });

  it("name the simulation on the resource, send the root last, and keep one trace id", () => {
    for (const flush of simulation) {
      expect(resourceAttribute(flush, "egma.provider_reference")).toBe(
        "sim_01K5TB2H8Y4P7QCWF9XKMD6RZP",
      );
    }
    const spans = simulation.flatMap(spansOf);
    expect(spans.at(-1)?.name).toBe("pipecat_session");
    expect(spans.filter((span) => span.name === "pipecat_session")).toHaveLength(1);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  });

  it("name no simulation on production traffic", () => {
    for (const flush of production) {
      expect(resourceAttribute(flush, "egma.provider_reference")).toBeUndefined();
      expect(spansOf(flush).at(-1)?.name).toBe("pipecat_session");
    }
  });

  it("name the agent on production traffic only", () => {
    for (const flush of production) {
      expect(resourceAttribute(flush, "egma.agent_name")).toBe("Lakeside production bot");
    }
    for (const flush of simulation) {
      expect(resourceAttribute(flush, "egma.agent_name")).toBeUndefined();
    }
  });

  it("carry a failed call's error with an error status, and a result only on success", () => {
    const calls = simulation.flatMap(spansOf).filter((span) => span.name === "function_call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const keys = (call.attributes ?? []).map((attribute) => attribute.key);
      const failed = keys.includes("egma.tool.error");
      expect(keys.includes("egma.tool.result")).toBe(!failed);
      expect(call.status?.code === "STATUS_CODE_ERROR").toBe(failed);
    }
  });

  it("are all named in span-vocabulary.md", () => {
    expect(vocabulary).toContain("`egma.pipecat`");
    for (const [name, attributes] of Object.entries(SPANS)) {
      expect(vocabulary, name).toContain(`\`${name}\``);
      for (const attribute of attributes) {
        expect(vocabulary, attribute).toContain(`\`${attribute}\``);
      }
    }
    expect(vocabulary).toContain("`egma.provider_reference`");
  });
});
