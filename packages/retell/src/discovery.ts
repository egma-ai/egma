/**
 * What ticking the box finds, and the answer it seeds for each thing it found.
 *
 * A read of a configuration and two pure functions over it. Nothing here
 * writes, and nothing here needs a run: a surface that only wants to *show* a
 * developer what a mocked run would cover asks exactly these questions, and
 * gets exactly these answers.
 *
 * ## The seeded answer
 *
 * **Deterministic, and derived from the tool's own declaration.** A Retell
 * custom tool may declare `response_variables` — a map of variable name to the
 * JSONPath the value is read out of the response at — and that is the closest
 * thing Retell holds to a declared response shape. So the seed is an object
 * with those paths present and empty, which is an answer the agent's own
 * variable extraction can read. A tool that declares none gets a minimal
 * success-shaped object.
 *
 * No call-time improvisation, ever: the answer is visible and editable the
 * moment it is seeded, and it is the same answer on every run until somebody
 * changes it.
 *
 * ## The warnings
 *
 * A transfer and an SMS execute inside Retell and **act outside the call** — a
 * real transfer leg, a real message. They are not intercepted, they are not
 * rewritten (rewriting a destination would change the tool contract the
 * transform promises to keep byte-identical), and they are not silently left
 * out. They are warned about here, where the tick is, and named on every
 * simulation's coverage stamp.
 */

import { plain } from "./transport.ts";
import {
  coverageClassOf,
  toolCoverageOf,
  toolsOf,
  type EngineTool,
  type ToolCoverage,
  type ToolCoverageClass,
} from "./tools.ts";
import type { EngineConfiguration } from "./versions.ts";

/** One tool as the tick's screen and the seeder both read it. */
export type DiscoveredTool = {
  /** What the model calls it, and what a mock tool's row is named after. */
  readonly name: string;
  /** Retell's own word for the kind of tool, verbatim. */
  readonly type: string;
  readonly coverage: ToolCoverageClass;
  /**
   * The answer Egma would seed for it, or null where Egma seeds none — every
   * tool it does not stand in front of.
   */
  readonly seededAnswer: Readonly<Record<string, unknown>> | null;
};

/**
 * The two tool types that act outside the call.
 *
 * Named here rather than in the coverage classes because this is a different
 * question. `notInterceptable` says Egma cannot stand in front of it; this says
 * it will really happen — a leg really placed, a message really sent — and a
 * developer about to tick a box promising isolation has to be told.
 */
const ACTS_OUTSIDE_THE_CALL: ReadonlyMap<string, string> = new Map([
  ["transfer_call", "transfers the call to a real destination"],
  ["transfer", "transfers the call to a real destination"],
  ["send_sms", "sends a real text message"],
  ["sms", "sends a real text message"],
]);

/** One thing a mocked run will really do, said before the box is ticked. */
export type DiscoveryWarning = {
  readonly toolName: string;
  readonly toolType: string;
  /** What it does, in the words the screen shows. */
  readonly effect: string;
};

/** Everything the tick learned from one engine configuration. */
export type ToolDiscovery = {
  /** Every tool the engine declares, in the order it declares them. */
  readonly tools: readonly DiscoveredTool[];
  /** The three classes, which is what the coverage stamp is written from. */
  readonly coverage: ToolCoverage;
  /** The tools that act outside the call and will really act. */
  readonly warnings: readonly DiscoveryWarning[];
};

/** A minimal answer that reads as the call having worked. */
export const MINIMAL_SUCCESS: Readonly<Record<string, unknown>> = {
  success: true,
};

/**
 * The path a response variable is read at, split into its plain segments.
 *
 * Only `$.a`, `$.a.b` and the bracketless spellings of them are understood.
 * Anything else — a filter, an index, a wildcard — names a shape this function
 * cannot build, and it answers null rather than guessing at one: a seed built
 * out of a misread path would be an answer the agent's extraction silently
 * finds nothing in.
 */
function segmentsOf(path: unknown): readonly string[] | null {
  const written = plain(path);
  if (written === "") return null;
  const body = written.startsWith("$.")
    ? written.slice(2)
    : written.startsWith("$")
      ? written.slice(1)
      : written;
  if (body === "") return null;
  const segments = body.split(".");
  const plainName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
  return segments.every((segment) => plainName.test(segment)) ? segments : null;
}

/**
 * The answer Egma seeds for one interceptable tool.
 *
 * Derived, never invented: every key in it is a key the tool's own declaration
 * asked for. Where the declaration asks for nothing, the answer says the one
 * thing that is true of every successful call and claims nothing else.
 */
export function seededAnswerFor(
  tool: EngineTool,
): Readonly<Record<string, unknown>> {
  const declared = tool.verbatim["response_variables"];
  const shape: Record<string, unknown> = {};
  if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
    for (const path of Object.values(declared as Record<string, unknown>)) {
      const segments = segmentsOf(path);
      if (segments === null) continue;
      let at = shape;
      for (const [index, segment] of segments.entries()) {
        if (index === segments.length - 1) {
          // Empty rather than invented: the declaration says where the value is
          // read, never what type it is, and a made-up list or number would be
          // a claim about the customer's backend that Egma cannot make.
          at[segment] = "";
          break;
        }
        const held = at[segment];
        const next =
          typeof held === "object" && held !== null && !Array.isArray(held)
            ? (held as Record<string, unknown>)
            : {};
        at[segment] = next;
        at = next;
      }
    }
  }
  return Object.keys(shape).length === 0 ? { ...MINIMAL_SUCCESS } : shape;
}

/** Everything the tick learned, out of one engine configuration. */
export function discoverTools(engine: EngineConfiguration): ToolDiscovery {
  const found = toolsOf(engine);
  const warnings: DiscoveryWarning[] = [];
  const tools = found.map((tool): DiscoveredTool => {
    const coverage = coverageClassOf(tool);
    const effect = ACTS_OUTSIDE_THE_CALL.get(tool.type);
    if (effect !== undefined) {
      warnings.push({ toolName: tool.name, toolType: tool.type, effect });
    }
    return {
      name: tool.name,
      type: tool.type,
      coverage,
      seededAnswer: coverage === "mocked" ? seededAnswerFor(tool) : null,
    };
  });
  return { tools, coverage: toolCoverageOf(found), warnings };
}
