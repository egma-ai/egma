import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readRepository,
  serializeSuiteManifest,
  writeConfig,
} from "../src/folder/egma-folder.ts";
import { choosePlatform } from "../src/platform/credentials.ts";
import {
  parseTestFile,
  serializeTestFile,
  TEST_FILE_FORMAT,
} from "../src/folder/test-file.ts";
import { MAX_PORTABLE_COMPONENT_LENGTH } from "../src/folder/portable-path.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";
import { aTestFile, blocking } from "./support/test-file.ts";

const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const OTHER_SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWES";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      project: { id: "prj_01K3XQ7M4E8YB2FVN0H9TZQWER", name: "Northside" },
    },
  });
});

afterEach(async () => {
  await workspace.remove();
});

async function suite(
  directory: string,
  manifest: { readonly id: string; readonly name: string },
): Promise<string> {
  const root = path.join(folderPathsIn(workspace.dir).tests, directory);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "suite.yaml"), serializeSuiteManifest(manifest));
  return root;
}

describe("the complete suite repository", () => {
  it("round-trips current format 5 awkward content byte for byte", () => {
    const written = serializeTestFile(
      aTestFile({
        name: "true",
        description: 'The caller says "VIP" #2: exactly.',
        personas: [
          {
            id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWER",
            name: 'Rita: "Tuesday #2"',
          },
        ],
        version: VERSION_ID,
        identityRevision: REVISION,
        scenario: [
          'The caller says: "use #2".',
          "",
          "### Expected behaviors",
          "This quoted heading is still part of the scenario.",
          "## Mock tools",
          "## Env",
          "These headings are also scenario text because they come before the real behavior list.",
        ].join("\n"),
        expectedBehaviors: [
          'The agent says "Tuesday #2": yes.',
          "The agent keeps a wrapped\nstatement as one behavior.",
        ],
        mockTools: [
          {
            tool: "calendar #2",
            answer: {
              note: "### this JSON text is not a Markdown heading",
              slots: ["Tuesday #2", "a ``` fence inside text"],
            },
          },
          { tool: "book #2", error: 'the calendar said "no": twice' },
        ],
        env: {
          retell_dynamic_variables: { caller_name: 'Rita "the #2"' },
          job_dispatch_metadata: { tenant: "acme", note: "## Env\n```" },
        },
      }),
    );

    const read = parseTestFile(written, "awkward.md", "fallback");

    expect(read.format).toBe(TEST_FILE_FORMAT);
    expect(read.name).toBe("true");
    expect(read.description).toBe('The caller says "VIP" #2: exactly.');
    expect(read.personas).toEqual([
      {
        id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWER",
        name: 'Rita: "Tuesday #2"',
      },
    ]);
    expect(read.scenario).toContain("This quoted heading is still part of the scenario.");
    expect(read.expectedBehaviors).toEqual([
      'The agent says "Tuesday #2": yes.',
      "The agent keeps a wrapped statement as one behavior.",
    ]);
    expect(read.mockTools).toEqual([
      {
        tool: "calendar #2",
        answer: {
          note: "### this JSON text is not a Markdown heading",
          slots: ["Tuesday #2", "a ``` fence inside text"],
        },
      },
      { tool: "book #2", error: 'the calendar said "no": twice' },
    ]);
    expect(read.env).toEqual({
      retell_dynamic_variables: { caller_name: 'Rita "the #2"' },
      job_dispatch_metadata: { tenant: "acme", note: "## Env\n```" },
    });
    expect(serializeTestFile(read)).toBe(written);
  });

  it("reads many direct suites, including an empty one and duplicate display names", async () => {
    const first = await suite("release-contract", {
      id: SUITE_ID,
      name: "Release contract",
    });
    await writeFile(
      path.join(first, "books-a-visit.md"),
      serializeTestFile(
        aTestFile({
          name: "Books a visit",
          scenario: "The caller asks for Tuesday.",
          expectedBehaviors: blocking("The agent books Tuesday."),
        }),
      ),
    );
    await suite("empty-contract", {
      id: OTHER_SUITE_ID,
      name: "Release contract",
    });

    const repository = await readRepository(folderPathsIn(workspace.dir));

    expect(repository.config.project?.id).toBe(
      "prj_01K3XQ7M4E8YB2FVN0H9TZQWER",
    );
    expect(repository.suites.map((one) => [one.directory, one.manifest.name])).toEqual([
      ["empty-contract", "Release contract"],
      ["release-contract", "Release contract"],
    ]);
    expect(repository.suites[0]?.tests).toEqual([]);
    expect(repository.suites[1]?.tests[0]?.test.name).toBe("Books a visit");
  });

  it.each([
    ["a test directly in the tests root", async () => {
      await writeFile(path.join(folderPathsIn(workspace.dir).tests, "legacy.md"), "old");
    }],
    ["a suite with no manifest", async () => {
      await mkdir(path.join(folderPathsIn(workspace.dir).tests, "missing"));
    }],
    ["a nested directory", async () => {
      const root = await suite("one", { id: SUITE_ID, name: "One" });
      await mkdir(path.join(root, "nested"));
    }],
  ])("refuses %s", async (_name, arrange) => {
    await arrange();
    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(
      /repository is invalid/i,
    );
  });

  it.each([
    ["missing id", "name: One\n"],
    ["invalid id", "id: suite_one\nname: One\n"],
    ["blank name", `id: ${SUITE_ID}\nname: ""\n`],
    ["numeric name", `id: ${SUITE_ID}\nname: 123\n`],
    ["boolean name", `id: ${SUITE_ID}\nname: true\n`],
    ["outer whitespace", `id: ${SUITE_ID}\nname: " Release contract "\n`],
    ["unknown key", `id: ${SUITE_ID}\nname: One\nagent: receptionist\n`],
    ["duplicate id", `id: ${SUITE_ID}\nid: ${OTHER_SUITE_ID}\nname: One\n`],
    ["duplicate name", `id: ${SUITE_ID}\nname: One\nname: Hidden replacement\n`],
    [
      "an indented opening with a hidden root key",
      `  id: ${SUITE_ID}\n  name: One\nlegacy: hidden\n`,
    ],
  ])("refuses a manifest with %s", async (_name, document) => {
    const root = path.join(folderPathsIn(workspace.dir).tests, "one");
    await mkdir(root);
    await writeFile(path.join(root, "suite.yaml"), document);

    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(
      /suite\.yaml/,
    );
  });

  it("refuses copied suite identity before a caller writes", async () => {
    await suite("one", { id: SUITE_ID, name: "One" });
    await suite("copy", { id: SUITE_ID, name: "Copy" });

    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(
      new RegExp(`${SUITE_ID}.*one.*copy|${SUITE_ID}.*copy.*one`, "i"),
    );
  });

  it("does not accept the former unversioned singleton config", async () => {
    await writeFile(
      folderPathsIn(workspace.dir).config,
      "platform:\nproject:\nagent:\nconnection:\nsuite:\n  name: first-suite\n",
    );

    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(
      /config\.yaml.*folder format none.*requires format 4.*no legacy reader/i,
    );
  });

  it.each(["3", "4", "5.5", "5-old"])("does not read test file format %s", async (format) => {
    const root = await suite("one", { id: SUITE_ID, name: "One" });
    await writeFile(
      path.join(root, "legacy.md"),
      `---\nformat: ${format}\nname: Legacy\n---\n## Scenario\nOld\n## Expected behaviors\n1. Old\n`,
    );

    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(
      /requires format 5.*no legacy reader/i,
    );
  });

  it.each([
    ["non-portable suite directory", async () => {
      await suite("Release Contract", { id: SUITE_ID, name: "Release contract" });
    }],
    ["non-portable test file", async () => {
      const root = await suite("release-contract", { id: SUITE_ID, name: "Release contract" });
      await writeFile(
        path.join(root, "Books A Visit.md"),
        serializeTestFile(
          aTestFile({
            name: "Books a visit",
            scenario: "The caller asks for a visit.",
            expectedBehaviors: blocking("The agent offers a time."),
          }),
        ),
      );
    }],
    ["Windows device suite directory", async () => {
      await suite("cOn", { id: SUITE_ID, name: "CON" });
    }],
    ["overlong suite directory", async () => {
      await suite("a".repeat(MAX_PORTABLE_COMPONENT_LENGTH + 1), {
        id: SUITE_ID,
        name: "An unlimited product name",
      });
    }],
    ["Windows device test extension", async () => {
      const root = await suite("release-contract", {
        id: SUITE_ID,
        name: "Release contract",
      });
      await writeFile(
        path.join(root, "NuL.md"),
        serializeTestFile(
          aTestFile({
            name: "NUL",
            scenario: "The caller asks for a visit.",
            expectedBehaviors: blocking("The agent offers a time."),
          }),
        ),
      );
    }],
    ["overlong test file", async () => {
      const root = await suite("release-contract", {
        id: SUITE_ID,
        name: "Release contract",
      });
      await writeFile(
        path.join(root, `${"a".repeat(MAX_PORTABLE_COMPONENT_LENGTH)}.md`),
        serializeTestFile(
          aTestFile({
            name: "An unlimited product name",
            scenario: "The caller asks for a visit.",
            expectedBehaviors: blocking("The agent offers a time."),
          }),
        ),
      );
    }],
  ])("refuses a %s", async (_name, arrange) => {
    await arrange();
    await expect(readRepository(folderPathsIn(workspace.dir))).rejects.toThrow(/portable/i);
  });

  it("refuses an unbound suite identity before it selects another platform", async () => {
    await writeConfig(folderPathsIn(workspace.dir).config, EMPTY_CONFIG);
    await suite("release-contract", { id: SUITE_ID, name: "Release contract" });

    await expect(
      choosePlatform({
        env: { ...process.env, EGMA_URL: "https://other-egma.example" },
        flag: "https://other-egma.example",
        cwd: workspace.dir,
      }),
    ).rejects.toThrow(new RegExp(`${SUITE_ID}.*Nothing was sent`, "s"));
  });
});
