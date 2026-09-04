/**
 * The block a mock tool is written as, read and written.
 *
 * A mock tool is the test's own content, so this is the one place the block's
 * shape is settled. The promise being kept is the folder's oldest one:
 * everything egma writes goes out through one serializer, so reading a file
 * egma wrote gives back exactly what was written.
 */

import { describe, expect, it } from "vitest";

import {
  MockToolProblem,
  readMockTools,
  sameMockTools,
  writeMockTools,
  type MockToolEntry,
} from "../src/folder/mock-tools.ts";

const WHERE = "egma/tests/release/books-a-visit.md";

/** The section as a document, the way a file holds it. */
function written(entries: readonly MockToolEntry[]): string {
  return writeMockTools(entries).join("\n");
}

/** Read a section back out of the lines a file holds it as. */
function read(document: string): readonly MockToolEntry[] {
  // The heading itself is consumed by whoever finds the section, so what is
  // read here is everything under it — exactly what the test file hands over.
  const lines = document.split("\n");
  const from = lines.findIndex((line) => /^#{1,6}\s*mock\s+tools\s*$/iu.test(line.trim()));
  return readMockTools(lines.slice(from + 1), WHERE);
}

describe("a mock tool in a file", () => {
  it("reads back exactly what was written, whatever shape the answer has", () => {
    const entries: readonly MockToolEntry[] = [
      { tool: "check_availability", answer: { slots: [] } },
      { tool: "book_appointment", error: "the booking service is unreachable" },
      // Every shape a tool's own contract might have, including the one a
      // nullable field could never tell from "no answer at all".
      { tool: "count_waiting", answer: 3 },
      { tool: "last_visit", answer: null },
      { tool: "open_hours", answer: ["09:00", "17:00"] },
      { tool: "is_open", answer: false },
    ];

    expect(read(written(entries))).toEqual(entries);
  });

  it("writes the shape a reviewer reads, and nothing at all when there is none", () => {
    expect(written([{ tool: "check_availability", answer: { slots: [] } }])).toBe(
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

  it("writes the answer's own keys in the order it was handed them", () => {
    // Writing does not reorder anything inside an answer, because an answer is
    // the tool's own contract and egma has no opinion about how it reads. What
    // that buys is the round trip: the bytes are decided by the value, so a
    // `pull` straight after a `push` computes the same file and finds nothing
    // to do.
    const one = written([{ tool: "t", answer: { b: 2, a: 1 } }]);
    const other = written([{ tool: "t", answer: { a: 1, b: 2 } }]);

    expect(one).not.toBe(other);
    expect(read(one)).toEqual([{ tool: "t", answer: { b: 2, a: 1 } }]);
    expect(read(other)).toEqual([{ tool: "t", answer: { a: 1, b: 2 } }]);
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
      { tool: "check_availability", answer: { slots: [] } },
      { tool: "book_appointment", error: "unreachable" },
    ]);
  });

  it("keeps a heading and a fence that are inside an answer, not around it", () => {
    const entries: readonly MockToolEntry[] = [
      { tool: "read_note", answer: { note: "## Mock tools\n### not a heading\n```" } },
    ];

    expect(read(written(entries))).toEqual(entries);
  });

  it.each([
    [
      "a delay",
      '{"answer": 1, "delay_ms": 250}',
      /delay_ms.*take the line out/su,
    ],
    [
      "a scope",
      '{"answer": 1, "agents": ["front-desk"]}',
      /agents.*belongs to the test that writes it/su,
    ],
    ["a tool line", '{"tool": "t", "answer": 1}', /tool key.*heading is the tool's name/su],
    ["an invented key", '{"answer": 1, "invented": true}', /"invented".*exactly one/su],
    ["both branches", '{"answer": 1, "error": "no"}', /both answer and error/su],
    ["neither branch", "{}", /neither answer nor error/su],
    ["a failure that is not text", '{"error": 500}', /error is the failure/su],
  ])("refuses %s, naming the file and the reason", (_name, block, reason) => {
    const document = ["## Mock tools", "### t", "```json", block, "```"].join("\n");

    expect(() => read(document)).toThrow(MockToolProblem);
    expect(() => read(document)).toThrow(new RegExp(WHERE.replaceAll("/", "\\/"), "u"));
    expect(() => read(document)).toThrow(reason);
  });

  it("refuses a mock tool with nothing under it", () => {
    // It would reach egma's door saying nothing at all, and be turned away
    // there. Saying it here puts the sentence where the author is looking.
    expect(() => read(["## Mock tools", "### check_availability"].join("\n"))).toThrow(
      /"check_availability" has no JSON block/u,
    );
  });

  it("says which file and which mock tool when a block is not JSON", () => {
    const broken = ["## Mock tools", "### check_availability", "```json", "{slots: []", "```"].join(
      "\n",
    );

    expect(() => read(broken)).toThrow(MockToolProblem);
    expect(() => read(broken)).toThrow(
      /egma\/tests\/release\/books-a-visit\.md.*"check_availability"/su,
    );
  });

  it("says so when a block is JSON but not a mock tool", () => {
    const list = ["## Mock tools", "### check_availability", "```json", "[1, 2]", "```"].join("\n");

    expect(() => read(list)).toThrow(/"check_availability".*\{"answer"/su);
  });

  it("compares two entries by JSON value, not object-key order", () => {
    // JSON object keys have no semantic order. PostgreSQL can return nested
    // answer keys in a different order from the authored file, so every object
    // inside an answer must compare by value. Array order still matters because
    // it is part of the JSON value.
    expect(
      sameMockTools(
        [{ tool: "t", answer: { a: 1, b: 2 } }],
        [{ tool: "t", answer: { b: 2, a: 1 } }],
      ),
    ).toBe(true);
    expect(
      sameMockTools(
        [{ tool: "t", answer: { slots: ["09:00", "10:00"] } }],
        [{ tool: "t", answer: { slots: ["10:00", "09:00"] } }],
      ),
    ).toBe(false);
    expect(
      sameMockTools([{ tool: "t", answer: "down" }], [{ tool: "t", error: "down" }]),
    ).toBe(false);
  });

  it("compares two lists the way egma compares them: same order, same keys", () => {
    const one: readonly MockToolEntry[] = [{ tool: "a", answer: 1 }];

    expect(sameMockTools(one, [{ tool: "a", answer: 1 }])).toBe(true);
    expect(sameMockTools(one, [{ tool: "a", answer: 2 }])).toBe(false);
    expect(sameMockTools(one, [{ tool: "b", answer: 1 }])).toBe(false);
    expect(sameMockTools(one, [])).toBe(false);
    expect(
      sameMockTools(
        [
          { tool: "a", answer: 1 },
          { tool: "b", answer: 2 },
        ],
        [
          { tool: "b", answer: 2 },
          { tool: "a", answer: 1 },
        ],
      ),
    ).toBe(false);
  });
});
