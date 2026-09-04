/** Every `egma init` state through the built CLI and fixture platform. */

import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readConfig,
  readRepository,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import { writeCredentials } from "../src/platform/credentials.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);
const KEY = "egma_sk_init-command-acceptance";
const OTHER_PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWES";

type Result = { readonly stdout: string; readonly stderr: string; readonly code: number };

async function egma(
  workspace: Workspace,
  platform: Platform,
  extra: readonly string[] = [],
): Promise<Result> {
  try {
    const answer = await run(
      process.execPath,
      [CLI_ENTRY, "init", "--url", platform.url, ...extra],
      { cwd: workspace.dir, env: workspace.env() },
    );
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

async function signIn(
  platform: Platform,
  workspace: Workspace,
  projectId?: string,
): Promise<void> {
  platform.signedInWith(KEY);
  if (projectId === undefined) {
    await workspace.signIn(platform.url, KEY);
    return;
  }
  await writeCredentials(workspace.credentialsFile, {
    url: platform.url,
    key: KEY,
    login: { apiKeyId: "ak_init-command-acceptance", projectId },
  });
}

async function isMissing(file: string): Promise<boolean> {
  try {
    await stat(file);
    return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("creates nothing when the machine is signed out", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("egma login");
    expect(platform.records).toEqual([]);
    expect(await isMissing(folderPathsIn(workspace.dir).config)).toBe(true);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("uses the Project carried by a login credential without listing Projects", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    await signIn(platform, workspace, platform.projectId);

    const result = await egma(workspace, platform);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Initialized Egma");
    expect((await readConfig(folderPathsIn(workspace.dir).config)).project).toEqual({
      id: platform.projectId,
      name: "Fixture project",
    });
    expect(platform.records.map((record) => record.path)).not.toContain("/v1/projects");
    expect(platform.records[0]?.path).toBe(`/v1/projects/${platform.projectId}`);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("creates nothing when an organization credential has no Project", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    platform.suites.setListedProjects([]);
    await signIn(platform, workspace);

    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "This Egma account has no Project. Create a Project in Egma, then run egma init again. Nothing was changed.\n",
    );
    expect(platform.records.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/projects",
    ]);
    expect(await isMissing(folderPathsIn(workspace.dir).config)).toBe(true);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("selects the only Project and pulls its complete repository", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    await signIn(platform, workspace);
    const agentResponse = await fetch(
      `${platform.url}/v1/agents?projectId=${platform.projectId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Front desk", agentPlatform: "retell" }),
      },
    );
    expect(agentResponse.status).toBe(201);
    const agent = (await agentResponse.json()) as {
      readonly agent: { readonly id: string };
    };
    const suite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const firstRecord = platform.records.length;

    const result = await egma(workspace, platform);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Initialized Egma");
    expect(result.stdout).toContain("Suites: 1");
    expect(result.stdout).toContain("Tests: 1");
    expect(
      platform.records.slice(firstRecord).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "GET /v1/projects",
      `GET /v1/projects/${platform.projectId}`,
      "GET /v1/agents",
      "GET /v1/test-suites",
      "GET /v1/tests",
    ]);
    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.config.project).toEqual({
      id: platform.projectId,
      name: "Fixture project",
    });
    expect(repository.config.agents).toEqual([
      {
        id: agent.agent.id,
        name: "Front desk",
        platform: "retell",
        connections: [],
      },
    ]);
    expect(repository.suites).toHaveLength(1);
    expect(repository.suites[0]?.manifest).toEqual({ id: suite.id, name: "Release" });
    expect(repository.suites[0]?.tests[0]?.test.name).toBe("Books a visit");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("lists several Projects and waits for an explicit choice", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    platform.suites.setListedProjects([
      { id: platform.projectId, name: "Fixture project" },
      { id: OTHER_PROJECT_ID, name: "Westside" },
    ]);
    await signIn(platform, workspace);

    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      `Available Egma Projects:\n- Fixture project (${platform.projectId})\n- Westside (${OTHER_PROJECT_ID})\n`,
    );
    expect(result.stderr).toBe(
      "This credential does not identify one Project. Run egma init --project <Project ID>.\n",
    );
    expect(platform.records.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/projects",
    ]);
    expect(await isMissing(folderPathsIn(workspace.dir).config)).toBe(true);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("uses an explicit Project when an organization credential can see several", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    platform.suites.setListedProjects([
      { id: platform.projectId, name: "Fixture project" },
      { id: OTHER_PROJECT_ID, name: "Westside" },
    ]);
    await signIn(platform, workspace);

    const result = await egma(workspace, platform, ["--project", platform.projectId]);

    expect(result.code, result.stderr).toBe(0);
    expect((await readConfig(folderPathsIn(workspace.dir).config)).project).toEqual({
      id: platform.projectId,
      name: "Fixture project",
    });
    expect(platform.records.map((record) => record.path)).not.toContain("/v1/projects");
    expect(platform.records[0]?.path).toBe(`/v1/projects/${platform.projectId}`);
    expect(platform.records.map((record) => record.path)).not.toContain(
      "/v1/mock-tools",
    );

    const pulled = await run(process.execPath, [CLI_ENTRY, "pull"], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    expect(pulled.stderr).toBe("");
    expect(platform.records.map((record) => record.path)).not.toContain(
      "/v1/mock-tools",
    );
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("turns init into a pull when the repository names the same Project", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    await signIn(platform, workspace, platform.projectId);
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: platform.url },
        project: { id: platform.projectId, name: "Old project name" },
      },
    });
    const suite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });

    const result = await egma(workspace, platform);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `Refreshed ${folderPathsIn(await realpath(workspace.dir)).root} from Egma.`,
    );
    expect(result.stdout).not.toContain("Initialized Egma");
    expect(platform.records.map((record) => record.path)).not.toContain("/v1/projects");
    const repository = await readRepository(paths);
    expect(repository.config.project?.name).toBe("Fixture project");
    expect(repository.suites[0]?.manifest).toEqual({ id: suite.id, name: "Release" });
    expect(repository.suites[0]?.tests[0]?.test.name).toBe("Books a visit");
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("refuses a different Project before HTTP and preserves every local byte", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: platform.url },
        project: { id: platform.projectId, name: "Fixture project" },
      },
    });
    const sentinel = path.join(paths.tests, "keep-me.txt");
    await writeFile(sentinel, "keep me\n", "utf8");
    const beforeConfig = await readFile(paths.config, "utf8");
    const beforeSentinel = await readFile(sentinel, "utf8");
    await signIn(platform, workspace, OTHER_PROJECT_ID);

    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "This repository is already initialized for another Egma Project.\n\n" +
        "Move or delete egma/, then run egma init again.\n\n" +
        "Nothing was changed.\n",
    );
    expect(platform.records).toEqual([]);
    expect(await readFile(paths.config, "utf8")).toBe(beforeConfig);
    expect(await readFile(sentinel, "utf8")).toBe(beforeSentinel);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("refuses a missing config beside a platform-owned Suite before HTTP", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    await signIn(platform, workspace, platform.projectId);
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({ repository: workspace.dir, config: EMPTY_CONFIG });
    await rm(paths.config);
    const suiteDirectory = path.join(paths.tests, "release");
    await mkdir(suiteDirectory, { recursive: true });
    const manifest = serializeSuiteManifest({
      id: "ste_01K3XQ7M4E8YB2FVN0H9TZQWER",
      name: "Release",
    });
    const manifestPath = path.join(suiteDirectory, "suite.yaml");
    await writeFile(manifestPath, manifest, "utf8");

    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ste_01K3XQ7M4E8YB2FVN0H9TZQWER");
    expect(result.stderr).toContain(
      "To move this repository to another platform",
    );
    expect(result.stderr).toContain("Nothing was sent.");
    expect(platform.records).toEqual([]);
    expect(await isMissing(paths.config)).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("refuses an invalid existing config before HTTP and preserves its bytes", async () => {
  const [platform, workspace] = await Promise.all([startPlatform(), makeWorkspace()]);
  try {
    await signIn(platform, workspace, platform.projectId);
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({ repository: workspace.dir, config: EMPTY_CONFIG });
    const invalid = "format: definitely-not-a-number\n";
    await writeFile(paths.config, invalid, "utf8");

    const result = await egma(workspace, platform);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("platform binding in egma/config.yaml");
    expect(result.stderr).toContain("Egma did not fall back to its own platform.");
    expect(platform.records).toEqual([]);
    expect(await readFile(paths.config, "utf8")).toBe(invalid);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});
