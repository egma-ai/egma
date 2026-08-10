import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEgmaFolder } from "../src/folder/egma-folder.ts";
import {
  BoundPlatformUnavailableError,
  DEFAULT_PLATFORM_URL,
  PlatformBindingMismatchError,
  resolvePlatformAccess,
} from "../src/platform/credentials.ts";
import { readPlatformIdentity } from "../src/platform/identity.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

describe("verifying an Egma platform", () => {
  let platform: Platform;
  let workspace: Workspace;

  beforeEach(async () => {
    platform = await startPlatform();
    workspace = await makeWorkspace();
  });

  afterEach(async () => {
    await platform.close();
    await workspace.remove();
  });

  it("reads the stable instance identity and normalized canonical origin before login", async () => {
    expect(await readPlatformIdentity(`${platform.url}/`)).toEqual({
      instanceId: platform.instanceId,
      origin: platform.url,
    });

    expect(platform.records.map((record) => `${record.method} ${record.path}`)).toEqual([
      "GET /api/platform",
    ]);
  });

  it("uses the repository binding when no flag or environment URL is present", async () => {
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: { origin: platform.url, instance: platform.instanceId },
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: null,
      },
    });

    await workspace.signIn("https://a-recent-login-must-not-win.example");
    const access = await resolvePlatformAccess({
      env: workspace.env(),
      flag: null,
      cwd: workspace.dir,
    });

    expect(access).toMatchObject({
      url: platform.url,
      instanceId: platform.instanceId,
    });
  });

  it("refuses a different explicit platform before any repository identifier is sent", async () => {
    const other = await startPlatform();
    try {
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: platform.url, instance: platform.instanceId },
          agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
          connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
          suite: null,
        },
      });

      await expect(
        resolvePlatformAccess({
          env: workspace.env(),
          flag: other.url,
          cwd: workspace.dir,
        }),
      ).rejects.toBeInstanceOf(PlatformBindingMismatchError);

      expect(other.records.map((record) => `${record.method} ${record.path}`)).toEqual([
        "GET /api/platform",
      ]);
      expect(platform.records).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it("takes the explicit URL before EGMA_URL, then verifies the selected instance", async () => {
    const ambient = await startPlatform();
    try {
      const access = await resolvePlatformAccess({
        env: workspace.env({ EGMA_URL: ambient.url }),
        flag: platform.url,
        cwd: workspace.dir,
      });

      expect(access.url).toBe(platform.url);
      expect(platform.records.map((record) => record.path)).toEqual(["/api/platform"]);
      expect(ambient.records).toEqual([]);
    } finally {
      await ambient.close();
    }
  });

  it("uses Egma Cloud only when the repository is unbound", async () => {
    const requested: string[] = [];
    const access = await resolvePlatformAccess({
      env: workspace.env(),
      flag: null,
      cwd: workspace.dir,
      fetchImpl: async (input) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            instance_id: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
            origin: DEFAULT_PLATFORM_URL,
          }),
          { status: 200 },
        );
      },
    });

    expect(access.url).toBe(DEFAULT_PLATFORM_URL);
    expect(requested).toEqual([`${DEFAULT_PLATFORM_URL}/api/platform`]);
  });

  it("refuses an unavailable bound platform and does not try Egma Cloud", async () => {
    const boundOrigin = "http://127.0.0.1:1";
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: boundOrigin,
          instance: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
        },
        agent: null,
        connection: null,
        suite: null,
      },
    });
    const requested: string[] = [];

    const resolution = resolvePlatformAccess({
      env: workspace.env(),
      flag: null,
      cwd: workspace.dir,
      fetchImpl: async (input) => {
        requested.push(String(input));
        throw new Error("offline");
      },
    });

    await expect(resolution).rejects.toBeInstanceOf(BoundPlatformUnavailableError);
    await expect(resolution).rejects.toThrow("Egma Cloud was not used");
    expect(requested).toEqual([`${boundOrigin}/api/platform`]);
  });
});
