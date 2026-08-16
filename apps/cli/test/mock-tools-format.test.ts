/**
 * The block a mock tool is written as, read and written.
 *
 * One shape serves the project's own file and a test's overrides, so this is
 * checked once and both places inherit it. The promise being kept is the
 * folder's oldest one: everything Egma writes goes out through one serializer,
 * so reading a file Egma wrote gives back exactly what was written.
 */

import { describe, expect, it } from "vitest";

import {
  MockToolProblem,
  readMockTools,
  sameMockTools,
  writeMockTools,
  type MockToolEntry,
} from "../src/folder/mock-tools.ts";

/** The section as a document, the way a file holds it. */
function written(entries: readonly MockToolEntry[]): string {
  return writeMockTools(entries).join("\n");
}

/** Read a section back out of the lines a file holds it as. */
function read(document: string): readonly MockToolEntry[] {
  // The heading itself is consumed by whoever finds the section, so what is
  // read here is everything under it — exactly what both files hand over.
  const lines = document.split("\n");
  const from = lines.findIndex((line) => /^#{1,6}\s*mock\s+tools\s*$/iu.test(line.trim()));
  return readMockTools(lines.slice(from + 1), "egma/mock-tools.md");
}

describe("a mock tool in a file", () => {
  it("reads back exactly what was written, whatever shape the answer has", () => {
    const entries: readonly MockToolEntry[] = [
      { tool: "check_availability", says: { answer: { slots: [] }, delay_ms: 250 } },
      { tool: "book_appointment", says: { error: "the booking service is unreachable" } },
      // Every shape a tool's own contract might have, including the one a
      // nullable field could never tell from "no answer at all".
      { tool: "count_waiting", says: { answer: 3 } },
      { tool: "last_visit", says: { answer: null } },
      { tool: "open_hours", says: { answer: ["09:00", "17:00"] } },
      { tool: "is_open", says: { answer: false } },
      { tool: "send_sms", says: { answer: { sent: true }, agents: ["front-desk"] } },
    ];

    expect(read(written(entries))).toEqual(entries);
  });

  it("writes the shape a reviewer reads, and nothing at all when there is none", () => {
    expect(
      written([{ tool: "check_availability", says: { answer: { slots: [] } } }]),
    ).toBe(
      [
        "## Mock tools",
        "### check_availability",
        "```json",
        "{",
        '  "answer": {',
        '    "slots": []',
        "  }",
        "}",
        "```",
      ].join("\n"),
    );

    expect(writeMockTools([])).toEqual([]);
  });

  it("writes the keys in the order it was handed them, and reads them back so", () => {
    // Writing does not reorder anything, because everything Egma writes is
    // handed to it in the one order Egma projects an answer into. What that
    // buys is the round trip: the bytes are decided by the value, so a `pull`
    // straight after a `push` computes the same file and finds nothing to do.
    const one = written([{ tool: "t", says: { delay_ms: 10, answer: 1 } }]);
    const other = written([{ tool: "t", says: { answer: 1, delay_ms: 10 } }]);

    expect(one).not.toBe(other);
    expect(read(one)).toEqual([{ tool: "t", says: { delay_ms: 10, answer: 1 } }]);
    expect(read(other)).toEqual([{ tool: "t", says: { answer: 1, delay_ms: 10 } }]);
  });

  it("reads a file somebody typed by hand, however they typed it", () => {
    const byHand = [
      "#### mock TOOLS",
      "",
      "#### check_availability",
      "",
      "```",
      '{ "answer": { "slots": [] } }',
      "```",
      "",
      "Some prose the author left behind.",
      "",
      "###### book_appointment",
      "```JSON",
      '{"error": "unreachable"}',
      "```",
    ].join("\n");

    expect(read(byHand)).toEqual([
      { tool: "check_availability", says: { answer: { slots: [] } } },
      { tool: "book_appointment", says: { error: "unreachable" } },
    ]);
  });

  it("carries a key Egma does not know about, rather than dropping it", () => {
    // What a mock tool holds is Egma's to decide. A folder that only knew
    // today's keys would swallow tomorrow's, and the author would never be told
    // which half of their mocked world went missing.
    const entries = read(
      ["## Mock tools", "### t", "```json", '{"answer": 1, "invented": true}', "```"].join("\n"),
    );

    expect(entries).toEqual([{ tool: "t", says: { answer: 1, invented: true } }]);
  });

  it("reads a mock tool with nothing under it as saying nothing", () => {
    // Refusing it here would be this end holding an opinion about what a mock
    // tool must answer with. Egma's door holds that one, and says it better.
    expect(read(["## Mock tools", "### check_availability"].join("\n"))).toEqual([
      { tool: "check_availability", says: {} },
    ]);
  });

  it("keeps a heading and a fence that are inside an answer, not around it", () => {
    const entries: readonly MockToolEntry[] = [
      {
        tool: "read_note",
        says: { answer: { note: "## Mock tools\n### not a heading\n```" } },
      },
    ];

    expect(read(written(entries))).toEqual(entries);
  });

  it("says which file and which mock tool when a block is not JSON", () => {
    const broken = ["## Mock tools", "### check_availability", "```json", "{slots: []", "```"].join(
      "\n",
    );

    expect(() => read(broken)).toThrow(MockToolProblem);
    expect(() => read(broken)).toThrow(/egma\/mock-tools\.md.*"check_availability"/su);
  });

  it("says so when a block is JSON but not a mock tool", () => {
    const list = ["## Mock tools", "### check_availability", "```json", "[1, 2]", "```"].join("\n");

    expect(() => read(list)).toThrow(/"check_availability".*\{"answer"/su);
  });

  it("compares two entries by what they say, not by the order they say it in", () => {
    // The order somebody typed the entry's own keys in is not something they
    // said: Egma has one order it writes them in, and a file that arrived in
    // another is the same mock tool. What is *inside* those keys is compared as
    // written, because an answer is whatever shape that tool's contract has and
    // the platform compares an answer the same way.
    expect(
      sameMockTools(
        [{ tool: "t", says: { delay_ms: 250, answer: { a: 1, b: 2 } } }],
        [{ tool: "t", says: { answer: { a: 1, b: 2 }, delay_ms: 250 } }],
      ),
    ).toBe(true);
    expect(
      sameMockTools(
        [{ tool: "t", says: { answer: { a: 1, b: 2 } } }],
        [{ tool: "t", says: { answer: { b: 2, a: 1 } } }],
      ),
    ).toBe(false);
  });

  it("compares two lists the way Egma compares them: same order, same keys", () => {
    const one: readonly MockToolEntry[] = [{ tool: "a", says: { answer: 1 } }];

    expect(sameMockTools(one, [{ tool: "a", says: { answer: 1 } }])).toBe(true);
    expect(sameMockTools(one, [{ tool: "a", says: { answer: 2 } }])).toBe(false);
    expect(sameMockTools(one, [{ tool: "b", says: { answer: 1 } }])).toBe(false);
    expect(sameMockTools(one, [])).toBe(false);
    expect(
      sameMockTools(
        [
          { tool: "a", says: { answer: 1 } },
          { tool: "b", says: { answer: 2 } },
        ],
        [
          { tool: "b", says: { answer: 2 } },
          { tool: "a", says: { answer: 1 } },
        ],
      ),
    ).toBe(false);
  });
});
