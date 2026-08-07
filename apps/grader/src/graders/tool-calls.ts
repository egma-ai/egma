import type { ToolExpectation } from "@egma/db";

import { textOf } from "../judge/index.ts";
import { theOneCheck, type ExecutionOf, type Judgment } from "./contract.ts";
import { heldRationale } from "./rule-shelf.ts";

/**
 * The tools that had to fire and the tools that must never have — judged from
 * what the simulation actually observed, and no model is asked anything.
 *
 * "Never calls `transfer_to_human`" is a one-minute setup and an instant,
 * free, identical answer every time. That is the whole reason a deterministic
 * type exists beside the judged ones: nobody needs a model's opinion about
 * whether a tool fired.
 *
 * ## Observed calls only
 *
 * The evidence is the `tool_call` events the simulator wrote, which are what it
 * saw from egma's side of the connection. Not the transcript, not a judge's
 * reading of it, and never the agent's own account of what it did — an agent
 * that *says* it looked up the booking and did not is exactly the failure this
 * check exists to catch, and a check that read the sentence would agree with it.
 *
 * A platform that reports the invocation but not its arguments records `null`,
 * and that is a fact rather than a gap: a required tool with argument
 * constraints cannot be shown to have been called correctly by a call whose
 * arguments were never observed, and a forbidden tool with argument constraints
 * cannot be shown to have been called wrongly by one either. Both are said out
 * loud in the rationale rather than guessed at.
 *
 * ## One grader, one dimension
 *
 * A `tool_calls` grader names one dimension — its own type — however many rules
 * it holds, and the rationale names every rule that was broken. Here the rule
 * that could not be a dimension is a tool's name, which an edit changes, or its
 * position in the shelf, which a reorder changes; `rule-shelf.ts` carries why
 * that rules out a per-rule dimension for either shelf, and why one shelf is one
 * policy rather than a proportion of one.
 */
export function executeToolCalls(
  execution: ExecutionOf<"tool_calls">,
): readonly Judgment[] {
  const { config } = execution.judgment;
  const observed = observedCalls(execution.conversation.events);

  const broken: string[] = [];

  for (const expectation of config.required) {
    const matching = observed.filter((call) => call.tool === expectation.tool);
    if (matching.length === 0) {
      broken.push(`${named(expectation)} was never called`);
      continue;
    }
    const expected = expectation.arguments;
    if (expected === null) continue;
    if (matching.some((call) => satisfies(call, expected))) continue;
    // A platform that reported the invocation and not its arguments leaves a
    // constraint unshown rather than unmet, and the rationale says which —
    // "call it differently" and "egma could not see how you called it" are two
    // different things to go and do.
    broken.push(
      matching.some((call) => call.arguments !== undefined)
        ? `${expectation.tool} was called, but never with ${constraints(expected)}`
        : `${expectation.tool} was called, but the platform reported no arguments, so ${constraints(expected)} could not be shown`,
    );
  }

  for (const expectation of config.forbidden) {
    const matching = observed.filter((call) => call.tool === expectation.tool);
    if (matching.length === 0) continue;
    const expected = expectation.arguments;
    if (expected === null) {
      broken.push(`${expectation.tool} was called ${howOften(matching.length)}`);
      continue;
    }
    // Constrained, so the tool firing is not the violation — firing *this way*
    // is. A call whose arguments were never observed cannot show that it did,
    // and a check egma cannot make is never a check the agent failed.
    if (matching.some((call) => satisfies(call, expected))) {
      broken.push(`${expectation.tool} was called with ${constraints(expected)}`);
    }
  }

  const passed = broken.length === 0;

  return [
    {
      dimension: theOneCheck("tool_calls"),
      verdict: passed ? "passed" : "failed",
      score: passed ? 1 : 0,
      rationale: passed
        ? heldRationale(whatHeld(config), "tools")
        : broken.join("; ") + ".",
      // Empty, and honestly so. A tool call is not a turn: the simulator
      // records it as its own event, with no position in the transcript, so
      // there is no turn to point a reader at. When a simulation's tool calls
      // arrive as spans of their own, this is the one line that changes.
      citedSpanIds: [],
    },
  ];
}

/** One tool call, as the simulator observed it. */
type ObservedCall = {
  readonly tool: string;
  /**
   * The arguments as they were parsed back out of what the platform reported,
   * or `undefined` where it reported the invocation and not its arguments.
   */
  readonly arguments: Record<string, unknown> | undefined;
};

/**
 * The tools the agent called, read off the event stream defensively.
 *
 * The events column is jsonb with no fixed shape at the write door, so anything
 * that is not a tool call event with a name on it is not a tool call. Read the
 * same way `judgeInputOf` reads it, deliberately: a judge and this grader
 * looking at two different lists of tool calls would be two answers to one
 * question. The reading of a field is literally the judge input's `textOf`
 * rather than a copy of it, so "the same way" is a fact about the code and not
 * an intention stated in a comment.
 */
function observedCalls(events: unknown): readonly ObservedCall[] {
  if (!Array.isArray(events)) return [];

  const called: ObservedCall[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      continue;
    }
    const fields = event as Record<string, unknown>;
    if (fields["kind"] !== "tool_call") continue;
    const tool = textOf(fields["name"]) ?? textOf(fields["tool"]);
    if (tool === undefined) continue;
    called.push({ tool, arguments: argumentsOf(fields["arguments"]) });
  }
  return called;
}

/**
 * The arguments as an object, however the platform reported them.
 *
 * The contract carries them JSON-encoded, as a string, because the bytes the
 * platform sent are the fact worth keeping. Some plugs hand over the decoded
 * object instead. Both are read; anything that decodes to something other than
 * an object — a bare string, a list, invalid JSON — is arguments nobody can
 * constrain, and is the same case as arguments that were never reported.
 */
function argumentsOf(written: unknown): Record<string, unknown> | undefined {
  if (typeof written === "string") {
    try {
      return argumentsOf(JSON.parse(written) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof written !== "object" || written === null || Array.isArray(written)) {
    return undefined;
  }
  return written as Record<string, unknown>;
}

/**
 * Whether one observed call carries what the expectation asks of it.
 *
 * **A constraint on the call, never a description of it.** Every named argument
 * must be there with that value; anything else the agent sent alongside is
 * ignored. A grader asking "the refund tool fired for order 4471" must not
 * become a grader that fails because the agent also sent a `reason` — nobody
 * writing the first meant the second, and an exact-match rule would make every
 * argument constraint break the first time a platform adds a field.
 *
 * Values compare as JSON values rather than as text: an argument recorded as an
 * object matches a constraint written as the same object whatever order the two
 * happened to serialize their keys in.
 */
function satisfies(
  call: ObservedCall,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  const sent = call.arguments;
  // Arguments that were never observed cannot show a constraint was met. Not a
  // match rather than a match, because the whole point of the constraint is that
  // somebody wanted it checked.
  if (sent === undefined) return false;

  return Object.entries(expected).every(([argument, value]) =>
    sameJson(sent[argument], value),
  );
}

/** Two JSON values, compared as values rather than as text. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, at) => sameJson(entry, b[at]))
    );
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.keys(a).sort();
    const right = Object.keys(b).sort();
    return (
      left.length === right.length &&
      left.every((key, at) => key === right[at]) &&
      left.every((key) =>
        sameJson(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return false;
}

/** A required tool as the rationale names it, constraints included. */
function named(expectation: ToolExpectation): string {
  return expectation.arguments === null
    ? expectation.tool
    : `${expectation.tool} with ${constraints(expectation.arguments)}`;
}

/** The argument constraints as somebody reads them in a sentence. */
function constraints(expected: Readonly<Record<string, unknown>>): string {
  const written = Object.entries(expected).map(
    ([argument, value]) => `${argument}=${JSON.stringify(value)}`,
  );
  return written.length === 0 ? "no particular arguments" : written.join(", ");
}

function howOften(times: number): string {
  return times === 1 ? "once" : `${times} times`;
}

/** What this shelf holds, as the clauses a rationale is written out of. */
function whatHeld(config: {
  readonly required: readonly ToolExpectation[];
  readonly forbidden: readonly ToolExpectation[];
}): readonly string[] {
  const said: string[] = [];
  if (config.required.length > 0) {
    said.push(`${config.required.map(named).join(", ")} fired`);
  }
  if (config.forbidden.length > 0) {
    said.push(`${config.forbidden.map(named).join(", ")} never fired`);
  }
  return said;
}
