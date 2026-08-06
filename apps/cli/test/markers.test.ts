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

  it("leaves a marker alone when somebody is only talking about one", () => {
    const stream = new MarkerStream();

    expect(stream.push("I will report this with egma:found when I know.\n")).toEqual([
      { kind: "prose", text: "I will report this with egma:found when I know." },
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
