import { readFile, stat } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOGOUT_EXIT, runLogoutCommand } from "../src/commands/logout.ts";
import {
  readCredentials,
  writeCredentials,
} from "../src/platform/credentials.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://app.egma.example";

let workspace: Workspace;

beforeEach(async () => {
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await workspace.remove();
});

type Watched = {
  readonly out: string[];
  readonly failed: string[];
};

function watch(): Watched {
  return { out: [], failed: [] };
}

function successfulRevoke(
  requests: Request[],
  apiKeyId: string,
): typeof fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    return new Response(
      JSON.stringify({ id: apiKeyId, revokedAt: new Date().toISOString() }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

async function logout(
  watched: Watched,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<number> {
  return runLogoutCommand({
    access: { url: URL, credentialsFile: workspace.credentialsFile },
    env: options.env ?? workspace.env(),
    signal: new AbortController().signal,
    out: (line) => watched.out.push(line),
    fail: (line) => watched.failed.push(line),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

describe("egma logout", () => {
  it("revokes the stored login ID, uses the environment key for auth, and keeps other platforms", async () => {
    const apiKeyId = "key_device_login";
    await writeCredentials(workspace.credentialsFile, {
      url: "https://other.egma.example",
      key: "egma_sk_other",
    });
    await writeCredentials(workspace.credentialsFile, {
      url: URL,
      key: "egma_sk_stored_login",
      login: { apiKeyId, projectId: "prj_login" },
    });
    const requests: Request[] = [];
    const watched = watch();

    const code = await logout(watched, {
      env: workspace.env({ EGMA_API_KEY: "egma_sk_environment" }),
      fetchImpl: successfulRevoke(requests, apiKeyId),
    });

    expect(code).toBe(LOGOUT_EXIT.done);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${URL}/v1/keys/${apiKeyId}/revoke`);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer egma_sk_environment",
    );
    expect(await readCredentials(workspace.credentialsFile, URL)).toBeNull();
    expect(
      await readCredentials(workspace.credentialsFile, "https://other.egma.example"),
    ).toEqual({
      url: "https://other.egma.example",
      key: "egma_sk_other",
    });
    expect(watched.out).toContain(`Revoked saved login key ${apiKeyId}.`);
    expect(watched.out).toContain(
      "EGMA_API_KEY is still set for this process. Remove it from the shell or secret store to stop using it.",
    );
    expect(watched.out.join("\n")).not.toContain("status:");
  });

  it("removes the credentials file after the last login but leaves its folder", async () => {
    const apiKeyId = "key_only_login";
    await writeCredentials(workspace.credentialsFile, {
      url: URL,
      key: "egma_sk_only_login",
      login: { apiKeyId, projectId: "prj_login" },
    });
    const requests: Request[] = [];

    expect(
      await logout(watch(), {
        fetchImpl: successfulRevoke(requests, apiKeyId),
      }),
    ).toBe(LOGOUT_EXIT.done);
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(workspace.egmaFolder)).isDirectory()).toBe(true);
  });

  it("keeps the local login when the platform does not confirm revocation", async () => {
    const held = {
      url: URL,
      key: "egma_sk_must_stay",
      login: { apiKeyId: "key_must_stay", projectId: "prj_login" },
    } as const;
    await writeCredentials(workspace.credentialsFile, held);
    const watched = watch();

    const code = await logout(watched, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: "temporarily_unavailable", message: "try later" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    });

    expect(code).toBe(LOGOUT_EXIT.revokeFailed);
    expect(await readCredentials(workspace.credentialsFile, URL)).toEqual(held);
    expect(watched.out.join("\n")).not.toContain("status:");
    expect(watched.failed).toEqual(["try later"]);
  });

  it("never sends or removes an environment key when there is no stored login", async () => {
    let requests = 0;
    const watched = watch();

    const code = await logout(watched, {
      env: workspace.env({ EGMA_API_KEY: "egma_sk_environment_only" }),
      fetchImpl: async () => {
        requests += 1;
        throw new Error("logout must not call the platform");
      },
    });

    expect(code).toBe(LOGOUT_EXIT.done);
    expect(requests).toBe(0);
    expect(watched.out).toContain("There is no saved login to revoke.");
    expect(watched.out).toContain(
      "EGMA_API_KEY is still set for this process. Remove it from the shell or secret store to stop using it.",
    );
  });

  it("removes a legacy local entry without guessing a remote key ID", async () => {
    await workspace.signIn(URL, "egma_sk_legacy");
    let requests = 0;
    const watched = watch();

    const code = await logout(watched, {
      fetchImpl: async () => {
        requests += 1;
        throw new Error("a legacy key has no safe revoke target");
      },
    });

    expect(code).toBe(LOGOUT_EXIT.done);
    expect(requests).toBe(0);
    expect(await readCredentials(workspace.credentialsFile, URL)).toBeNull();
    expect(watched.out).toContain(
      "This login came from an older credentials file with no API key ID. Egma removed only its local record.",
    );
    expect((await stat(workspace.egmaFolder)).isDirectory()).toBe(true);
  });
});
