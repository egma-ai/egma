import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEgmaFolder } from "../src/folder/egma-folder.ts";
import {
  BoundPlatformAddressError,
  BoundPlatformUnavailableError,
  DEFAULT_PLATFORM_URL,
  DefaultPlatformUnusableError,
  PlatformBindingMismatchError,
  resolvePlatformAccess,
} from "../src/platform/credentials.ts";
import {
  PlatformOriginMismatchError,
  PlatformTimedOutError,
  readPlatformIdentity,
} from "../src/platform/identity.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

/** The refusal a promise ended with, or a failure saying it did not refuse. */
async function refusalFrom(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error("that was supposed to be refused, and it was not");
}

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

  it("refuses a different explicit address before asking anybody anything", async () => {
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
      ).rejects.toBeInstanceOf(BoundPlatformAddressError);

      // Neither platform was asked so much as who it is. The address a bound
      // repository uses is decided by the file, so an address that is not the
      // one in the file is refused without anything leaving this machine.
      expect(other.records).toEqual([]);
      expect(platform.records).toEqual([]);
    } finally {
      await other.close();
    }
  });

  /**
   * The one thing an origin alone cannot tell you, and the reason the instance
   * identifier is committed beside it: the platform at this address is not the
   * platform that issued these identifiers. A colleague who rebuilt the local
   * stack has a new database and therefore a new instance, at the very same
   * address the repository recorded.
   */
  it("refuses a replaced platform answering at the address the repository recorded", async () => {
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: platform.url,
          instance: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
        },
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: null,
      },
    });

    await expect(
      resolvePlatformAccess({ env: workspace.env(), flag: null, cwd: workspace.dir }),
    ).rejects.toBeInstanceOf(PlatformBindingMismatchError);

    // One question asked, and it was the public one that carries nothing.
    expect(platform.records.map((record) => `${record.method} ${record.path}`)).toEqual([
      "GET /api/platform",
    ]);
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

  /**
   * The failure this refusal exists for is quiet and expensive.
   *
   * `EGMA_BASE_URL` defaults to `http://localhost:3101`. A self-hoster who
   * never changes it and reaches the stack at `192.168.1.10` gets a clean
   * identity read — and, if the platform's answer were believed, a CLI that
   * walks away to `localhost`, where nothing is listening. Bind on the
   * platform's own host and it is worse: the committed file says `localhost`,
   * and every teammate who clones it targets their own machine.
   *
   * So the address the developer gave is the address egma uses, and a platform
   * that calls itself something else is a misconfiguration to be told about.
   */
  it("refuses a platform that answers to a different address than it was asked at", async () => {
    const canonicalOrigin = "https://canonical.egma.example";
    const alias = await startPlatform({ canonicalOrigin });
    try {
      await expect(readPlatformIdentity(alias.url)).rejects.toBeInstanceOf(
        PlatformOriginMismatchError,
      );
      await expect(readPlatformIdentity(alias.url)).rejects.toThrow(canonicalOrigin);
      await expect(readPlatformIdentity(alias.url)).rejects.toThrow("EGMA_BASE_URL");

      await expect(
        resolvePlatformAccess({
          env: workspace.env(),
          flag: alias.url,
          cwd: workspace.dir,
        }),
      ).rejects.toBeInstanceOf(PlatformOriginMismatchError);
    } finally {
      await alias.close();
    }
  });

  /**
   * The same refusal, told two ways, because the two situations want different
   * things done about them.
   *
   * `localhost` against `127.0.0.1` is one machine calling itself two names,
   * and either name reaches it — so saying "or use the other one" is help. A
   * platform on the network that still calls itself `localhost` is the failure
   * this refusal exists for, and telling somebody on another machine to use
   * `localhost` sends them to their own laptop, where nothing is listening.
   */
  it("does not offer a loopback address to somebody who is not on that machine", async () => {
    const onlyItsOwnMachine = await startPlatform({
      canonicalOrigin: "http://localhost:3101",
    });
    try {
      // Reached across a network, so its own name for itself is no use here.
      await expect(
        readPlatformIdentity(onlyItsOwnMachine.url.replace("127.0.0.1", "[::1]")),
      ).rejects.toThrow();

      const refusal = await refusalFrom(
        readPlatformIdentity("http://192.168.1.10:3101", async () =>
          Response.json({
            instance_id: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
            origin: "http://localhost:3101",
          }),
        ),
      );

      expect(refusal).toBeInstanceOf(PlatformOriginMismatchError);
      expect(refusal.message).toContain("names only the platform's own machine");
      expect(refusal.message).not.toContain("or use http://localhost:3101 here");

      // One machine, two names for itself: the other name is worth offering.
      const nearby = await refusalFrom(
        readPlatformIdentity("http://127.0.0.1:3101", async () =>
          Response.json({
            instance_id: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
            origin: "http://localhost:3101",
          }),
        ),
      );

      expect(nearby.message).toContain("or use http://localhost:3101 here");
      expect(nearby.message).not.toContain("names only the platform's own machine");
    } finally {
      await onlyItsOwnMachine.close();
    }
  });

  /**
   * Nobody typed egma's built-in default address, nobody runs what is at it,
   * and nobody can fix it — so the refusal points at the one move that belongs
   * to the developer, and never sends them off to inspect a website that is
   * not theirs.
   */
  it("does not send a developer to inspect its own built-in default address", async () => {
    const refusal = await refusalFrom(
      resolvePlatformAccess({
        env: workspace.env(),
        flag: null,
        cwd: workspace.dir,
        fetchImpl: async () =>
          new Response(null, { status: 307, headers: { location: "/login" } }),
      }),
    );

    expect(refusal).toBeInstanceOf(DefaultPlatformUnusableError);
    expect(refusal.message).toContain(DEFAULT_PLATFORM_URL);
    expect(refusal.message).toContain("--url <address>");
    expect(refusal.message).toContain("EGMA_URL");
    // Not somebody's deployment, so not somebody's misconfiguration.
    expect(refusal.message).not.toMatch(/sign-in page|proxy|this is where to look/u);
  });

  it("keeps the address it was given, whatever the platform calls itself", async () => {
    // The address that comes back is the address that was asked, always: every
    // key, identifier and committed line downstream is addressed to it.
    const access = await resolvePlatformAccess({
      env: workspace.env(),
      flag: `${platform.url}/`,
      cwd: workspace.dir,
    });
    expect(access.url).toBe(platform.url);
  });

  it("does not follow a redirect, and says that is what happened", async () => {
    const requested: string[] = [];
    await expect(
      resolvePlatformAccess({
        env: workspace.env(),
        flag: "https://behind-a-login.example",
        cwd: workspace.dir,
        fetchImpl: async (input) => {
          requested.push(String(input));
          return new Response(null, {
            status: 307,
            headers: { location: "https://sign-in.example/login" },
          });
        },
      }),
    ).rejects.toThrow(/redirected to https:\/\/sign-in\.example\/login/u);
    expect(requested).toEqual(["https://behind-a-login.example/api/platform"]);
  });

  it("gives up on a platform that takes the connection and says nothing", async () => {
    const stalled = resolvePlatformAccess({
      env: workspace.env(),
      flag: "https://accepts-and-waits.example",
      cwd: workspace.dir,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    });

    await expect(stalled).rejects.toBeInstanceOf(PlatformTimedOutError);
    await expect(stalled).rejects.toThrow("did not answer within");
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

  /**
   * A refusal names the platform the developer asked about.
   *
   * Being told to start the platform this repository is bound to, when what you
   * typed on the command line is a different address that is down, sends you to
   * fix something you did not ask for.
   */
  it("names the address the developer gave when that is the one that is down", async () => {
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: { origin: platform.url, instance: platform.instanceId },
        agent: null,
        connection: null,
        suite: null,
      },
    });
    const elsewhere = "http://127.0.0.1:1";

    const refusal = resolvePlatformAccess({
      env: workspace.env(),
      flag: elsewhere,
      cwd: workspace.dir,
    });

    await expect(refusal).rejects.toBeInstanceOf(BoundPlatformAddressError);
    await expect(refusal).rejects.toThrow(elsewhere);
    await expect(refusal).rejects.toThrow("--url");
    // Nothing was asked at either address, so nothing hung on a dead port.
    expect(platform.records).toEqual([]);
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
