/** Public Suite/Test deletion at the command-to-HTTP-to-folder seam. */

import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runTestDeleteCommand } from "../src/commands/test.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readRepository,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import { pullRepository } from "../src/sync/pull.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const KEY = "egma_sk_delete-contract";
const run = promisify(execFile);

type Result = { readonly stdout: string; readonly stderr: string; readonly code: number };

async function egma(workspace: Workspace, args: readonly string[]): Promise<Result> {
  try {
    const answer = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    return { ...answer, code: 0 };
  } catch (cause) {
    const failed = cause as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? 1,
    };
  }
}

async function repositoryFor(platform: Platform): Promise<Workspace> {
  const workspace = await makeWorkspace();
  platform.signedInWith(KEY);
  await workspace.signIn(platform.url, KEY);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
    },
  });
  await pullRepository({
    signedIn: { url: platform.url, key: KEY },
    paths: folderPathsIn(workspace.dir),
  });
  return workspace;
}

function capture(): {
  readonly out: string[];
  readonly failed: string[];
  readonly write: (line: string) => void;
  readonly fail: (line: string) => void;
} {
  const out: string[] = [];
  const failed: string[] = [];
  return {
    out,
    failed,
    write: (line) => out.push(line),
    fail: (line) => failed.push(line),
  };
}

describe("Suite and Test deletion", () => {
  it("runs both local-path deletion verbs through the built CLI", async () => {
    const platform = await startPlatform();
    const selectedSuite = platform.suites.add("Release");
    const siblingSuite = platform.suites.add("Regression");
    const selectedTest = platform.tests.add({
      suiteId: selectedSuite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: selectedSuite.id,
      name: "Handles no slots",
      scenario: "There are no slots.",
      expectedBehaviors: ["The agent offers a callback."],
    });
    platform.tests.add({
      suiteId: siblingSuite.id,
      name: "Keeps the sibling",
      scenario: "The sibling remains.",
      expectedBehaviors: ["The sibling is unchanged."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const repository = await readRepository(folderPathsIn(workspace.dir));
      const selectedLocalSuite = repository.suites.find(
        (entry) => entry.manifest.id === selectedSuite.id,
      )!;
      const siblingLocalSuite = repository.suites.find(
        (entry) => entry.manifest.id === siblingSuite.id,
      )!;
      const selectedLocalTest = selectedLocalSuite.tests.find(
        (entry) => entry.test.name === "Books a visit",
      )!;
      const keptLocalTest = selectedLocalSuite.tests.find(
        (entry) => entry.test.name === "Handles no slots",
      )!;
      const keptBytes = await readFile(keptLocalTest.file, "utf8");

      const beforeTestDelete = platform.records.length;
      const testResult = await egma(workspace, [
        "test",
        "delete",
        path.relative(folderPathsIn(workspace.dir).tests, selectedLocalTest.file),
      ]);

      expect(testResult.code, testResult.stderr).toBe(0);
      expect(testResult.stdout).toContain(`Deleted Test Books a visit (${selectedTest.id}).`);
      expect(
        platform.records.slice(beforeTestDelete).map(({ method, path: requestPath, query }) => ({
          method,
          path: requestPath,
          query,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${selectedTest.versionId}`,
          query: `?projectId=${platform.projectId}`,
        },
        {
          method: "DELETE",
          path: `/v1/tests/${selectedTest.id}`,
          query:
            `?projectId=${platform.projectId}` +
            `&expectedVersionId=${selectedTest.versionId}` +
            `&expectedRevision=${selectedTest.revision}`,
        },
      ]);
      await expect(stat(selectedLocalTest.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(keptLocalTest.file, "utf8")).toBe(keptBytes);

      const beforeSuiteDelete = platform.records.length;
      const suiteResult = await egma(workspace, [
        "suite",
        "delete",
        selectedLocalSuite.directory,
      ]);

      expect(suiteResult.code, suiteResult.stderr).toBe(0);
      expect(suiteResult.stdout).toContain(`Deleted Suite Release (${selectedSuite.id}).`);
      expect(platform.records.slice(beforeSuiteDelete)).toEqual([
        expect.objectContaining({
          method: "DELETE",
          path: `/v1/test-suites/${selectedSuite.id}`,
          query: `?projectId=${platform.projectId}`,
        }),
      ]);
      await expect(stat(selectedLocalSuite.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(siblingLocalSuite.root)).resolves.toBeDefined();
      expect(platform.suites.suites.map((entry) => entry.id)).toEqual([siblingSuite.id]);
      expect(platform.tests.tests.map((entry) => entry.suiteId)).toEqual([siblingSuite.id]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("protects local work when no remote deletion can be completed", async () => {
    const platform = await startPlatform();
    const cleanupSuite = platform.suites.add("Release");
    const refusedSuite = platform.suites.add("Regression");
    const cleanupTest = platform.tests.add({
      suiteId: cleanupSuite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: refusedSuite.id,
      name: "Handles no slots",
      scenario: "There are no slots.",
      expectedBehaviors: ["The agent offers a callback."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const repository = await readRepository(folderPathsIn(workspace.dir));
      const cleanupLocal = repository.suites.find(
        (entry) => entry.manifest.id === cleanupSuite.id,
      )!;
      const refusedLocal = repository.suites.find(
        (entry) => entry.manifest.id === refusedSuite.id,
      )!;
      const localTest = cleanupLocal.tests[0]!;
      const draft = path.join(cleanupLocal.root, "local-draft.md");
      await writeFile(
        draft,
        serializeTestFile(
          aTestFile({
            name: "Local draft",
            scenario: "A local-only draft.",
            expectedBehaviors: blocking("The agent handles the draft."),
          }),
        ),
      );
      const beforeDraftDelete = platform.records.length;

      const draftResult = await egma(workspace, [
        "test",
        "delete",
        path.relative(folderPathsIn(workspace.dir).tests, draft),
      ]);

      expect(draftResult.code).toBe(1);
      expect(draftResult.stderr).toContain("has not been pushed");
      expect(platform.records).toHaveLength(beforeDraftDelete);
      await expect(stat(draft)).resolves.toBeDefined();

      const refused = capture();
      const beforeRefusal = await readFile(localTest.file, "utf8");
      const refusedCode = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: localTest.shown,
        signal: new AbortController().signal,
        out: refused.write,
        fail: refused.fail,
        fetchImpl: async (input, init) =>
          init?.method === "DELETE"
            ? new Response(
                JSON.stringify({
                  error: "version_conflict",
                  message: "The Test changed after it was read.",
                }),
                { status: 409, headers: { "content-type": "application/json" } },
              )
            : fetch(input, init),
      });

      expect(refusedCode).toBe(1);
      expect(refused.failed.join("\n")).toContain("The local Test was left unchanged.");
      expect(refused.failed.join("\n")).toContain("Pull before deciding what to delete.");
      expect(await readFile(localTest.file, "utf8")).toBe(beforeRefusal);
      expect(platform.tests.tests.some((test) => test.id === cleanupTest.id)).toBe(true);

      let remoteWasGoneBeforeCleanup = false;
      const output = capture();
      const cleanupCode = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: localTest.shown,
        signal: new AbortController().signal,
        out: output.write,
        fail: output.fail,
        removeFile: async (file) => {
          expect(file).toBe(localTest.file);
          remoteWasGoneBeforeCleanup = !platform.tests.tests.some(
            (test) => test.id === cleanupTest.id,
          );
          throw new Error("the disk is read-only");
        },
      });

      expect(cleanupCode).toBe(1);
      expect(remoteWasGoneBeforeCleanup).toBe(true);
      expect(output.out).toContain(
        `Egma deleted remote Test Books a visit (${cleanupTest.id}).`,
      );
      expect(output.failed.join("\n")).toContain(localTest.file);
      expect(output.failed.join("\n")).toContain("Remove that exact file");
      await expect(stat(localTest.file)).resolves.toBeDefined();

      const refusedBytes = await readFile(refusedLocal.tests[0]!.file, "utf8");
      const remoteDelete = await fetch(
        `${platform.url}/v1/test-suites/${refusedSuite.id}?projectId=${platform.projectId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${KEY}` },
        },
      );
      expect(remoteDelete.status).toBe(204);

      const refusedResult = await egma(workspace, [
        "suite",
        "delete",
        refusedLocal.directory,
      ]);

      expect(refusedResult.code).toBe(1);
      expect(refusedResult.stderr).toContain("The local Suite was left unchanged.");
      expect(await readFile(refusedLocal.tests[0]!.file, "utf8")).toBe(refusedBytes);
      await expect(stat(refusedLocal.root)).resolves.toBeDefined();
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });
});
