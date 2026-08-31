/** Read-only validation of the complete local repository and its personas. */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runValidateCommand } from "../src/commands/validate.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile, type FilePersona } from "../src/folder/test-file.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const RITA_ID = "prs_01K3XQ7M4E8YB2FVN0H9TZQWER";
const EVERYDAY_ID = "prs_01K3XQ7M4E8YB2FVN0H9TZQWES";

let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(JSON.stringify(body), { ...init, headers });
  }
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      project: { id: PROJECT_ID, name: "Northside" },
    },
  });
});

afterEach(async () => workspace.remove());

async function writeTest(
  fileName: string,
  personas: readonly FilePersona[],
): Promise<string> {
  const root = path.join(folderPathsIn(workspace.dir).tests, "release");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "suite.yaml"),
    serializeSuiteManifest({ id: SUITE_ID, name: "Release" }),
  );
  const file = path.join(root, fileName);
  await writeFile(
    file,
    serializeTestFile(
      aTestFile({
        name: "Books a visit",
        scenario: "The person asks for Tuesday.",
        expectedBehaviors: blocking("The agent books Tuesday."),
        personas,
      }),
    ),
  );
  return file;
}

function catalog(
  personas: readonly { readonly id: string; readonly name: string }[],
): typeof fetch {
  return async () => new JsonResponse({ personas, nextPageToken: null });
}

describe("runValidateCommand", () => {
  it("parses the real folder and validates id and name references against the project", async () => {
    await writeTest("books-a-visit.md", [
      // The id is authoritative, so a stale pulled display name does not make
      // a valid platform reference fail local validation.
      { id: EVERYDAY_ID, name: "Old display name" },
      { id: "", name: "Impatient Rita" },
    ]);
    const lines: string[] = [];

    const code = await runValidateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: catalog([
        { id: RITA_ID, name: "Impatient Rita" },
        { id: EVERYDAY_ID, name: "Everyday caller" },
      ]),
    });

    expect(code).toBe(0);
    expect(lines).toContain(`project: ${PROJECT_ID}`);
    expect(lines).toContain("suites: 1");
    expect(lines).toContain("tests: 1");
    expect(lines).toContain("persona-references: 2");
    expect(lines.at(-1)).toBe("status: valid");
  });

  it("names missing, ambiguous, duplicate, and absent persona references", async () => {
    await writeTest("bad-personas.md", [
      { id: "", name: "Twin" },
      { id: "", name: "Missing" },
      { id: RITA_ID, name: "Impatient Rita" },
      { id: RITA_ID, name: "Impatient Rita" },
    ]);
    await writeTest("nobody.md", []);
    const lines: string[] = [];

    const code = await runValidateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: catalog([
        { id: RITA_ID, name: "Impatient Rita" },
        { id: EVERYDAY_ID, name: "Twin" },
        { id: "prs_01K3XQ7M4E8YB2FVN0H9TZQWET", name: "Twin" },
      ]),
    });

    expect(code).toBe(1);
    expect(lines).toContain("status: invalid-personas");
    expect(lines).toContain(
      "issue: egma/tests/release/bad-personas.md persona name \"Twin\" matches more than one project persona. Use a stable persona id.",
    );
    expect(lines).toContain(
      "issue: egma/tests/release/bad-personas.md names unknown persona \"Missing\".",
    );
    expect(lines).toContain(
      `issue: egma/tests/release/bad-personas.md names persona ${RITA_ID} more than once.`,
    );
    expect(lines).toContain(
      "issue: egma/tests/release/nobody.md names no persona.",
    );
    expect(lines.at(-1)).toBe(
      "stderr: The Egma repository names personas this project cannot use. Nothing was written.",
    );
  });

  it("reports local parse failures before asking the platform for personas", async () => {
    const file = await writeTest("broken.md", [{ id: RITA_ID, name: "Impatient Rita" }]);
    await writeFile(file, "---\nformat: 3\n---\nBroken\n", "utf8");
    let requests = 0;
    const lines: string[] = [];

    const code = await runValidateCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: (line) => lines.push(line),
      fail: (line) => lines.push(`stderr: ${line}`),
      fetchImpl: async () => {
        requests += 1;
        return new JsonResponse({ personas: [], nextPageToken: null });
      },
    });

    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(lines).toContain("status: invalid-repository");
    expect(lines.some((line) => line.includes("uses test file format 3"))).toBe(true);
  });
});
