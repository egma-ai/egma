/** Project-key creation and logout through the installed `egma` process. */

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { runProjectApiKeyCreateCommand } from "../src/commands/project-api-key.ts";
import {
  createEgmaFolder,
  EMPTY_CONFIG,
  folderPathsIn,
} from "../src/folder/egma-folder.ts";
import {
  readCredentials,
  writeCredentials,
} from "../src/platform/credentials.ts";
import { startPlatform, type MintedKey, type Platform } from "./support/fixture-platform/index.ts";
import { NOT_AUTHENTICATED } from "./support/fixture-platform/reading.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const execute = promisify(execFile);
const EGMA_KEY = "egma_sk_project-key-logout-acceptance";

type Result = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function egma(
  workspace: Workspace,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Result> {
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [CLI_ENTRY, ...args],
      { cwd: workspace.dir, env: workspace.env(env) },
    );
    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failed = cause as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      code: failed.code ?? 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

async function initialized(
  platform: Platform,
  workspace: Workspace,
): Promise<string> {
  platform.signedInWith(EGMA_KEY);
  await workspace.signIn(platform.url, EGMA_KEY);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: platform.projectId, name: "Fixture project" },
      agents: [],
    },
  });
  return await readFile(folderPathsIn(workspace.dir).config, "utf8");
}

async function createKey(
  platform: Platform,
  workspace: Workspace,
  name: string,
): Promise<{ readonly result: Result; readonly key: MintedKey }> {
  const result = await egma(workspace, [
    "project",
    "api-key",
    "create",
    "--name",
    name,
  ]);
  expect(result.code, result.stderr).toBe(0);
  const key = platform.keys.minted.at(-1);
  if (key === undefined) throw new Error("The fixture did not mint a key.");
  return { result, key };
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("creates a named Project key, prints its secret once, and saves it nowhere", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    const configBefore = await initialized(platform, workspace);
    const credentialsBefore = await readFile(workspace.credentialsFile, "utf8");
    const before = platform.records.length;

    const { result, key } = await createKey(platform, workspace, "Deploy key");

    expect(platform.records.slice(before).map((record) => `${record.method} ${record.path}`)).toEqual([
      "POST /v1/keys",
    ]);
    expect(platform.records.at(-1)?.body).toEqual({
      name: "Deploy key",
      projectId: platform.projectId,
    });
    expect(result.stdout).toContain(`Created Project API key Deploy key.`);
    expect(result.stdout).toContain(`Key ID: ${key.id}`);
    expect(count(result.stdout, key.secret)).toBe(1);
    expect(result.stderr).toBe("");
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).toBe(
      configBefore,
    );
    expect(await readFile(workspace.credentialsFile, "utf8")).toBe(
      credentialsBefore,
    );

    const files = await readdir(workspace.dir, { recursive: true });
    expect(files.some((file) => /(^|\/)\.env(?:\.|$)/u.test(file))).toBe(false);
    for (const file of files) {
      if (file.endsWith("config.yaml") || file.endsWith("credentials")) {
        expect(await readFile(`${workspace.dir}/${file}`, "utf8")).not.toContain(
          key.secret,
        );
      }
    }
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("prints a returned one-time Project key before an interrupted command exits 130", async () => {
  const workspace = await makeWorkspace();
  const controller = new AbortController();
  const out: string[] = [];
  const failed: string[] = [];
  const keyId = "key_interrupted_create";
  const secret = "egma_sk_copy_this_interrupted_key";
  try {
    await workspace.signIn("https://egma.example", EGMA_KEY);
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        ...EMPTY_CONFIG,
        platform: { origin: "https://egma.example" },
        project: { id: "prj_interrupted", name: "Interrupted project" },
      },
    });

    const code = await runProjectApiKeyCreateCommand({
      access: {
        url: "https://egma.example",
        credentialsFile: workspace.credentialsFile,
      },
      cwd: workspace.dir,
      name: "Deploy key",
      signal: controller.signal,
      out: (line) => out.push(line),
      fail: (line) => failed.push(line),
      fetchImpl: async () => {
        controller.abort("interrupt");
        return new Response(
          JSON.stringify({
            id: keyId,
            name: "Deploy key",
            projectId: "prj_interrupted",
            scope: "project",
            looksLike: "egma_sk_..._key",
            secret,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(code).toBe(130);
    expect(out).toContain("Created Project API key Deploy key.");
    expect(out).toContain(`Key ID: ${keyId}`);
    expect(count(out.join("\n"), secret)).toBe(1);
    expect(failed.join("\n")).toContain(
      "The command was interrupted after Egma created this Project API key.",
    );
    expect(failed.join("\n")).toContain("revoke it before you create another key");
  } finally {
    await workspace.remove();
  }
});

it("revokes exactly the saved login while an environment key only authorizes the request", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    const configBefore = await initialized(platform, workspace);
    const stored = (await createKey(platform, workspace, "Stored login")).key;
    const environment = (await createKey(platform, workspace, "Environment auth")).key;
    await writeCredentials(workspace.credentialsFile, {
      url: platform.url,
      key: stored.secret,
      login: { apiKeyId: stored.id, projectId: platform.projectId },
    });
    const before = platform.records.length;

    const result = await egma(
      workspace,
      ["logout", "--url", platform.url],
      { EGMA_API_KEY: environment.secret },
    );

    expect(result.code, result.stderr).toBe(0);
    const requests = platform.records.slice(before);
    expect(requests.map((record) => `${record.method} ${record.path}`)).toEqual([
      `POST /v1/keys/${stored.id}/revoke`,
    ]);
    expect(requests[0]?.headers.authorization).toBe(
      `Bearer ${environment.secret}`,
    );
    expect(stored.revokedAt).not.toBeNull();
    expect(environment.revokedAt).toBeNull();
    expect(await readCredentials(workspace.credentialsFile, platform.url)).toBeNull();
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(workspace.egmaFolder)).isDirectory()).toBe(true);
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).toBe(
      configBefore,
    );
    expect(result.stdout).toContain(`Revoked saved login key ${stored.id}.`);
    expect(result.stdout).not.toContain(stored.secret);
    expect(result.stdout).not.toContain(environment.secret);

    const stillWorks = await fetch(`${platform.url}/v1/keys`, {
      headers: { authorization: `Bearer ${environment.secret}` },
    });
    expect(stillWorks.status).toBe(200);
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});

it("keeps the saved login and repository when revocation is refused", async () => {
  const [platform, workspace] = await Promise.all([
    startPlatform(),
    makeWorkspace(),
  ]);
  try {
    const configBefore = await initialized(platform, workspace);
    const stored = (await createKey(platform, workspace, "Keep this login")).key;
    const held = {
      url: platform.url,
      key: stored.secret,
      login: { apiKeyId: stored.id, projectId: platform.projectId },
    } as const;
    await writeCredentials(workspace.credentialsFile, held);

    const result = await egma(
      workspace,
      ["logout", "--url", platform.url],
      { EGMA_API_KEY: "egma_sk_invalid_environment_key" },
    );

    expect(result.code).toBe(1);
    expect(result.stderr.split("\n")[0]).toBe(NOT_AUTHENTICATED.message);
    expect(result.stderr).toContain(
      "Egma did not accept the control-plane key, so the stored login was kept.",
    );
    expect(await readCredentials(workspace.credentialsFile, platform.url)).toEqual(
      held,
    );
    expect(await readFile(folderPathsIn(workspace.dir).config, "utf8")).toBe(
      configBefore,
    );
    expect(stored.revokedAt).toBeNull();
  } finally {
    await Promise.all([platform.close(), workspace.remove()]);
  }
});
