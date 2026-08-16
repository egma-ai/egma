/**
 * The folder and the file format, checked where they are decided.
 *
 * Everything here is about bytes. The folder is committed, so what Egma writes
 * into it turns up in somebody's diff; and `pull` straight after `push` has to
 * change nothing, which is a promise about the serializer rather than about the
 * two verbs. Both are cheaper to hold here than through a subprocess.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindRepositoryPlatform,
  createEgmaFolder,
  folderPathsIn,
  parseConfig,
  parseMockToolsFile,
  readFolder,
  readFolderTests,
  serializeConfig,
  updateConfig,
  writeTestFile,
} from "../src/folder/egma-folder.ts";
import {
  fileNameFor,
  parseTestFile,
  serializeTestFile,
  type TestFile,
} from "../src/folder/test-file.ts";
import { readYaml, yamlScalar } from "../src/folder/yaml.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

/** The format as it was written down, byte for byte. */
const GENERATED = `---
name: missed-appointment-reschedule
personas: [impatient-caller]
version: tstv_01K3XQ7M4E8YB2FVN0H9TZQWER
---
## Scenario
The caller missed yesterday's appointment and wants to
reschedule this week. They are short on time and irritated.
## Expected behaviors
1. The agent acknowledges the missed appointment without blame.
2. The agent offers at least two concrete alternative slots.
3. The agent confirms the new booking before ending the call.
`;

describe("the test file format", () => {
  it("reads the file the format was written down as", () => {
    const test = parseTestFile(GENERATED, "missed-appointment-reschedule.md", "fallback");

    expect(test.name).toBe("missed-appointment-reschedule");
    expect(test.personas).toEqual(["impatient-caller"]);
    expect(test.version).toBe("tstv_01K3XQ7M4E8YB2FVN0H9TZQWER");
    expect(test.scenario).toBe(
      "The caller missed yesterday's appointment and wants to\nreschedule this week. They are short on time and irritated.",
    );
    expect(test.expectedBehaviors).toEqual([
      "The agent acknowledges the missed appointment without blame.",
      "The agent offers at least two concrete alternative slots.",
      "The agent confirms the new booking before ending the call.",
    ]);
  });

  it("writes back exactly what it read, byte for byte", () => {
    const test = parseTestFile(GENERATED, "a.md", "fallback");
    expect(serializeTestFile(test)).toBe(GENERATED);
  });

  it("leaves out what a fresh file leaves out", () => {
    const fresh: TestFile = {
      name: "after-hours-emergency",
      personas: [],
      version: null,
      scenario: "The caller has an emergency at 2am.",
      expectedBehaviors: ["The agent gives the emergency number."],
      mockTools: [],
    };

    const document = serializeTestFile(fresh);
    expect(document).toBe(
      [
        "---",
        "name: after-hours-emergency",
        "---",
        "## Scenario",
        "The caller has an emergency at 2am.",
        "## Expected behaviors",
        "1. The agent gives the emergency number.",
        "",
      ].join("\n"),
    );
    // No persona named takes the default, and nothing has synced it yet, so
    // there is nothing to pin.
    expect(document).not.toContain("personas:");
    expect(document).not.toContain("version:");
    expect(parseTestFile(document, "a.md", "x")).toEqual(fresh);
  });

  it("is stable however many times it goes round", () => {
    let document = GENERATED;
    for (let round = 0; round < 5; round += 1) {
      document = serializeTestFile(parseTestFile(document, "a.md", "x"));
    }
    expect(document).toBe(GENERATED);
  });

  it("reads a file somebody typed by hand, and then writes it the one way", () => {
    // A generated file that came out with the headings in a different case, a
    // dash list, a wrapped statement, and no frontmatter at all.
    const handWritten = [
      "# scenario",
      "",
      "The caller wants a refund.",
      "",
      "## expected behaviours",
      "- The agent checks the order number",
      "  before saying anything about money.",
      "- The agent never promises a date.",
      "",
    ].join("\n");

    const test = parseTestFile(handWritten, "refund.md", "refund-request");

    expect(test.name).toBe("refund-request");
    expect(test.version).toBeNull();
    expect(test.scenario).toBe("The caller wants a refund.");
    expect(test.expectedBehaviors).toEqual([
      "The agent checks the order number before saying anything about money.",
      "The agent never promises a date.",
    ]);

    // And once Egma has written it, it is in Egma's shape and stays there.
    const written = serializeTestFile(test);
    expect(written).toContain("## Scenario");
    expect(written).toContain("## Expected behaviors");
    expect(serializeTestFile(parseTestFile(written, "refund.md", "x"))).toBe(written);
  });

  it("reads a test with nothing to check, so that Egma can be the one to refuse it", () => {
    const empty = ["---", "name: unfalsifiable", "---", "## Scenario", "Something happens.", "## Expected behaviors", ""].join(
      "\n",
    );

    const test = parseTestFile(empty, "unfalsifiable.md", "x");
    expect(test.expectedBehaviors).toEqual([]);
  });

  it("quotes a name that would not read back as itself", () => {
    const awkward: TestFile = {
      name: "caller: refuses to give a name",
      personas: ["persona #2"],
      version: null,
      scenario: "s",
      expectedBehaviors: ["b"],
      mockTools: [],
    };

    const document = serializeTestFile(awkward);
    expect(parseTestFile(document, "a.md", "x")).toEqual(awkward);
    expect(yamlScalar("caller: refuses to give a name")).toBe(
      '"caller: refuses to give a name"',
    );
  });

  /**
   * Content that is awkward and entirely allowed.
   *
   * A test is prose a person wrote and a name a person chose, so the format has
   * to hold a colon, a hash, a quote, a bracket, a comma, a blank line and a
   * word in a script that is not this one. Two promises are held for every one
   * of them, and they are different promises:
   *
   * - **what Egma writes reads back as what Egma wrote.** Whatever shape the
   *   value arrived in, the file Egma wrote is a fixed point — writing it,
   *   reading it and writing it again changes nothing. This is the promise
   *   `pull` straight after `push` depends on.
   * - **content survives the trip**, wherever the format has room for it.
   *   Where it has none — a statement with a line break in it, when the list
   *   holds one statement per line — Egma writes the nearest shape the format
   *   does have rather than bytes that would read as something else.
   */
  describe("content that is awkward and entirely allowed", () => {
    const plain: TestFile = {
      name: "a-test",
      personas: [],
      version: null,
      scenario: "The situation.",
      expectedBehaviors: ["The agent does a thing."],
      mockTools: [],
    };

    const held: readonly (readonly [string, TestFile])[] = [
      ["a name with a colon", { ...plain, name: "caller: refuses to give a name" }],
      ["a name with a colon and no space", { ...plain, name: "shift:two" }],
      ["a name with a hash", { ...plain, name: "shift #2" }],
      ["a name with a hash and no space", { ...plain, name: "shift#2" }],
      ["a name with an apostrophe", { ...plain, name: "the caller's second try" }],
      ["a name with quotation marks", { ...plain, name: 'says "no" twice' }],
      ["a name with dots", { ...plain, name: "v1.2.3 regression" }],
      ["a name with dashes", { ...plain, name: "missed--appointment-reschedule" }],
      ["a name opening with a dash", { ...plain, name: "-opens-with-a-dash" }],
      ["a name that is a number", { ...plain, name: "2026" }],
      ["a name that is the word yes", { ...plain, name: "yes" }],
      ["a name with a comma", { ...plain, name: "late, then rude" }],
      ["a name with brackets", { ...plain, name: "[after hours]" }],
      ["a name in another script", { ...plain, name: "réservé — 予約 🎧" }],
      ["a persona with a comma", { ...plain, personas: ["impatient, rushed"] }],
      ["a persona with an apostrophe", { ...plain, personas: ["the caller's friend"] }],
      ["a persona with brackets", { ...plain, personas: ["caller [angry]"] }],
      ["a persona with a colon", { ...plain, personas: ["caller: angry"] }],
      ["a persona with a hash", { ...plain, personas: ["caller #2"] }],
      ["a persona in another script", { ...plain, personas: ["予約 🎧"] }],
      ["two personas", { ...plain, personas: ["first-caller", "second-caller"] }],
      ["prose with a hash", { ...plain, scenario: "They ask about shift #2." }],
      ["prose with a colon", { ...plain, scenario: "They say: no." }],
      ["prose with quotation marks", { ...plain, scenario: `He said "no" and 'left'.` }],
      ["prose with a blank line", { ...plain, scenario: "One thing.\n\nAnother thing." }],
      ["prose that opens with a rule", { ...plain, scenario: "---\nbelow a rule" }],
      ["prose with a heading of its own", { ...plain, scenario: "## Background\nmore" }],
      [
        "prose quoting the behaviors heading",
        { ...plain, scenario: "before\n## Expected behaviors\nafter" },
      ],
      ["prose quoting the scenario heading", { ...plain, scenario: "## Scenario\nagain" }],
      ["prose that looks like frontmatter", { ...plain, scenario: "name: not-frontmatter" }],
      ["prose with a bullet in it", { ...plain, scenario: "- a bullet\n- another" }],
      ["prose in another script", { ...plain, scenario: "予約を逃した — 🎧" }],
      ["a statement with a colon", { ...plain, expectedBehaviors: ["The agent says: hello."] }],
      ["a statement that looks like frontmatter", { ...plain, expectedBehaviors: ["name: value"] }],
      ["a statement opening with a dash", { ...plain, expectedBehaviors: ["- a dash first"] }],
      ["a statement already numbered", { ...plain, expectedBehaviors: ["1. already numbered"] }],
      ["a statement that is a heading", { ...plain, expectedBehaviors: ["## Expected behaviors"] }],
      ["a statement in another script", { ...plain, expectedBehaviors: ["予約 🎧 — done"] }],
      ["nothing to check at all", { ...plain, expectedBehaviors: [] }],
      ["a pinned version", { ...plain, version: "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER" }],
      [
        "an override the test answers a tool with",
        { ...plain, mockTools: [{ tool: "check_availability", says: { answer: { slots: [] } } }] },
      ],
      [
        "an override that fails, after a delay",
        {
          ...plain,
          mockTools: [
            { tool: "book_appointment", says: { error: "the booking service is unreachable", delay_ms: 800 } },
          ],
        },
      ],
      [
        "an override answering nothing at all, which Egma's door refuses",
        { ...plain, mockTools: [{ tool: "check_availability", says: { answer: null } }] },
      ],
      [
        "two overrides, in the order they were authored",
        {
          ...plain,
          mockTools: [
            { tool: "b_second", says: { answer: 2 } },
            { tool: "a_first", says: { answer: 1 } },
          ],
        },
      ],
      [
        "an override whose answer quotes every heading in the file",
        {
          ...plain,
          mockTools: [
            {
              tool: "read_note",
              says: {
                answer: {
                  note: "## Scenario\n## Expected behaviors\n## Mock tools\n### not a tool\n```",
                },
              },
            },
          ],
        },
      ],
      [
        "prose quoting the mock tools heading",
        { ...plain, scenario: "before\n## Mock tools\nafter" },
      ],
    ];

    it.each(held)("writes %s as a file that reads back as itself", (_what, test) => {
      const written = serializeTestFile(test);
      const read = parseTestFile(written, "a.md", "fallback");

      // Read it, write it again, and not one byte moves. Everything `pull`
      // straight after `push` promises rests on this.
      expect(serializeTestFile(read)).toBe(written);
      expect(read).toEqual(test);
    });

    /**
     * Values the format has no room for, and the shape Egma writes instead.
     *
     * The list holds one statement per line and the prose is the block between
     * two headings, so a statement carrying a line break and prose wrapped in
     * blank space cannot be written as they stand. What Egma writes is the
     * nearest shape the format has, and reading it gives that shape back.
     */
    const shaped: readonly (readonly [string, TestFile, TestFile])[] = [
      [
        "space wrapped around the prose",
        { ...plain, scenario: "\n  The situation.  \n" },
        { ...plain, scenario: "The situation." },
      ],
      [
        "a statement with a line break in it",
        { ...plain, expectedBehaviors: ["The agent checks the number\nbefore saying anything."] },
        { ...plain, expectedBehaviors: ["The agent checks the number before saying anything."] },
      ],
      [
        "space wrapped around a statement",
        { ...plain, expectedBehaviors: ["  The agent does a thing.  "] },
        { ...plain, expectedBehaviors: ["The agent does a thing."] },
      ],
      [
        "a persona with nothing in it",
        { ...plain, personas: ["first-caller", "   ", "second-caller"] },
        { ...plain, personas: ["first-caller", "second-caller"] },
      ],
    ];

    it.each(shaped)("writes %s in the nearest shape the format has", (_what, given, wanted) => {
      const written = serializeTestFile(given);
      expect(parseTestFile(written, "a.md", "fallback")).toEqual(wanted);
      // And that shape is where it stays.
      expect(serializeTestFile(wanted)).toBe(written);
    });
  });

  it("names a file after the test it holds", () => {
    expect(fileNameFor("missed-appointment-reschedule")).toBe(
      "missed-appointment-reschedule.md",
    );
    expect(fileNameFor("Caller refuses to give name")).toBe(
      "caller-refuses-to-give-name.md",
    );
    expect(fileNameFor("!!!")).toBe("test.md");
  });
});

describe("the egma folder", () => {
  /**
   * A binding that is already here is never rewritten, in either field.
   *
   * This file is committed and every clone of the repository reads it, so a run
   * that quietly changed it would be moving other people's target for them —
   * and the origin is the field that would do the most damage, because a
   * platform that names `http://localhost:3101` as its own address would send
   * every teammate to their own laptop.
   */
  it("never rewrites a platform binding that is already committed", async () => {
    const instance = "pf_01K3XQ7M4E8YB2FVN0H9TZQWEP";
    const platform = { origin: "https://old.example", instance };
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({
      repository: workspace.dir,
      config: { platform, agent: null, connection: null, suite: null },
    });
    const asCommitted = await readFile(paths.config, "utf8");

    // Binding again with what is there is the retry, and it changes no byte.
    expect((await bindRepositoryPlatform(workspace.dir, platform)).platform).toEqual(
      platform,
    );
    expect(await readFile(paths.config, "utf8")).toBe(asCommitted);

    // The same platform reached at another address is refused, not recorded.
    await expect(
      bindRepositoryPlatform(workspace.dir, {
        origin: "https://canonical.example",
        instance,
      }),
    ).rejects.toThrow("will not move a committed platform address");

    // And another platform entirely is the refusal it always was — which now
    // teaches the whole move, because nothing performs it.
    const moving = await bindRepositoryPlatform(workspace.dir, {
      origin: "https://old.example",
      instance: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEQ",
    }).then(
      () => null,
      (refusal: Error) => refusal,
    );

    expect(moving).not.toBeNull();
    const said = moving?.message ?? "";
    expect(said).toContain("Egma does not move a repository between platforms");
    expect(said).toContain("nothing was sent");

    // All four things a developer deletes, named at once. A refusal naming one
    // at a time is a second failure after the first.
    expect(said).toContain("the whole platform: block in egma/config.yaml");
    expect(said).toContain("the id: line under agent: in egma/config.yaml");
    expect(said).toContain("the id: line under connection: in egma/config.yaml");
    expect(said).toContain("the id: line under suite: in egma/config.yaml");
    expect(said).toContain("the version: line at the top of every file in egma/tests/");

    // What moving costs, said plainly rather than found out afterwards.
    expect(said).toContain("Your tests move with you");
    expect(said).toContain("stay on the platform that ran them");

    // One plain block of lines, so a coding agent can act on it without a
    // person reading the message out to it.
    const deletions = said
      .split("\n")
      .filter((line) => line.startsWith("  - "));
    expect(deletions).toHaveLength(5);

    // **And in that order.** Deleting the platform block is what unbinds the
    // repository, and an unbound repository falls back to Egma's own platform
    // — so a list that named it first would have somebody working top-down
    // arrive, one line in, at a repository still holding another platform's
    // identifiers and nothing left to keep them there. Identifiers and pins
    // come out first, the binding last, and the list says so out loud.
    expect(deletions.map((line) => line.slice(4))).toEqual([
      "the id: line under agent: in egma/config.yaml",
      "the id: line under connection: in egma/config.yaml",
      "the id: line under suite: in egma/config.yaml",
      "the version: line at the top of every file in egma/tests/",
      "last of all, the whole platform: block in egma/config.yaml",
    ]);
    expect(said).toContain("Delete the platform block last");

    // And no command that does it: the refusal teaches the move and nothing
    // offers to perform it.
    expect(said).not.toMatch(/egma rebind|--rebind|Egma move/u);

    expect(await readFile(paths.config, "utf8")).toBe(asCommitted);
  });

  it("is a config file, a mock tools file and a tests directory, and nothing else", async () => {
    const folder = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: "http://127.0.0.1:3101",
          instance: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEP",
        },
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: { name: "first-suite", id: null },
      },
    });

    expect(folder.created).toBe(true);
    expect(await readdir(folder.paths.root)).toEqual([
      "config.yaml",
      "mock-tools.md",
      "tests",
    ]);
    expect((await stat(folder.paths.tests)).isDirectory()).toBe(true);

    // Reserved, and deliberately not made.
    await expect(stat(path.join(folder.paths.root, "memory"))).rejects.toThrow();

    // Nothing secret, so nothing to keep out of git.
    await expect(stat(path.join(folder.paths.root, ".gitignore"))).rejects.toThrow();

    // The mock tools file is here from the start and holds none: the folder is
    // what teaches where a mock tool goes, and a file that is not there teaches
    // nobody.
    const mocks = await readFile(folder.paths.mockTools, "utf8");
    expect(mocks).toContain("## Mock tools");
    expect(mocks).not.toContain("```");
    expect(parseMockToolsFile(mocks, "egma/mock-tools.md")).toEqual([]);
    const written = await readFile(folder.paths.config, "utf8");
    expect(written).not.toContain("egma_sk_");
    expect(written).toBe(
      [
        "# What this folder points at on Egma.",
        "#",
        "# Committed on purpose: nothing in this folder is secret. Egma writes an id",
        "# beside each name once it has registered one.",
        "platform:",
        "  origin: http://127.0.0.1:3101",
        "  instance: pf_01K3XQ7M4E8YB2FVN0H9TZQWEP",
        "agent:",
        "  name: receptionist",
        "  id: agt_01K3XQ7M4E8YB2FVN0H9TZQWER",
        "connection:",
        "  name: retell-1",
        "  id: con_01K3XQ7M4E8YB2FVN0H9TZQWES",
        "suite:",
        "  name: first-suite",
        "",
      ].join("\n"),
    );
  });

  it("names all three even when Egma has registered none of them", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    const written = await readFile(folder.paths.config, "utf8");

    expect(written).toContain("agent:");
    expect(written).toContain("connection:");
    expect(written).toContain("suite:");
    expect(folder.config).toEqual({
      platform: null,
      agent: null,
      connection: null,
      suite: null,
    });
    // And what it wrote is what it reads back.
    expect(parseConfig(written, "config.yaml")).toEqual(folder.config);
  });

  it("recognises a folder that is already here and changes not one byte of it", async () => {
    const first = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: null,
        agent: { name: "receptionist", id: null },
        connection: null,
        suite: null,
      },
    });
    const before = await readFile(first.paths.config, "utf8");
    await writeFile(path.join(first.paths.tests, "kept.md"), GENERATED, "utf8");

    const second = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: null,
        agent: { name: "something-else", id: null },
        connection: null,
        suite: null,
      },
    });

    expect(second.created).toBe(false);
    expect(await readFile(second.paths.config, "utf8")).toBe(before);
    expect(await readFile(path.join(second.paths.tests, "kept.md"), "utf8")).toBe(GENERATED);
  });

  it("makes back a tests directory that went missing, without touching the config", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    const before = await readFile(folder.paths.config, "utf8");

    // A branch that carried the config and no tests leaves the folder like
    // this, because git does not keep an empty directory.
    await rm(folder.paths.tests, { recursive: true });

    const again = await createEgmaFolder({ repository: workspace.dir });

    expect(again.created).toBe(false);
    expect((await stat(folderPathsIn(workspace.dir).tests)).isDirectory()).toBe(true);
    expect(await readFile(again.paths.config, "utf8")).toBe(before);
  });

  it("writes an id beside a name once Egma has registered one", async () => {
    const folder = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: null,
        agent: { name: "receptionist", id: null },
        connection: null,
        suite: null,
      },
    });

    const updated = await updateConfig(folder.paths.config, {
      agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
    });

    expect(updated.agent).toEqual({
      name: "receptionist",
      id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER",
    });
    expect(await readFile(folder.paths.config, "utf8")).toContain(
      "  id: agt_01K3XQ7M4E8YB2FVN0H9TZQWER",
    );
  });

  it("reads a config somebody wrote the short way", () => {
    const config = parseConfig("agent: receptionist\nsuite: first-suite\n", "config.yaml");
    expect(config.agent).toEqual({ name: "receptionist", id: null });
    expect(config.connection).toBeNull();
    expect(config.suite).toEqual({ name: "first-suite", id: null });
  });

  /**
   * A person edits this file, and a person does not spell an origin the way
   * Egma spells one.
   *
   * Every one of these names the same platform. Read as written, they name a
   * platform that disagrees with itself — and the refusal a developer then
   * meets says the binding does not match the binding, tells them to drop
   * something that is not there, and ends with four deletions for a move they
   * are not making. So the shape is settled here, once, where the file is read.
   */
  it("reads a committed origin somebody wrote their own way as the address it is", () => {
    for (const written of [
      "https://egma.acme.example/",
      "https://EGMA.acme.example",
      "https://egma.acme.example:443",
      "  https://egma.acme.example  ",
    ]) {
      const config = parseConfig(
        `platform:\n  origin: ${JSON.stringify(written)}\n  instance: pf_01K3XQ7M4E8YB2FVN0H9TZQWEP\n`,
        "config.yaml",
      );
      expect(config.platform?.origin, written).toBe("https://egma.acme.example");
    }

    // And a line Egma cannot make sense of is left exactly as it was written:
    // it is refused by name at the edge that takes addresses, and rewriting it
    // here would hide which line in the file is the wrong one.
    expect(
      parseConfig(
        "platform:\n  origin: not-an-address\n  instance: pf_01K3XQ7M4E8YB2FVN0H9TZQWEP\n",
        "config.yaml",
      ).platform?.origin,
    ).toBe("not-an-address");
  });

  it("reads what it writes, and steps over comments while it does", () => {
    const document = serializeConfig({
      platform: null,
      agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
      connection: null,
      suite: null,
    });
    expect(readYaml(document, "config.yaml")).toEqual({
      platform: null,
      agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
      connection: null,
      suite: null,
    });
  });

  it("writes a name that needs quoting, and reads it back with its own spaces", () => {
    for (const name of ["the front desk: mornings", "shift #2", "  padded  ", "2026", "yes"]) {
      const written = serializeConfig({
        platform: null,
        agent: { name, id: null },
        connection: null,
        suite: null,
      });
      expect(parseConfig(written, "config.yaml").agent).toEqual({ name, id: null });
      // And the second write finds nothing to change.
      expect(serializeConfig(parseConfig(written, "config.yaml"))).toBe(written);
    }
  });

  it("reads every test in the folder, in one order", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    await writeFile(path.join(folder.paths.tests, "b.md"), GENERATED, "utf8");
    await writeFile(path.join(folder.paths.tests, "a.md"), GENERATED, "utf8");
    await writeFile(path.join(folder.paths.tests, "notes.txt"), "not a test", "utf8");

    const found = await readFolderTests(folder.paths);

    expect(found.map((entry) => entry.shown)).toEqual([
      "egma/tests/a.md",
      "egma/tests/b.md",
    ]);
  });

  /**
   * One broken file out of twelve used to end whatever was reading the folder,
   * which threw away the eleven good ones at the moment they mattered most —
   * right after a coding agent had spent two minutes writing them.
   */
  it("carries a file it cannot read rather than throwing over it", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    await writeFile(path.join(folder.paths.tests, "good.md"), GENERATED, "utf8");
    await writeFile(
      path.join(folder.paths.tests, "half-written.md"),
      "---\nname: half-written\npersonas: [never-closed\n---\n## Scenario\nx\n",
      "utf8",
    );
    // A directory that happens to end in `.md` is a file Egma cannot read too.
    await mkdir(path.join(folder.paths.tests, "a-folder.md"), { recursive: true });

    const read = await readFolder(folder.paths);

    expect(read.found.map((entry) => entry.shown)).toEqual(["egma/tests/good.md"]);
    expect(read.unreadable.map((entry) => entry.shown)).toEqual([
      "egma/tests/a-folder.md",
      "egma/tests/half-written.md",
    ]);
    // The reader's own words, which say where in the file to look.
    expect(read.unreadable[1]?.reason).toContain("half-written.md, line 2");

    // And the reader that only wants tests answers the tests, as it always did.
    expect((await readFolderTests(folder.paths)).map((entry) => entry.shown)).toEqual([
      "egma/tests/good.md",
    ]);
  });

  it("does not rewrite a file whose bytes are already right", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    const file = path.join(folder.paths.tests, "one.md");
    const test = parseTestFile(GENERATED, "one.md", "x");

    expect((await writeTestFile(file, test)).changed).toBe(true);
    expect((await writeTestFile(file, test)).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(GENERATED);
  });
});
