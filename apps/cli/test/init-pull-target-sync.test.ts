import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOLDER_EXIT } from "../src/commands/folder-verbs.ts";
import { runInitCommand } from "../src/commands/init.ts";
import { runPullCommand } from "../src/commands/pull.ts";
import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  readRepository,
} from "../src/folder/egma-folder.ts";
import { writeCredentials } from "../src/platform/credentials.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ONE = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const PROJECT_TWO = "prj_01K3XQ7M4E8YB2FVN0H9TZQWES";
const RETELL_AGENT = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const LIVEKIT_AGENT = "agt_01K3XQ7M4E8YB2FVN0H9TZQWES";
const FIRST_CONNECTION = "con_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SECOND_CONNECTION = "con_01K3XQ7M4E8YB2FVN0H9TZQWES";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";

type Project = { readonly id: string; readonly name: string };

type RemoteAgent = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly agentPlatform: "retell" | "livekit";
  readonly platformAgentId: string | null;
  readonly monitoringKeyPresent: boolean;
  readonly connections: readonly RemoteConnection[];
};

type RemoteConnection = {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly name: string;
  readonly agentPlatform: "retell" | "livekit";
  readonly connectionType: "retell_text_mode" | "livekit_room";
  readonly accessVariant:
    | "retell_text_mode.api_key"
    | "livekit_room.project_credentials";
  readonly modality: "chat" | "voice";
  readonly productLabel: string;
  readonly credentialsHint: string | null;
  readonly config: Readonly<Record<string, string>>;
};

type RemoteSuite = {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
};

type RemoteTest = {
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly name: string;
  readonly description: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly unknown[];
  readonly mockTools: readonly unknown[];
  readonly env: unknown;
  readonly versionId: string;
  readonly version: number;
  readonly revision: string;
};

class JsonResponse extends Response {
  constructor(value: unknown, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(JSON.stringify(value), { ...init, headers });
  }
}

function outputs() {
  const out: string[] = [];
  const fail: string[] = [];
  return {
    out,
    fail,
    say: (line: string) => out.push(line),
    complain: (line: string) => fail.push(line),
  };
}

function connection(
  id: string,
  name: string,
  platform: "retell" | "livekit",
): RemoteConnection {
  return platform === "retell"
    ? {
        id,
        projectId: PROJECT_ONE,
        agentId: RETELL_AGENT,
        name,
        agentPlatform: "retell",
        connectionType: "retell_text_mode",
        accessVariant: "retell_text_mode.api_key",
        modality: "chat",
        productLabel: "Retell text mode",
        credentialsHint: "...secret",
        config: { retellAgentId: "provider_agent_123" },
      }
    : {
        id,
        projectId: PROJECT_ONE,
        agentId: LIVEKIT_AGENT,
        name,
        agentPlatform: "livekit",
        connectionType: "livekit_room",
        accessVariant: "livekit_room.project_credentials",
        modality: "voice",
        productLabel: "LiveKit room",
        credentialsHint: "...secret",
        config: { url: "wss://example.livekit.cloud" },
      };
}

function agent(input: {
  readonly id: string;
  readonly name: string;
  readonly projectId?: string;
  readonly platform: "retell" | "livekit";
  readonly connections: readonly RemoteConnection[];
}): RemoteAgent {
  return {
    id: input.id,
    name: input.name,
    projectId: input.projectId ?? PROJECT_ONE,
    agentPlatform: input.platform,
    platformAgentId:
      input.platform === "retell" ? "provider_agent_123" : null,
    monitoringKeyPresent: input.platform === "retell",
    connections: input.connections,
  };
}

function remoteApi(input: {
  readonly projects?: readonly Project[];
  readonly agents?: readonly RemoteAgent[];
  readonly suites?: readonly RemoteSuite[];
  readonly tests?: readonly RemoteTest[];
}) {
  const projects = input.projects ?? [];
  const agents = input.agents ?? [];
  const suites = input.suites ?? [];
  const tests = input.tests ?? [];
  const requests: Request[] = [];

  const fetchImpl: typeof fetch = async (raw, init) => {
    const request = new Request(raw, init);
    requests.push(request);
    const requested = new globalThis.URL(request.url);

    if (request.method === "GET" && requested.pathname === "/v1/projects") {
      return new JsonResponse({ projects, mayManageProjects: false });
    }
    if (
      request.method === "GET" &&
      requested.pathname.startsWith("/v1/projects/")
    ) {
      const id = decodeURIComponent(requested.pathname.slice("/v1/projects/".length));
      const project = projects.find((one) => one.id === id);
      return project === undefined
        ? new JsonResponse({ message: "not found" }, { status: 404 })
        : new JsonResponse(project);
    }
    if (request.method === "GET" && requested.pathname === "/v1/agents") {
      return new JsonResponse({ agents, nextPageToken: null });
    }
    if (request.method === "GET" && requested.pathname === "/v1/test-suites") {
      return new JsonResponse({ testSuites: suites, nextPageToken: null });
    }
    if (request.method === "GET" && requested.pathname === "/v1/tests") {
      const suiteId = requested.searchParams.get("suiteId");
      return new JsonResponse({
        tests: tests.filter((test) => test.suiteId === suiteId),
        nextPageToken: null,
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  return { fetchImpl, requests };
}

function commandOptions(workspace: Workspace, io: ReturnType<typeof outputs>) {
  return {
    access: { url: URL, credentialsFile: workspace.credentialsFile },
    cwd: workspace.dir,
    binding: { origin: URL },
    out: io.say,
    fail: io.complain,
  } as const;
}

async function signInFromLogin(
  workspace: Workspace,
  projectId: string,
): Promise<void> {
  await writeCredentials(workspace.credentialsFile, {
    url: URL,
    key: "egma_sk_device_login",
    login: { apiKeyId: "key_device_login", projectId },
  });
}

const PROJECT = { id: PROJECT_ONE, name: "Northside" } as const;
const RELEASE = { id: SUITE_ID, projectId: PROJECT_ONE, name: "Release" } as const;
const BOOKS_A_VISIT = {
  id: TEST_ID,
  projectId: PROJECT_ONE,
  suiteId: SUITE_ID,
  name: "Books a visit",
  description: "",
  scenario: "The caller asks for Tuesday.",
  expectedBehaviors: ["The agent books Tuesday."],
  personas: [],
  mockTools: [{ tool: "calendar", answer: { slots: [] } }],
  env: { retell_dynamic_variables: { caller_name: "Margaret" } },
  versionId: VERSION_ID,
  version: 1,
  revision: REVISION,
} as const;

let workspace: Workspace;

beforeEach(async () => {
  vi.stubEnv("EGMA_API_KEY", "");
  workspace = await makeWorkspace();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await workspace.remove();
});

describe("skills-first init and pull", () => {
  it("requires authentication before it creates an egma folder", async () => {
    const io = outputs();
    let requests = 0;

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: async () => {
        requests += 1;
        return new JsonResponse({});
      },
    });

    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.fail.join("\n")).toContain("egma login");
    await expect(stat(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stops on an invalid existing config and leaves it unchanged", async () => {
    await signInFromLogin(workspace, PROJECT_ONE);
    const paths = folderPathsIn(workspace.dir);
    await createEgmaFolder({
      repository: workspace.dir,
      config: EMPTY_CONFIG,
    });
    await writeFile(paths.config, "format: definitely-not-a-number\n", "utf8");
    const before = await readFile(paths.config, "utf8");
    const io = outputs();
    let requests = 0;

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: async () => {
        requests += 1;
        return new JsonResponse({});
      },
    });

    expect(code).toBe(FOLDER_EXIT.nothing);
    expect(requests).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.fail.join("\n")).toContain("egma/config.yaml");
    expect(io.fail.join("\n")).toContain("Nothing was changed.");
    expect(await readFile(paths.config, "utf8")).toBe(before);
  });

  it("uses the device-login Project and pulls targets, suites, and tests", async () => {
    await signInFromLogin(workspace, PROJECT_ONE);
    const remoteAgent = agent({
      id: RETELL_AGENT,
      name: "Receptionist",
      platform: "retell",
      connections: [connection(FIRST_CONNECTION, "Text", "retell")],
    });
    const api = remoteApi({
      projects: [PROJECT],
      agents: [remoteAgent],
      suites: [RELEASE],
      tests: [BOOKS_A_VISIT],
    });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect(api.requests.every((request) => request.method === "GET")).toBe(true);
    expect(
      api.requests.map((request) => new globalThis.URL(request.url).pathname),
    ).not.toContain("/v1/projects");
    const config = await readConfig(folderPathsIn(workspace.dir).config);
    expect(config).toEqual({
      format: 4,
      platform: { origin: URL },
      project: PROJECT,
      agents: [
        {
          id: RETELL_AGENT,
          name: "Receptionist",
          platform: "retell",
          connections: [{ id: FIRST_CONNECTION, name: "Text" }],
        },
      ],
    });
    const repository = await readRepository(folderPathsIn(workspace.dir));
    expect(repository.suites).toHaveLength(1);
    expect(repository.suites[0]?.manifest).toEqual({
      id: SUITE_ID,
      name: "Release",
    });
    expect(repository.suites[0]?.tests[0]?.test.name).toBe("Books a visit");
    expect(io.out).toContain(`Initialized Egma in ${folderPathsIn(workspace.dir).root}.`);
    expect(io.out).toContain("Agents: 1");
    expect(io.out).toContain("Suites: 1");
    expect(io.out).toContain("Tests: 1");
    expect(io.out.join("\n")).not.toContain("status:");
  });

  it("uses an explicit Project when stored authentication has no Project", async () => {
    await workspace.signIn(URL, "egma_sk_organization");
    const selected = { id: PROJECT_TWO, name: "Westside" } as const;
    const api = remoteApi({ projects: [selected] });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      projectId: PROJECT_TWO,
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect((await readConfig(folderPathsIn(workspace.dir).config)).project).toEqual(
      selected,
    );
    expect(
      api.requests.map((request) => new globalThis.URL(request.url).pathname),
    ).not.toContain("/v1/projects");
    expect(io.out).toContain(`Initialized Egma in ${folderPathsIn(workspace.dir).root}.`);
  });

  it("uses the only Project when stored authentication has no Project", async () => {
    await workspace.signIn(URL, "egma_sk_organization");
    const api = remoteApi({ projects: [PROJECT] });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect(
      api.requests.map((request) => new globalThis.URL(request.url).pathname),
    ).toEqual([
      "/v1/projects",
      `/v1/projects/${PROJECT_ONE}`,
      "/v1/agents",
      "/v1/test-suites",
    ]);
    expect((await readConfig(folderPathsIn(workspace.dir).config)).project).toEqual(
      PROJECT,
    );
    expect(io.out).not.toContain("Available Egma Projects:");
    expect(io.out).toContain(`Initialized Egma in ${folderPathsIn(workspace.dir).root}.`);
  });

  it("reports an account with no Project and creates nothing", async () => {
    await workspace.signIn(URL, "egma_sk_organization");
    const api = remoteApi({ projects: [] });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(1);
    expect(
      api.requests.map((request) => new globalThis.URL(request.url).pathname),
    ).toEqual(["/v1/projects"]);
    expect(io.out).toEqual([]);
    expect(io.fail).toEqual([
      "This Egma account has no Project. Create a Project in Egma, then run egma init again. Nothing was changed.",
    ]);
    await expect(stat(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("binds and pulls an existing empty format-4 config", async () => {
    await signInFromLogin(workspace, PROJECT_ONE);
    await createEgmaFolder({
      repository: workspace.dir,
      config: EMPTY_CONFIG,
    });
    const api = remoteApi({ projects: [PROJECT] });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect(await readConfig(folderPathsIn(workspace.dir).config)).toEqual({
      format: 4,
      platform: { origin: URL },
      project: PROJECT,
      agents: [],
    });
    expect(io.out).toContain(
      `Refreshed ${folderPathsIn(workspace.dir).root} from Egma.`,
    );
  });

  it("does not let --project override the device-login Project", async () => {
    await signInFromLogin(workspace, PROJECT_ONE);
    const api = remoteApi({
      projects: [PROJECT, { id: PROJECT_TWO, name: "Westside" }],
    });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      projectId: PROJECT_TWO,
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.nothing);
    expect(api.requests).toHaveLength(0);
    await expect(stat(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("lists Project options when authentication does not identify one", async () => {
    await workspace.signIn(URL, "egma_sk_organization");
    const projects = [
      PROJECT,
      { id: PROJECT_TWO, name: "Westside" },
    ] as const;
    const api = remoteApi({ projects });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.nothing);
    expect(
      api.requests.map((request) => new globalThis.URL(request.url).pathname),
    ).toEqual(["/v1/projects"]);
    expect(io.out).toEqual([
      "Available Egma Projects:",
      `- Northside (${PROJECT_ONE})`,
      `- Westside (${PROJECT_TWO})`,
    ]);
    expect(io.fail).toEqual([
      "This credential does not identify one Project. Run egma init --project <Project ID>.",
    ]);
    await expect(stat(folderPathsIn(workspace.dir).config)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("turns init into a pull when the repository names the same Project", async () => {
    await signInFromLogin(workspace, PROJECT_ONE);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: URL },
        project: { id: PROJECT_ONE, name: "Old name" },
        agents: [
          {
            id: RETELL_AGENT,
            name: "Old Agent name",
            platform: "retell",
            connections: [],
          },
        ],
      },
    });
    const api = remoteApi({
      projects: [PROJECT],
      agents: [
        agent({
          id: RETELL_AGENT,
          name: "Receptionist",
          platform: "retell",
          connections: [connection(FIRST_CONNECTION, "Text", "retell")],
        }),
      ],
      suites: [RELEASE],
      tests: [BOOKS_A_VISIT],
    });
    const io = outputs();

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect((await readConfig(folderPathsIn(workspace.dir).config)).project).toEqual(
      PROJECT,
    );
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents[0]).toEqual({
      id: RETELL_AGENT,
      name: "Receptionist",
      platform: "retell",
      connections: [{ id: FIRST_CONNECTION, name: "Text" }],
    });
    // The test's own world comes down with it: init pulls both sections into
    // the one file, and there is no second file for either.
    const pulled = (await readRepository(folderPathsIn(workspace.dir))).suites[0]
      ?.tests[0]?.test;
    expect(pulled?.name).toBe("Books a visit");
    expect(pulled?.mockTools).toEqual([{ tool: "calendar", answer: { slots: [] } }]);
    expect(pulled?.env).toEqual({ retell_dynamic_variables: { caller_name: "Margaret" } });
    // Nothing project-wide is written beside the tests: a test carries its own
    // world, so there is no second file for a reader to wonder about.
    expect((await readdir(folderPathsIn(workspace.dir).root)).sort()).toEqual([
      "config.yaml",
      "tests",
    ]);
    expect(io.out).toContain(
      `Refreshed ${folderPathsIn(workspace.dir).root} from Egma.`,
    );
    expect(io.out).toContain("Agents: 1");
    expect(io.out).toContain("Suites: 1");
    expect(io.out.at(-1)).toBe("Tests: 1");
    expect(io.out.join("\n")).not.toContain("status:");
  });

  it("refuses a different Project exactly and changes nothing", async () => {
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: URL },
        project: PROJECT,
      },
    });
    const paths = folderPathsIn(workspace.dir);
    const sentinel = path.join(paths.tests, "keep-me.txt");
    await writeFile(sentinel, "keep me\n", "utf8");
    const before = await readFile(paths.config, "utf8");
    await signInFromLogin(workspace, PROJECT_TWO);
    const io = outputs();
    let requests = 0;

    const code = await runInitCommand({
      ...commandOptions(workspace, io),
      fetchImpl: async () => {
        requests += 1;
        return new JsonResponse({});
      },
    });

    expect(code).toBe(FOLDER_EXIT.nothing);
    expect(requests).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.fail).toEqual([
      [
        "This repository is already initialized for another Egma Project.",
        "",
        "Move or delete egma/, then run egma init again.",
        "",
        "Nothing was changed.",
      ].join("\n"),
    ]);
    expect(await readFile(paths.config, "utf8")).toBe(before);
    expect(await readFile(sentinel, "utf8")).toBe("keep me\n");
  });

  it("pull refreshes a sorted, minimal Agent and Connection index", async () => {
    await workspace.signIn(URL);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: URL },
        project: PROJECT,
        agents: [
          {
            id: RETELL_AGENT,
            name: "Stale",
            platform: "retell",
            connections: [],
          },
        ],
      },
    });
    const api = remoteApi({
      projects: [PROJECT],
      agents: [
        agent({
          id: LIVEKIT_AGENT,
          name: "LiveKit support",
          platform: "livekit",
          connections: [
            connection(SECOND_CONNECTION, "Voice", "livekit"),
            connection(FIRST_CONNECTION, "Chat", "livekit"),
          ],
        }),
        agent({
          id: RETELL_AGENT,
          name: "Receptionist",
          platform: "retell",
          connections: [],
        }),
      ],
    });
    const io = outputs();

    const code = await runPullCommand({
      access: { url: URL, credentialsFile: workspace.credentialsFile },
      cwd: workspace.dir,
      out: io.say,
      fail: io.complain,
      fetchImpl: api.fetchImpl,
    });

    expect(code).toBe(FOLDER_EXIT.done);
    expect((await readConfig(folderPathsIn(workspace.dir).config)).agents).toEqual([
      {
        id: RETELL_AGENT,
        name: "Receptionist",
        platform: "retell",
        connections: [],
      },
      {
        id: LIVEKIT_AGENT,
        name: "LiveKit support",
        platform: "livekit",
        connections: [
          { id: FIRST_CONNECTION, name: "Chat" },
          { id: SECOND_CONNECTION, name: "Voice" },
        ],
      },
    ]);
    const written = await readFile(folderPathsIn(workspace.dir).config, "utf8");
    for (const forbidden of [
      "platformAgentId",
      "accessVariant",
      "modality",
      "credentials",
      "credentialsHint",
      "config:",
      "provider_agent_123",
      "wss://example.livekit.cloud",
    ]) {
      expect(written).not.toContain(forbidden);
    }
    expect(io.out.at(-1)).toBe(
      "Pull complete: 0 suites, 0 tests, and 2 Agents.",
    );
    expect(io.out.join("\n")).not.toContain("status:");
  });

});
