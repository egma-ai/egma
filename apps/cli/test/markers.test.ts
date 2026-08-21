/**
 * The marker lines, read the way a coding agent really writes them.
 *
 * A model told to write a bare line writes a bullet, or wraps it in backticks,
 * or breaks it across two pieces of a stream. None of that changes what it
 * meant, so none of it may change what egma reads — and nothing that is not a
 * marker may ever become one.
 */

import { describe, expect, it } from "vitest";

import { MarkerStream, markerIn } from "../src/wizard/markers.ts";

describe("a marker line", () => {
  it("carries a fact, its name and its value", () => {
    expect(markerIn("egma:found prompts prompts/order-line.md")).toEqual({
      kind: "found",
      field: "prompts",
      value: "prompts/order-line.md",
    });
    expect(markerIn("egma:found tools src/tools/*.ts (2 definitions)")).toEqual({
      kind: "found",
      field: "tools",
      value: "src/tools/*.ts (2 definitions)",
    });
  });

  it("carries the three other things a step can say", () => {
    expect(markerIn("egma:note Reading package.json")).toEqual({
      kind: "note",
      text: "Reading package.json",
    });
    expect(markerIn("egma:none Nothing here looks like a voice agent.")).toEqual({
      kind: "none",
      reason: "Nothing here looks like a voice agent.",
    });
    expect(markerIn("egma:plan one-thing, another-thing")).toEqual({
      kind: "plan",
      names: ["one-thing", "another-thing"],
    });
    expect(markerIn("egma:writing one-thing")).toEqual({ kind: "writing", name: "one-thing" });
    expect(markerIn("egma:wrote one-thing")).toEqual({ kind: "wrote", name: "one-thing" });
    // An agent that answers with the file rather than the name has said the
    // same thing, and is read as having said it.
    expect(markerIn("egma:wrote egma/tests/generated/one-thing.md")).toEqual({
      kind: "wrote",
      name: "one-thing",
    });
    expect(markerIn("egma:wrote one-thing (3 expected behaviors)")).toEqual({
      kind: "wrote",
      name: "one-thing",
    });
    expect(markerIn("egma:plan")).toBeNull();
    expect(markerIn("egma:wrote")).toBeNull();

    expect(markerIn("egma:abort I cannot read this folder.")).toEqual({
      kind: "abort",
      reason: "I cannot read this folder.",
    });
  });

  it("survives the decoration a model adds when it is being helpful", () => {
    const wanted = { kind: "found", field: "framework", value: "retell-sdk" };
    expect(markerIn("- egma:found framework retell-sdk")).toEqual(wanted);
    expect(markerIn("  * `egma:found framework retell-sdk`  ")).toEqual(wanted);
    expect(markerIn("2. egma:found framework: retell-sdk")).toEqual(wanted);
    expect(markerIn("EGMA:FOUND framework retell-sdk")).toEqual(wanted);
  });

  it("survives bold, which is the decoration a model reaches for most", () => {
    const wanted = { kind: "found", field: "framework", value: "retell-sdk" };
    // Only the marker's own name in bold: the commonest shape of all.
    expect(markerIn("**egma:found** framework retell-sdk")).toEqual(wanted);
    expect(markerIn("__egma:found__ framework retell-sdk")).toEqual(wanted);
    // The whole line in bold.
    expect(markerIn("**egma:found framework retell-sdk**")).toEqual(wanted);
    expect(markerIn("- **egma:found framework retell-sdk**")).toEqual(wanted);
    expect(markerIn("**`egma:found framework retell-sdk`**")).toEqual(wanted);
    expect(markerIn("**egma:note** Reading package.json")).toEqual({
      kind: "note",
      text: "Reading package.json",
    });

    // And a value made of asterisks is not cut short by its own glob.
    expect(markerIn("**egma:found tools src/**/*.ts (2 definitions)**")).toEqual({
      kind: "found",
      field: "tools",
      value: "src/**/*.ts (2 definitions)",
    });
  });

  it("is not a marker just because the word appears", () => {
    expect(markerIn("I will report this with egma:found when I know.")).toBeNull();
    expect(markerIn("egma:invented framework retell-sdk")).toBeNull();
    expect(markerIn("egma:found framework")).toBeNull();
    expect(markerIn("egma:note")).toBeNull();
    expect(markerIn("Reading package.json")).toBeNull();
    expect(markerIn("")).toBeNull();
  });
});

describe("markers arriving in pieces", () => {
  it("waits for a line to be whole before reading it", () => {
    const stream = new MarkerStream();

    expect(stream.push("egma:found frame")).toEqual([]);
    expect(stream.push("work retell-sdk\nLet me look at the tools now.\n")).toEqual([
      { kind: "marker", marker: { kind: "found", field: "framework", value: "retell-sdk" } },
      { kind: "prose", text: "Let me look at the tools now." },
    ]);
  });

  it("reads a marker welded to the line before it, when a line ending went missing", () => {
    const stream = new MarkerStream();

    // Two messages, and the line ending between them never arrived.
    expect(stream.push("egma:note Reading the manifest.")).toEqual([]);
    expect(stream.push("egma:found framework retell-sdk\n")).toEqual([
      { kind: "marker", marker: { kind: "note", text: "Reading the manifest." } },
      { kind: "marker", marker: { kind: "found", field: "framework", value: "retell-sdk" } },
    ]);
  });

  it("reads a marker welded to a word, which is where a line ending belongs", () => {
    const stream = new MarkerStream();

    // No punctuation between them, and still the only reading that makes sense.
    expect(stream.push("Reading the manifestegma:found framework retell-sdk\n")).toEqual([
      { kind: "prose", text: "Reading the manifest" },
      { kind: "marker", marker: { kind: "found", field: "framework", value: "retell-sdk" } },
    ]);
  });

  it("leaves a marker alone when somebody is only talking about one", () => {
    const stream = new MarkerStream();

    expect(stream.push("I will report this with egma:found when I know.\n")).toEqual([
      { kind: "prose", text: "I will report this with egma:found when I know." },
    ]);
  });

  /**
   * The shapes a model writes when it is explaining the format rather than
   * using it. Each one is a sentence with a marker inside it, and reading any
   * of them as a fact invents the rest of the sentence as its value.
   */
  it("leaves a marker inside a sentence alone, whatever is wrapped around it", () => {
    const prose = [
      "I will use the format (egma:found framework retell-sdk) for each fact.",
      "Use `egma:found framework retell-sdk` when you know it.",
      'The line reads "egma:found framework retell-sdk" and nothing else.',
      "Write it as [egma:found framework retell-sdk] on its own line.",
      "The marker is *egma:found framework retell-sdk* in this example.",
      "One line each: 'egma:found framework retell-sdk' is the shape.",
    ];

    for (const line of prose) {
      const stream = new MarkerStream();
      expect(stream.push(`${line}\n`), line).toEqual([{ kind: "prose", text: line }]);
    }
  });

  it("reads a bold marker welded to the line before it", () => {
    const stream = new MarkerStream();

    expect(stream.push("egma:note Reading the manifest.")).toEqual([]);
    expect(stream.push("**egma:found** framework retell-sdk\n")).toEqual([
      { kind: "marker", marker: { kind: "note", text: "Reading the manifest." } },
      { kind: "marker", marker: { kind: "found", field: "framework", value: "retell-sdk" } },
    ]);
  });

  it("reads the last line even when the agent never ended it", () => {
    const stream = new MarkerStream();

    expect(stream.push("egma:none nothing here")).toEqual([]);
    expect(stream.flush()).toEqual([
      { kind: "marker", marker: { kind: "none", reason: "nothing here" } },
    ]);
    // And nothing twice.
    expect(stream.flush()).toEqual([]);
  });
});
