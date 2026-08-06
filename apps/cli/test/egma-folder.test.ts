/**
 * The folder and the file format, checked where they are decided.
 *
 * Everything here is about bytes. The folder is committed, so what egma writes
 * into it turns up in somebody's diff; and `pull` straight after `push` has to
 * change nothing, which is a promise about the serializer rather than about the
 * two verbs. Both are cheaper to hold here than through a subprocess.
 */

import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEgmaFolder,
  folderPathsIn,
  parseConfig,
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

/** The file the prototype fixed, byte for byte. */
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

    // And once egma has written it, it is in egma's shape and stays there.
    const written = serializeTestFile(test);
    expect(written).toContain("## Scenario");
    expect(written).toContain("## Expected behaviors");
    expect(serializeTestFile(parseTestFile(written, "refund.md", "x"))).toBe(written);
  });

  it("reads a test with nothing to check, so that egma can be the one to refuse it", () => {
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
    };

    const document = serializeTestFile(awkward);
    expect(parseTestFile(document, "a.md", "x")).toEqual(awkward);
    expect(yamlScalar("caller: refuses to give a name")).toBe(
      '"caller: refuses to give a name"',
    );
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
  it("is a config file and a tests directory, and nothing else", async () => {
    const folder = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: { name: "first-suite", id: null },
      },
    });

    expect(folder.created).toBe(true);
    expect(await readdir(folder.paths.root)).toEqual(["config.yaml", "tests"]);
    expect((await stat(folder.paths.tests)).isDirectory()).toBe(true);

    // Reserved, and deliberately not made.
    await expect(stat(path.join(folder.paths.root, "memory"))).rejects.toThrow();

    // Nothing secret, so nothing to keep out of git.
    await expect(stat(path.join(folder.paths.root, ".gitignore"))).rejects.toThrow();
    const written = await readFile(folder.paths.config, "utf8");
    expect(written).not.toContain("egma_sk_");
    expect(written).toBe(
      [
        "# What this folder points at on egma.",
        "#",
        "# Committed on purpose: nothing in this folder is secret. egma writes an id",
        "# beside each name once it has registered one.",
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

  it("names all three even when egma has registered none of them", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    const written = await readFile(folder.paths.config, "utf8");

    expect(written).toContain("agent:");
    expect(written).toContain("connection:");
    expect(written).toContain("suite:");
    expect(folder.config).toEqual({ agent: null, connection: null, suite: null });
    // And what it wrote is what it reads back.
    expect(parseConfig(written, "config.yaml")).toEqual(folder.config);
  });

  it("recognises a folder that is already here and changes not one byte of it", async () => {
    const first = await createEgmaFolder({
      repository: workspace.dir,
      config: { agent: { name: "receptionist", id: null }, connection: null, suite: null },
    });
    const before = await readFile(first.paths.config, "utf8");
    await writeFile(path.join(first.paths.tests, "kept.md"), GENERATED, "utf8");

    const second = await createEgmaFolder({
      repository: workspace.dir,
      config: { agent: { name: "something-else", id: null }, connection: null, suite: null },
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

  it("writes an id beside a name once egma has registered one", async () => {
    const folder = await createEgmaFolder({
      repository: workspace.dir,
      config: { agent: { name: "receptionist", id: null }, connection: null, suite: null },
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

  it("reads what it writes, and steps over comments while it does", () => {
    const document = serializeConfig({
      agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
      connection: null,
      suite: null,
    });
    expect(readYaml(document, "config.yaml")).toEqual({
      agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
      connection: null,
      suite: null,
    });
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

  it("does not rewrite a file whose bytes are already right", async () => {
    const folder = await createEgmaFolder({ repository: workspace.dir });
    const file = path.join(folder.paths.tests, "one.md");
    const test = parseTestFile(GENERATED, "one.md", "x");

    expect((await writeTestFile(file, test)).changed).toBe(true);
    expect((await writeTestFile(file, test)).changed).toBe(false);
    expect(await readFile(file, "utf8")).toBe(GENERATED);
  });
});
