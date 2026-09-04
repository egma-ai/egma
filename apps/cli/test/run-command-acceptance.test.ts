/** Built-process proof for Run creation ordering and explicit cancellation. */

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
  readRepository,
} from "../src/folder/egma-folder.ts";
import { pullRepository } from "../src/sync/pull.ts";
import {
  startPlatform,
  type Platform,
} from "./support/fixture-platform/index.ts";
import {
  CLI_ENTRY,
  makeWorkspace,
  type Workspace,
} from "./support/workspace.ts";

const KEY = "egma_sk_run-command-acceptance";
const run = promisify(execFile);

type Result = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

type PreparedRunRepository = {
  readonly platform: Platform;
  readonly workspace: Workspace;
  readonly agentId: string;
  readonly connectionId: string;
  readonly suiteDirectory: string;
};

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function egma(
  workspace: Workspace,
  args: readonly string[],
): Promise<Result> {
  try {
    const answer = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(),
    });
    return { ...answer, code: 0 };
  } catch (cause) {
    const failed = cause as {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      code: failed.code ?? 1,
    };
  }
}

async function prepareRunRepository(): Promise<PreparedRunRepository> {
  const platform = await startPlatform();
  const workspace = await makeWorkspace();
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
        agentPlatform: "retell",
        connection: {
          name: "Fixture chat",
          agentPlatform: "retell",
          connectionType: "retell_chat_api",
          accessVariant: "retell_chat_api.api_key",
          modality: "chat",
          config: { retellAgentId: "run-command-agent" },
          credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
        },
      }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as {
      readonly agent: {
        readonly id: string;
        readonly projectId: string;
        readonly name: string;
      };
      readonly connection: { readonly id: string; readonly name: string };
    };

    const suite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: suite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: platform.url },
        project: { id: registered.agent.projectId, name: "Fixture project" },
        agents: [
          {
            id: registered.agent.id,
            name: registered.agent.name,
            platform: "retell",
            connections: [
              {
                id: registered.connection.id,
                name: registered.connection.name,
              },
            ],
          },
        ],
      },
    });
    await pullRepository({
      signedIn: { url: platform.url, key: KEY },
      paths: folderPathsIn(workspace.dir),
    });
    const repository = await readRepository(folderPathsIn(workspace.dir));
    const localSuite = repository.suites.find(
      (candidate) => candidate.manifest.id === suite.id,
    );
    if (localSuite === undefined) {
      throw new Error("the prepared Run repository has no local Suite");
    }

    return {
      platform,
      workspace,
      agentId: registered.agent.id,
      connectionId: registered.connection.id,
      suiteDirectory: localSuite.directory,
    };
  } catch (cause) {
    await Promise.all([platform.close(), workspace.remove()]);
    throw cause;
  }
}

async function closePrepared(prepared: PreparedRunRepository): Promise<void> {
  await Promise.all([prepared.platform.close(), prepared.workspace.remove()]);
}

describe("built Run commands", () => {
  it("creates no Run when the automatic push is refused", async () => {
    const prepared = await prepareRunRepository();
    try {
      prepared.platform.tests.editInDashboard("Books a visit", {
        scenario: "The server changed after the repository pulled.",
      });
      const before = prepared.platform.records.length;

      const result = await egma(prepared.workspace, [
        "run",
        "create",
        prepared.suiteDirectory,
        "--agent",
        prepared.agentId,
        "--connection",
        prepared.connectionId,
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("a test has a newer version");
      expect(result.stderr).toContain("No Run was created.");
      const writes = prepared.platform.records
        .slice(before)
        .filter((record) => record.method !== "GET");
      expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "POST /v1/repository/change-set",
      ]);
      expect(
        prepared.platform.records
          .slice(before)
          .filter((record) => record.method === "POST" && record.path === "/v1/runs"),
      ).toHaveLength(0);
      expect(prepared.platform.running.runs).toHaveLength(0);
    } finally {
      await closePrepared(prepared);
    }
  });

  it("cancels one created Run through the exact public endpoint", async () => {
    const prepared = await prepareRunRepository();
    try {
      const beforeCreate = prepared.platform.records.length;
      const created = await egma(prepared.workspace, [
        "run",
        "create",
        prepared.suiteDirectory,
        "--agent",
        prepared.agentId,
        "--connection",
        prepared.connectionId,
      ]);
      expect(created.code, created.stderr).toBe(0);
      const createRequest = prepared.platform.records
        .slice(beforeCreate)
        .find(
          (record) =>
            record.method === "POST" && record.path === "/v1/runs",
        );
      expect(createRequest?.query).toBe(
        `?projectId=${prepared.platform.projectId}`,
      );
      const runId = prepared.platform.running.runs[0]?.id;
      expect(runId).toMatch(/^run_/u);
      const before = prepared.platform.records.length;

      const canceled = await egma(prepared.workspace, ["run", "cancel", runId!]);

      expect(canceled).toEqual({
        code: 0,
        stdout: `Canceled Run ${runId}.\n`,
        stderr: "",
      });
      expect(prepared.platform.running.runs).toEqual([
        expect.objectContaining({ id: runId, status: "canceled" }),
      ]);
      expect(
        prepared.platform.records.slice(before).map(({ method, path, query, status, body }) => ({
          method,
          path,
          query,
          status,
          body,
        })),
      ).toEqual([
        {
          method: "POST",
          path: `/v1/runs/${runId}/cancel`,
          query: `?projectId=${prepared.platform.projectId}`,
          status: 200,
          body: null,
        },
      ]);
    } finally {
      await closePrepared(prepared);
    }
  });

  it("relays an exact remote refusal when the named Run does not exist", async () => {
    const prepared = await prepareRunRepository();
    try {
      const runId = "run_01K3XQ7M4E8YB2FVN0H9TZQWER";
      const before = prepared.platform.records.length;

      const result = await egma(prepared.workspace, ["run", "cancel", runId]);

      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "no run of yours has that id\n" +
          `Egma has no Run ${runId} in this Project. Nothing was changed.\n`,
      });
      expect(
        prepared.platform.records.slice(before).map(({ method, path, query, status, body }) => ({
          method,
          path,
          query,
          status,
          body,
        })),
      ).toEqual([
        {
          method: "POST",
          path: `/v1/runs/${runId}/cancel`,
          query: `?projectId=${prepared.platform.projectId}`,
          status: 404,
          body: null,
        },
      ]);
    } finally {
      await closePrepared(prepared);
    }
  });

  it("does not report success when Run creation returns an incomplete receipt", async () => {
    const prepared = await prepareRunRepository();
    try {
      prepared.platform.running.answerNextStartWith({});

      const result = await egma(prepared.workspace, [
        "run",
        "create",
        prepared.suiteDirectory,
        "--agent",
        prepared.agentId,
        "--connection",
        prepared.connectionId,
      ]);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("Started Run");
      expect(result.stderr).toContain(
        "Egma answered without confirming the Run it created.",
      );
      expect(prepared.platform.running.runs).toHaveLength(1);
    } finally {
      await closePrepared(prepared);
    }
  });

  it("does not report success when Run cancellation returns the wrong receipt", async () => {
    const prepared = await prepareRunRepository();
    try {
      const created = await egma(prepared.workspace, [
        "run",
        "create",
        prepared.suiteDirectory,
        "--agent",
        prepared.agentId,
        "--connection",
        prepared.connectionId,
      ]);
      expect(created.code, created.stderr).toBe(0);
      const runId = prepared.platform.running.runs[0]?.id ?? "";
      prepared.platform.running.answerNextCancelWith({
        id: "run_someone_else",
        status: "canceled",
      });

      const result = await egma(prepared.workspace, ["run", "cancel", runId]);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("Canceled Run");
      expect(result.stderr).toContain(
        `Egma answered without confirming that it canceled Run ${runId}.`,
      );
      expect(prepared.platform.running.runs[0]?.status).toBe("canceled");
    } finally {
      await closePrepared(prepared);
    }
  });
});
