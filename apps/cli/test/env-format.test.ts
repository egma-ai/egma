/**
 * The block an env is written as, read and written.
 *
 * The env is what the agent was *started* with — the values a provider
 * substitutes into a prompt, and the blob a worker is handed on dispatch. It is
 * the test's own content, so it rides the test's own file, and the round trip
 * has to be exact for the same reason every other section's is: a `pull`
 * straight after a `push` must change zero bytes.
 */

import { describe, expect, it } from "vitest";

import {
  EnvProblem,
  readEnv,
  sameEnv,
  writeEnv,
  type TestEnv,
} from "../src/folder/env.ts";

const WHERE = "egma/tests/release/books-a-visit.md";

/** Read an env section back out of the lines a file holds it as. */
function readWorld(document: string): TestEnv | null {
  const lines = document.split("\n");
  const from = lines.findIndex((line) => /^#{1,6}\s*env\s*$/iu.test(line.trim()));
  return readEnv(lines.slice(from + 1), WHERE);
}

describe("the env in a file", () => {
  it("reads back exactly what was written, in the format's own order", () => {
    const env: TestEnv = {
      retell_dynamic_variables: { caller_name: "Margaret" },
      job_dispatch_metadata: { tenant: "acme", limits: { calls: 2 } },
    };

    expect(writeEnv(env).join("\n")).toBe(
      [
        "## Env",
        "```json",
        "{",
        '  "retell_dynamic_variables": {',
        '    "caller_name": "Margaret"',
        "  },",
        '  "job_dispatch_metadata": {',
        '    "tenant": "acme",',
        '    "limits": {',
        '      "calls": 2',
        "    }",
        "  }",
        "}",
        "```",
      ].join("\n"),
    );
    expect(readWorld(writeEnv(env).join("\n"))).toEqual(env);
  });

  it("writes the halves in one order however it was handed them", () => {
    // The bytes are the format's, not the platform's: PostgreSQL may answer
    // with either half first, and a file that moved with it would show a diff
    // nobody made.
    const first = writeEnv({
      job_dispatch_metadata: { tenant: "acme" },
      retell_dynamic_variables: { caller_name: "Margaret" },
    });
    const second = writeEnv({
      retell_dynamic_variables: { caller_name: "Margaret" },
      job_dispatch_metadata: { tenant: "acme" },
    });

    expect(first).toEqual(second);
  });

  it("writes nothing at all for a test that names no world", () => {
    expect(writeEnv(null)).toEqual([]);
    // A half with nothing in it says what an absent half says, and reading a
    // written one back gives null — so writing it would move bytes on the very
    // next pull.
    expect(writeEnv({ retell_dynamic_variables: {} })).toEqual([]);
    expect(
      writeEnv({
        retell_dynamic_variables: {},
        job_dispatch_metadata: { tenant: "acme" },
      }).join("\n"),
    ).toBe(
      [
        "## Env",
        "```json",
        "{",
        '  "job_dispatch_metadata": {',
        '    "tenant": "acme"',
        "  }",
        "}",
        "```",
      ].join("\n"),
    );
  });

  it("reads a fence somebody typed by hand, and an empty world as none", () => {
    expect(
      readWorld(
        ["#### ENV", "", "```", '{ "retell_dynamic_variables": { "who": "Rita" } }', "```"].join(
          "\n",
        ),
      ),
    ).toEqual({ retell_dynamic_variables: { who: "Rita" } });

    // Every spelling of "this test asks for nothing" reads as the one egma
    // stores, so a pull straight after a push has nothing to write.
    for (const empty of ["{}", '{"retell_dynamic_variables": {}}', '{"job_dispatch_metadata": {}}']) {
      expect(readWorld(["## Env", "```json", empty, "```"].join("\n"))).toBeNull();
    }
  });

  it.each([
    ["an invented key", '{"webhooks": {"url": "https://x.test"}}', /"webhooks".*nothing else/su],
    [
      "a reserved variable",
      '{"retell_dynamic_variables": {"egma_run_id": "r1"}}',
      /"egma_run_id".*egma_/su,
    ],
    [
      "a variable that is not text",
      '{"retell_dynamic_variables": {"calls": 2}}',
      /"calls".*written as text/su,
    ],
    [
      "dispatch metadata that is not an object",
      '{"job_dispatch_metadata": ["acme"]}',
      /job_dispatch_metadata.*written as an\s+object/su,
    ],
    ["a block that is not an object", "[1, 2]", /an env is written/su],
    ["a block that is not JSON", "{tenant: acme", /not JSON Egma can read/su],
  ])("refuses %s, naming the file and the reason", (_name, block, reason) => {
    const document = ["## Env", "```json", block, "```"].join("\n");

    expect(() => readWorld(document)).toThrow(EnvProblem);
    expect(() => readWorld(document)).toThrow(new RegExp(WHERE.replaceAll("/", "\\/"), "u"));
    expect(() => readWorld(document)).toThrow(reason);
  });

  it("refuses an Env heading with nothing under it", () => {
    expect(() => readWorld("## Env")).toThrow(/no JSON block under it/u);
  });

  it("compares two envs by JSON value, not object-key order", () => {
    expect(
      sameEnv(
        { job_dispatch_metadata: { a: 1, b: 2 } },
        { job_dispatch_metadata: { b: 2, a: 1 } },
      ),
    ).toBe(true);
    expect(sameEnv(null, null)).toBe(true);
    expect(sameEnv(null, { retell_dynamic_variables: { who: "Rita" } })).toBe(false);
    expect(
      sameEnv(
        { retell_dynamic_variables: { who: "Rita" } },
        { retell_dynamic_variables: { who: "Margaret" } },
      ),
    ).toBe(false);
  });
});
