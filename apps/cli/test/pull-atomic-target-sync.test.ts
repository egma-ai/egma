import { copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  type FolderConfig,
} from "../src/folder/egma-folder.ts";
import { pullRepository } from "../src/sync/pull.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const OLD_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWER";
const NEW_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWES";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";
const MOCK_TOOL_ID = "mck_01K3XQ7M4E8YB2FVN0H9TZQWER";
const NOW = "2026-09-03T00:00:00.000Z";

const PROJECT = { id: PROJECT_ID, name: "Northside" } as const;

const OLD_CONFIG: FolderConfig = {
  ...EMPTY_CONFIG,
  platform: { origin: URL },
  project: PROJECT,
  agents: [
    {
      id: AGENT_ID,
      name: "Old receptionist name",
      platform: "retell",
      connections: [{ id: OLD_CONNECTION_ID, name: "Old text connection" }],
    },
  ],
};

const REFRESHED_CONFIG: FolderConfig = {
  ...OLD_CONFIG,
  agents: [
    {
      id: AGENT_ID,
      name: "Receptionist",
      platform: "retell",
      connections: [{ id: NEW_CONNECTION_ID, name: "Chat" }],
    },
  ],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function remoteRepository(): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const requested = new globalThis.URL(request.url);

    if (request.method === "GET" && requested.pathname === "/v1/test-suites") {
      return json({
        testSuites: [
          {
            id: SUITE_ID,
            projectId: PROJECT_ID,
            name: "Release",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextPageToken: null,
      });
    }
    if (request.method === "GET" && requested.pathname === "/v1/tests") {
      return json({
        tests: [
          {
            id: TEST_ID,
            projectId: PROJECT_ID,
            suiteId: SUITE_ID,
            name: "Books a visit",
            description: null,
            version: 1,
            versionId: VERSION_ID,
            scenario: "The caller asks for Tuesday.",
            expectedBehaviors: ["The agent books Tuesday."],
            personas: [],
            mockTools: [],
            overrideCount: 0,
            revision: REVISION,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        nextPageToken: null,
      });
    }
    if (request.method === "GET" && requested.pathname === "/v1/mock-tools") {
      return json({
        mockTools: [
          {
            id: MOCK_TOOL_ID,
            tool: "calendar",
            delayMs: 0,
            agents: [],
            createdAt: NOW,
            updatedAt: NOW,
            answer: { open: true },
          },
        ],
        nextPageToken: null,
      });
    }

    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
  await createEgmaFolder({ repository: workspace.dir, config: OLD_CONFIG });
});

afterEach(async () => workspace.remove());

describe("atomic pull target refresh", () => {
  it("applies targets, suites, tests, and Mock Tools from one staged transaction", async () => {
    const paths = folderPathsIn(workspace.dir);
    const applied: { readonly staged: string; readonly destination: string }[] = [];

    await pullRepository({
      signedIn: { url: URL, key: "egma_sk_pull" },
      paths,
      config: REFRESHED_CONFIG,
      fetchImpl: remoteRepository(),
      applyStagedFile: async (staged, destination) => {
        applied.push({ staged, destination });
        await copyFile(staged, destination);
      },
    });

    const release = path.join(paths.tests, "release");
    expect(applied.map(({ destination }) => destination)).toEqual([
      path.join(release, "suite.yaml"),
      path.join(release, "books-a-visit.md"),
      paths.mockTools,
      paths.config,
    ]);
    expect(new Set(applied.map(({ staged }) => path.dirname(staged)))).toHaveLength(1);
    expect(applied.at(-1)?.destination).toBe(paths.config);
    expect((await readConfig(paths.config)).agents).toEqual(REFRESHED_CONFIG.agents);
    expect(await readFile(path.join(release, "suite.yaml"), "utf8")).toContain(
      "name: Release",
    );
    expect(await readFile(path.join(release, "books-a-visit.md"), "utf8")).toContain(
      "name: Books a visit",
    );
    expect(await readFile(paths.mockTools, "utf8")).toContain("### calendar");
  });

  it("restores the old config and every earlier write when the final apply fails", async () => {
    const paths = folderPathsIn(workspace.dir);
    const oldConfig = await readFile(paths.config, "utf8");
    const oldMockTools = await readFile(paths.mockTools, "utf8");
    const applied: string[] = [];

    await expect(
      pullRepository({
        signedIn: { url: URL, key: "egma_sk_pull" },
        paths,
        config: REFRESHED_CONFIG,
        fetchImpl: remoteRepository(),
        applyStagedFile: async (staged, destination) => {
          applied.push(destination);
          await copyFile(staged, destination);
          if (destination === paths.config) throw new Error("disk stopped");
        },
      }),
    ).rejects.toThrow("disk stopped");

    expect(applied.at(-1)).toBe(paths.config);
    expect(await readFile(paths.config, "utf8")).toBe(oldConfig);
    expect(await readFile(paths.mockTools, "utf8")).toBe(oldMockTools);
    await expect(stat(path.join(paths.tests, "release"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
