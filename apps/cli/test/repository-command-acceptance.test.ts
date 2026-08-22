/** One complete suite repository through the built CLI and real HTTP fixture. */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  folderPathsIn,
  readRepository,
  serializeMockToolsFile,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import { startPlatform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const run = promisify(execFile);
const KEY = "egma_sk_complete-suite-command-acceptance";

type Result = { readonly stdout: string; readonly stderr: string; readonly code: number };

async function egma(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<Result> {
  try {
    const answer = await run(process.execPath, [CLI_ENTRY, ...args], { cwd, env });
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

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

it("creates a suite first, pushes the complete folder atomically, and runs that directory", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    platform.signedInWith(KEY);
    await workspace.signIn(platform.url, KEY);
    const registration = await fetch(`${platform.url}/v1/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Front desk",
        connection: {
          name: "Fixture chat",
          agentPlatform: "retell",
          connectionType: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          config: { retellAgentId: "complete-suite-agent" },
          credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
        },
      }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as {
      readonly agent: { readonly id: string; readonly projectId: string; readonly name: string };
      readonly connection: { readonly id: string; readonly name: string };
    };
    const folder = await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: { origin: platform.url },
        project: { id: registered.agent.projectId, name: "Fixture project" },
        agent: { id: registered.agent.id, name: registered.agent.name },
        connection: {
          id: registered.connection.id,
          name: registered.connection.name,
        },
      },
    });
    const env = workspace.env();

    const created = await egma(workspace.dir, env, [
      "suite",
      "create",
      "release-gate",
      "--name",
      "Northside Ford",
    ]);
    expect(created.code, created.stderr).toBe(0);
    const suiteId = platform.suites.suites[0]?.id ?? "";
    expect(suiteId).toMatch(/^ste_/u);
    const suiteRoot = path.join(folder.paths.tests, "release-gate");
    expect(await readFile(path.join(suiteRoot, "suite.yaml"), "utf8")).toBe(
      serializeSuiteManifest({ id: suiteId, name: "Northside Ford" }),
    );
    const config = await readFile(folder.paths.config, "utf8");
    expect(config).not.toMatch(/^suite:/mu);

    await writeFile(
      path.join(suiteRoot, "books-a-visit.md"),
      serializeTestFile(
        aTestFile({
          name: "Books a visit",
          scenario: "The caller asks for Tuesday.",
          expectedBehaviors: blocking("The agent books Tuesday."),
        }),
      ),
    );
    await writeFile(
      path.join(suiteRoot, "handles-no-slots.md"),
      serializeTestFile(
        aTestFile({
          name: "Handles no slots",
          scenario: "No appointment is available.",
          expectedBehaviors: blocking("The agent offers a callback."),
        }),
      ),
    );
    await writeFile(
      folder.paths.mockTools,
      serializeMockToolsFile([
        { tool: "calendar", says: { answer: { slots: [] } } },
      ]),
    );

    const beforePush = platform.records.length;
    const pushed = await egma(workspace.dir, env, ["push"]);
    expect(pushed.code, pushed.stderr).toBe(0);
    const pushWrites = platform.records
      .slice(beforePush)
      .filter((record) => record.method !== "GET")
      .map((record) => `${record.method} ${record.path}`);
    expect(pushWrites).toEqual(["POST /v1/repository/change-set"]);
    expect(platform.tests.tests).toHaveLength(2);
    expect(platform.mocking.mockTools).toEqual([
      expect.objectContaining({ tool: "calendar", answer: { answer: { slots: [] } } }),
    ]);
    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.suites).toHaveLength(1);
    expect(repository.suites[0]?.directory).toBe("release-gate");
    expect(repository.suites[0]?.tests).toHaveLength(2);
    expect(
      repository.suites[0]?.tests.every(
        (file) => file.test.version !== null && file.test.identityRevision !== null,
      ),
    ).toBe(true);

    const expectedPins = repository.suites[0]!.tests
      .map((file) => {
        const remote = platform.tests.seeded(file.test.name);
        return { testId: remote.id, versionId: file.test.version };
      })
      .sort((a, b) => a.testId.localeCompare(b.testId));
    const beforeRun = platform.records.length;
    const started = await egma(workspace.dir, env, [
      "run",
      "release-gate",
      "--name",
      "Release gate",
      "--no-follow",
    ]);
    expect(started.code, started.stderr).toBe(0);
    const runRequest = platform.records
      .slice(beforeRun)
      .find((record) => record.method === "POST" && record.path === "/v1/runs");
    expect(runRequest?.body).toMatchObject({
      suiteId,
      agentId: registered.agent.id,
      connectionId: registered.connection.id,
      name: "Release gate",
    });
    const sentPins = (runRequest?.body?.expectedTestVersions ?? []) as {
      readonly testId: string;
      readonly versionId: string;
    }[];
    expect(
      [...sentPins].sort((a, b) => a.testId.localeCompare(b.testId)),
    ).toEqual(expectedPins);
    expect(runRequest?.body).not.toHaveProperty("testVersionIds");
    expect(runRequest?.body).not.toHaveProperty("label");
    expect(platform.running.runs).toEqual([
      expect.objectContaining({ suiteId, expectedSimulationCount: 2 }),
    ]);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});
