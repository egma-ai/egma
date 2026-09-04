/** Public Suite/Test deletion, checked at the command-to-HTTP-to-folder seam. */

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runSuiteDeleteCommand } from "../src/commands/suite.ts";
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
      const before = await readRepository(folderPathsIn(workspace.dir));
      const selectedLocalSuite = before.suites.find(
        (entry) => entry.manifest.id === selectedSuite.id,
      )!;
      const siblingLocalSuite = before.suites.find(
        (entry) => entry.manifest.id === siblingSuite.id,
      )!;
      const selectedLocalTest = selectedLocalSuite.tests.find(
        (entry) => entry.test.name === "Books a visit",
      )!;
      const keptLocalTest = selectedLocalSuite.tests.find(
        (entry) => entry.test.name === "Handles no slots",
      )!;
      const keptTestBytes = await readFile(keptLocalTest.file, "utf8");
      const selectedManifestBytes = await readFile(
        selectedLocalSuite.manifestFile,
        "utf8",
      );
      const siblingManifestBytes = await readFile(
        siblingLocalSuite.manifestFile,
        "utf8",
      );
      const siblingTestBytes = await readFile(siblingLocalSuite.tests[0]!.file, "utf8");

      const beforeTestDelete = platform.records.length;
      const testResult = await egma(workspace, [
        "test",
        "delete",
        path.relative(folderPathsIn(workspace.dir).tests, selectedLocalTest.file),
      ]);
      expect(testResult.code, testResult.stderr).toBe(0);
      expect(testResult.stdout).toContain(`Deleted Test Books a visit (${selectedTest.id}).`);
      expect(testResult.stdout).not.toContain("status:");
      expect(
        platform.records.slice(beforeTestDelete).map(({ method, path, query }) => ({
          method,
          path,
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
      expect(
        platform.records
          .slice(beforeTestDelete)
          .filter((record) => record.method === "DELETE"),
      ).toHaveLength(1);
      await expect(stat(selectedLocalTest.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(keptLocalTest.file, "utf8")).toBe(keptTestBytes);
      expect(await readFile(selectedLocalSuite.manifestFile, "utf8")).toBe(
        selectedManifestBytes,
      );

      const beforeSuiteDelete = platform.records.length;
      const suiteResult = await egma(workspace, [
        "suite",
        "delete",
        selectedLocalSuite.directory,
      ]);
      expect(suiteResult.code, suiteResult.stderr).toBe(0);
      expect(suiteResult.stdout).toContain(`Deleted Suite Release (${selectedSuite.id}).`);
      expect(suiteResult.stdout).not.toContain("status:");
      expect(
        platform.records.slice(beforeSuiteDelete).map(({ method, path, query }) => ({
          method,
          path,
          query,
        })),
      ).toEqual([
        {
          method: "DELETE",
          path: `/v1/test-suites/${selectedSuite.id}`,
          query: `?projectId=${platform.projectId}`,
        },
      ]);
      await expect(stat(selectedLocalSuite.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(siblingLocalSuite.root)).resolves.toBeDefined();
      expect(await readFile(siblingLocalSuite.manifestFile, "utf8")).toBe(
        siblingManifestBytes,
      );
      expect(await readFile(siblingLocalSuite.tests[0]!.file, "utf8")).toBe(
        siblingTestBytes,
      );
      expect(platform.suites.suites.map((entry) => entry.id)).toEqual([siblingSuite.id]);
      expect(platform.tests.tests.map((entry) => entry.suiteId)).toEqual([
        siblingSuite.id,
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("deletes one remote Test before it removes only the named local Markdown file", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const selected = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: suite.id,
      name: "Handles no slots",
      scenario: "There are no slots.",
      expectedBehaviors: ["The agent offers a callback."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const before = await readRepository(folderPathsIn(workspace.dir));
      const local = before.suites[0]!.tests.find(
        (entry) => entry.test.name === "Books a visit",
      )!;
      const sibling = before.suites[0]!.tests.find(
        (entry) => entry.test.name === "Handles no slots",
      )!;
      const written = path.relative(folderPathsIn(workspace.dir).tests, local.file);
      const firstRecord = platform.records.length;
      const output = capture();

      const code = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: written,
        signal: new AbortController().signal,
        out: output.write,
        fail: output.fail,
      });

      expect(code, output.failed.join("\n")).toBe(0);
      expect(output.out).toContain(`Deleted Test Books a visit (${selected.id}).`);
      expect(output.out).toContain(`Removed local file ${local.shown}.`);
      expect(output.out.join("\n")).not.toContain("status:");
      expect(output.failed).toEqual([]);
      await expect(stat(local.file)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(sibling.file, "utf8")).resolves.toContain("Handles no slots");
      await expect(readFile(before.suites[0]!.manifestFile, "utf8")).resolves.toContain(
        suite.id,
      );
      expect(platform.tests.tests.map((entry) => entry.name)).toEqual([
        "Handles no slots",
      ]);
      expect(platform.tests.version(selected.versionId)?.scenario).toBe(
        "The caller asks for Tuesday.",
      );
      expect(
        platform.records.slice(firstRecord).map((record) => ({
          method: record.method,
          path: record.path,
          query: record.query,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${selected.versionId}`,
          query: `?projectId=${platform.projectId}`,
        },
        {
          method: "DELETE",
          path: `/v1/tests/${selected.id}`,
          query:
            `?projectId=${platform.projectId}` +
            `&expectedVersionId=${selected.versionId}` +
            `&expectedRevision=${selected.revision}`,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("deletes a Suite and its remote Tests before it removes that exact local directory", async () => {
    const platform = await startPlatform();
    const selected = platform.suites.add("Release");
    const sibling = platform.suites.add("Regression");
    const selectedTest = platform.tests.add({
      suiteId: selected.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: sibling.id,
      name: "Handles no slots",
      scenario: "There are no slots.",
      expectedBehaviors: ["The agent offers a callback."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const before = await readRepository(folderPathsIn(workspace.dir));
      const selectedLocal = before.suites.find(
        (entry) => entry.manifest.id === selected.id,
      )!;
      const siblingLocal = before.suites.find(
        (entry) => entry.manifest.id === sibling.id,
      )!;
      await writeFile(
        path.join(selectedLocal.root, "local-draft.md"),
        serializeTestFile(
          aTestFile({
            name: "Local draft",
            scenario: "A local-only draft.",
            expectedBehaviors: blocking("The draft stays local until pushed."),
          }),
        ),
      );
      const firstRecord = platform.records.length;
      const output = capture();

      const code = await runSuiteDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        directory: selectedLocal.directory,
        signal: new AbortController().signal,
        out: output.write,
        fail: output.fail,
      });

      expect(code, output.failed.join("\n")).toBe(0);
      expect(output.out).toContain(`Deleted Suite Release (${selected.id}).`);
      expect(output.out).toContain(
        `Removed local directory egma/tests/${selectedLocal.directory}.`,
      );
      expect(output.out.join("\n")).not.toContain("status:");
      await expect(stat(selectedLocal.root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(siblingLocal.root)).resolves.toBeDefined();
      expect(platform.suites.suites.map((entry) => entry.id)).toEqual([sibling.id]);
      expect(platform.suites.wasDeleted(selected.id)).toBe(true);
      expect(platform.tests.tests.map((entry) => entry.suiteId)).toEqual([sibling.id]);
      expect(platform.tests.version(selectedTest.versionId)?.scenario).toBe(
        "The caller asks for Tuesday.",
      );
      expect(
        platform.records.slice(firstRecord).map((record) => ({
          method: record.method,
          path: record.path,
          query: record.query,
        })),
      ).toEqual([
        {
          method: "DELETE",
          path: `/v1/test-suites/${selected.id}`,
          query: `?projectId=${platform.projectId}`,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("keeps an existing Run readable after its Suite leaves authoring", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const test = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const headers = {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      };
      const registeredResponse = await fetch(`${platform.url}/v1/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Front desk",
          agentPlatform: "retell",
          connection: {
            name: "Fixture chat",
            agentPlatform: "retell",
            connectionType: "retell_chat_api",
            accessVariant: "retell_chat_api.api_key",
            modality: "chat",
            config: { retellAgentId: "delete-evidence-agent" },
            credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
          },
        }),
      });
      expect(registeredResponse.status).toBe(201);
      const registered = (await registeredResponse.json()) as {
        readonly agent: { readonly id: string };
        readonly connection: { readonly id: string };
      };
      const runResponse = await fetch(`${platform.url}/v1/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          suiteId: suite.id,
          agentId: registered.agent.id,
          connectionId: registered.connection.id,
          idempotencyKey: "run_delete_evidence",
          expectedTestVersions: [{ testId: test.id, versionId: test.versionId }],
        }),
      });
      expect(runResponse.status).toBe(201);
      const run = (await runResponse.json()) as { readonly id: string };
      const simulationResponse = await fetch(
        `${platform.url}/v1/runs/${run.id}/simulations`,
        { headers },
      );
      const simulations = (await simulationResponse.json()) as {
        readonly simulations: readonly { readonly id: string }[];
      };
      const localSuite = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!;
      const output = capture();

      const code = await runSuiteDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        directory: localSuite.directory,
        signal: new AbortController().signal,
        out: output.write,
        fail: output.fail,
      });
      expect(code, output.failed.join("\n")).toBe(0);

      const [heldRun, heldSimulation] = await Promise.all([
        fetch(`${platform.url}/v1/runs/${run.id}`, { headers }),
        fetch(`${platform.url}/v1/simulations/${simulations.simulations[0]!.id}`, {
          headers,
        }),
      ]);
      expect(heldRun.status).toBe(200);
      expect(heldSimulation.status).toBe(200);
      expect(await heldRun.json()).toMatchObject({ suiteDeleted: true });
      expect(await heldSimulation.json()).toMatchObject({
        test: {
          versionId: test.versionId,
          scenario: "The caller asks for Tuesday.",
          expectedBehaviors: ["The agent books Tuesday."],
        },
      });
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("leaves the local Suite unchanged when Egma refuses the deletion", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!;
      const response = await fetch(
        `${platform.url}/v1/test-suites/${suite.id}?projectId=${platform.projectId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${KEY}` },
        },
      );
      expect(response.status).toBe(204);
      const manifestBefore = await readFile(local.manifestFile, "utf8");
      const testBefore = await readFile(local.tests[0]!.file, "utf8");
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["suite", "delete", local.directory]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.split("\n")[0]).toBe(
        "there is no active test suite with that id",
      );
      expect(result.stderr).toContain("left unchanged");
      expect(await readFile(local.manifestFile, "utf8")).toBe(manifestBefore);
      expect(await readFile(local.tests[0]!.file, "utf8")).toBe(testBefore);
      expect(
        platform.records.slice(firstRecord).map(({ method, path, query, status }) => ({
          method,
          path,
          query,
          status,
        })),
      ).toEqual([
        {
          method: "DELETE",
          path: `/v1/test-suites/${suite.id}`,
          query: `?projectId=${platform.projectId}`,
          status: 404,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("leaves the local Test unchanged when Egma refuses the deletion", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const before = await readFile(local.file, "utf8");
      const response = await fetch(
        `${platform.url}/v1/tests/${remote.id}?projectId=${platform.projectId}` +
          `&expectedVersionId=${remote.versionId}` +
          `&expectedRevision=${remote.revision}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${KEY}` },
        },
      );
      expect(response.status).toBe(204);
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.split("\n")[0]).toBe(
        "there is no active test with that id",
      );
      expect(result.stderr).toContain("left unchanged");
      expect(await readFile(local.file, "utf8")).toBe(before);
      expect(
        platform.records.slice(firstRecord).map(({ method, path, query, status }) => ({
          method,
          path,
          query,
          status,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${remote.versionId}`,
          query: `?projectId=${platform.projectId}`,
          status: 200,
        },
        {
          method: "DELETE",
          path: `/v1/tests/${remote.id}`,
          query:
            `?projectId=${platform.projectId}` +
            `&expectedVersionId=${remote.versionId}` +
            `&expectedRevision=${remote.revision}`,
          status: 404,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("refuses to delete a Test when the local file names an old version", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const before = await readFile(local.file, "utf8");
      const updated = platform.tests.editInDashboard("Books a visit", {
        scenario: "The caller asks for Wednesday.",
      });
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("current Test");
      expect(result.stderr).toContain("Pull before deciding what to delete.");
      expect(await readFile(local.file, "utf8")).toBe(before);
      expect(platform.tests.tests).toHaveLength(1);
      expect(platform.tests.worldOf("Books a visit")).toMatchObject({
        versionId: updated.versionId,
      });
      expect(platform.tests.version(remote.versionId)).not.toBeNull();
      expect(
        platform.records.slice(firstRecord).map(({ method, path, query }) => ({
          method,
          path,
          query,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${remote.versionId}`,
          query: `?projectId=${platform.projectId}`,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("keeps newer remote work that arrives between the version read and delete", async () => {
    let platform!: Platform;
    let movedVersionId = "";
    let moved = false;
    platform = await startPlatform({
      afterTestVersionRead: () => {
        if (moved) return;
        moved = true;
        movedVersionId = platform.tests.editInDashboard("Books a visit", {
          scenario: "The caller asks for Wednesday.",
        }).versionId;
      },
    });
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const before = await readFile(local.file, "utf8");
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("moved on");
      expect(result.stderr).toContain("The local Test was left unchanged.");
      expect(result.stderr).toContain("Pull before deciding what to delete.");
      expect(await readFile(local.file, "utf8")).toBe(before);
      expect(platform.tests.tests).toHaveLength(1);
      expect(platform.tests.worldOf("Books a visit")).toMatchObject({
        versionId: movedVersionId,
      });
      expect(
        platform.records.slice(firstRecord).map(({ method, path, query, status }) => ({
          method,
          path,
          query,
          status,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${remote.versionId}`,
          query: `?projectId=${platform.projectId}`,
          status: 200,
        },
        {
          method: "DELETE",
          path: `/v1/tests/${remote.id}`,
          query:
            `?projectId=${platform.projectId}` +
            `&expectedVersionId=${remote.versionId}` +
            `&expectedRevision=${remote.revision}`,
          status: 409,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("keeps an identity-only edit that arrives between the version read and delete", async () => {
    let platform!: Platform;
    let movedRevision = "";
    let moved = false;
    platform = await startPlatform({
      afterTestVersionRead: () => {
        if (moved) return;
        moved = true;
        movedRevision = platform.tests.renameInDashboard("Books a visit", {
          name: "Books a renamed visit",
        }).revision;
      },
    });
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const before = await readFile(local.file, "utf8");
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `Test ${remote.id} changed after you opened it. Read it again before ` +
          "deciding whether to delete it.",
      );
      expect(result.stderr).toContain("The local Test was left unchanged.");
      expect(result.stderr).toContain("Pull before deciding what to delete.");
      expect(await readFile(local.file, "utf8")).toBe(before);
      expect(platform.tests.tests).toHaveLength(1);
      expect(platform.tests.seeded("Books a renamed visit")).toMatchObject({
        versionId: remote.versionId,
        revision: movedRevision,
      });
      expect(
        platform.records.slice(firstRecord).map(({ method, path, query, status }) => ({
          method,
          path,
          query,
          status,
        })),
      ).toEqual([
        {
          method: "GET",
          path: `/v1/test-versions/${remote.versionId}`,
          query: `?projectId=${platform.projectId}`,
          status: 200,
        },
        {
          method: "DELETE",
          path: `/v1/tests/${remote.id}`,
          query:
            `?projectId=${platform.projectId}` +
            `&expectedVersionId=${remote.versionId}` +
            `&expectedRevision=${remote.revision}`,
          status: 409,
        },
      ]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("refuses a synced Test whose local identity revision is missing", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const before = await readFile(local.file, "utf8");
      await writeFile(
        local.file,
        before.replace(`identity_revision: ${remote.revision}\n`, ""),
      );
      const withoutRevision = await readFile(local.file, "utf8");
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("has a remote version but no identity_revision");
      expect(result.stderr).toContain("Pull before deciding what to delete.");
      expect(await readFile(local.file, "utf8")).toBe(withoutRevision);
      expect(platform.tests.tests).toHaveLength(1);
      expect(platform.records.slice(firstRecord)).toEqual([]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("does not remove local bytes for an uncontracted 2xx deletion answer", async () => {
    const platform = await startPlatform();
    const suiteToDelete = platform.suites.add("Release");
    const suiteForTest = platform.suites.add("Regression");
    platform.tests.add({
      suiteId: suiteToDelete.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: suiteForTest.id,
      name: "Handles no slots",
      scenario: "There are no slots.",
      expectedBehaviors: ["The agent offers a callback."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const before = await readRepository(folderPathsIn(workspace.dir));
      const localSuite = before.suites.find(
        (entry) => entry.manifest.id === suiteToDelete.id,
      )!;
      const localTest = before.suites.find(
        (entry) => entry.manifest.id === suiteForTest.id,
      )!.tests[0]!;
      const uncontractedSuccess: typeof fetch = async (input, init) => {
        if (init?.method === "DELETE") {
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return fetch(input, init);
      };

      const suiteOutput = capture();
      const suiteCode = await runSuiteDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        directory: localSuite.directory,
        signal: new AbortController().signal,
        out: suiteOutput.write,
        fail: suiteOutput.fail,
        fetchImpl: uncontractedSuccess,
      });
      const testOutput = capture();
      const testCode = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: localTest.shown,
        signal: new AbortController().signal,
        out: testOutput.write,
        fail: testOutput.fail,
        fetchImpl: uncontractedSuccess,
      });

      expect(suiteCode).toBe(1);
      expect(testCode).toBe(1);
      expect(suiteOutput.out.join("\n")).not.toContain("status:");
      expect(testOutput.out.join("\n")).not.toContain("status:");
      await expect(stat(localSuite.root)).resolves.toBeDefined();
      await expect(stat(localTest.file)).resolves.toBeDefined();
      expect(platform.suites.suites.map((entry) => entry.id)).toContain(suiteToDelete.id);
      expect(platform.tests.tests).toHaveLength(2);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("refuses an unpushed Test without making an HTTP request or removing the file", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const workspace = await repositoryFor(platform);

    try {
      const localSuite = (await readRepository(folderPathsIn(workspace.dir))).suites.find(
        (entry) => entry.manifest.id === suite.id,
      )!;
      const draft = path.join(localSuite.root, "local-draft.md");
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
      const firstRecord = platform.records.length;

      const result = await egma(workspace, [
        "test",
        "delete",
        path.relative(folderPathsIn(workspace.dir).tests, draft),
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        `${path.relative(workspace.dir, draft)} has not been pushed, so it has no remote Test to delete. The local file was left unchanged. Remove the draft directly.\n`,
      );
      expect(platform.records).toHaveLength(firstRecord);
      await expect(readFile(draft, "utf8")).resolves.toContain("Local draft");
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("validates the complete repository before deleting a valid target", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const broken = path.join(folderPathsIn(workspace.dir).tests, "broken");
      await mkdir(broken);
      await writeFile(path.join(broken, "suite.yaml"), "name: Missing stable identity\n");
      const firstRecord = platform.records.length;

      const result = await egma(workspace, ["test", "delete", local.shown]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("egma/tests/broken/suite.yaml");
      expect(platform.records).toHaveLength(firstRecord);
      expect(platform.tests.tests).toHaveLength(1);
      await expect(readFile(local.file, "utf8")).resolves.toContain("Books a visit");
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("reports the exact remaining file when local cleanup fails after remote deletion", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const output = capture();

      const code = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: local.shown,
        signal: new AbortController().signal,
        out: output.write,
        fail: output.fail,
        removeFile: async () => {
          throw new Error("the disk is read-only");
        },
      });

      expect(code).toBe(1);
      expect(output.out).toContain(
        `Egma deleted remote Test Books a visit (${remote.id}).`,
      );
      expect(output.out.join("\n")).not.toContain("status:");
      expect(output.failed.join("\n")).toContain(local.file);
      expect(output.failed.join("\n")).toContain("Remove that exact file");
      expect(platform.tests.tests).toEqual([]);
      expect(platform.tests.version(remote.versionId)?.scenario).toBe(
        "The caller asks for Tuesday.",
      );
      await expect(readFile(local.file, "utf8")).resolves.toContain("Books a visit");
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("finishes exact Suite cleanup and reports the deletion before exit 130", async () => {
    const platform = await startPlatform();
    const remote = platform.suites.add("Release");
    const workspace = await repositoryFor(platform);
    const controller = new AbortController();

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!;
      const output = capture();
      const code = await runSuiteDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        directory: local.directory,
        signal: controller.signal,
        out: output.write,
        fail: output.fail,
        fetchImpl: async (input, init) => {
          const answer = await fetch(input, init);
          if (init?.method === "DELETE") controller.abort("interrupt");
          return answer;
        },
      });

      expect(code).toBe(130);
      expect(output.out).toContain(`Deleted Suite Release (${remote.id}).`);
      expect(output.out).toContain(
        `Removed local directory egma/tests/${local.directory}.`,
      );
      expect(output.failed.join("\n")).toContain(
        "The command was interrupted after Egma deleted this Suite.",
      );
      expect(output.failed.join("\n")).toContain("Nothing needs to be retried.");
      await expect(stat(local.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(platform.suites.wasDeleted(remote.id)).toBe(true);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("finishes exact Test cleanup and reports the deletion before exit 130", async () => {
    const platform = await startPlatform();
    const suite = platform.suites.add("Release");
    const remote = platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const workspace = await repositoryFor(platform);
    const controller = new AbortController();

    try {
      const local = (await readRepository(folderPathsIn(workspace.dir))).suites[0]!
        .tests[0]!;
      const output = capture();
      const code = await runTestDeleteCommand({
        access: { url: platform.url, credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: local.shown,
        signal: controller.signal,
        out: output.write,
        fail: output.fail,
        fetchImpl: async (input, init) => {
          const answer = await fetch(input, init);
          if (init?.method === "DELETE") controller.abort("interrupt");
          return answer;
        },
      });

      expect(code).toBe(130);
      expect(output.out).toContain(`Deleted Test Books a visit (${remote.id}).`);
      expect(output.out).toContain(`Removed local file ${local.shown}.`);
      expect(output.failed.join("\n")).toContain(
        "The command was interrupted after Egma deleted this Test.",
      );
      expect(output.failed.join("\n")).toContain("Nothing needs to be retried.");
      await expect(stat(local.file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(platform.tests.tests).toEqual([]);
    } finally {
      await Promise.all([platform.close(), workspace.remove()]);
    }
  });

  it("returns 130 and touches nothing when already interrupted", async () => {
    const workspace = await makeWorkspace();
    const controller = new AbortController();
    controller.abort();
    const output = capture();

    try {
      const code = await runTestDeleteCommand({
        access: { url: "https://egma.example", credentialsFile: workspace.credentialsFile },
        cwd: workspace.dir,
        file: "release/books-a-visit.md",
        signal: controller.signal,
        out: output.write,
        fail: output.fail,
      });

      expect(code).toBe(130);
      expect(output.out.join("\n")).not.toContain("status:");
    } finally {
      await workspace.remove();
    }
  });
});
