import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindRepositoryPlatform,
  createEgmaFolder,
  folderPathsIn,
} from "../src/folder/egma-folder.ts";
import {
  BoundPlatformAddressError,
  BoundPlatformUnavailableError,
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
import {
  makeWorkspace,
  NO_DEFAULT_PLATFORM,
  type Workspace,
} from "./support/workspace.ts";

/** The refusal a promise ended with, or a failure saying it did not refuse. */
async function refusalFrom(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error("that was supposed to be refused, and it was not");
}

/**
 * The whole move, under a refusal a developer meets while trying to make it.
 *
 * These two refusals are what somebody pointing egma at the platform they want
 * is answered with, so each has to end where `bindRepositoryPlatform` ends: the
 * five lines to delete, and what moving costs. Each line is checked in
 * `egma-folder.test.ts`, which owns the wording; what is checked here is that
 * this refusal carries it at all rather than naming a first step and stopping.
 */
function expectTheWholeMove(said: string): void {
  expect(said).toContain(
    "To move this repository to another platform, delete these in this order and run egma again:",
  );
  const deletions = said.split("\n").filter((line) => line.startsWith("  - "));
  expect(deletions).toHaveLength(5);
  // And the platform block last, wherever this refusal is raised from. It is
  // the line that unbinds the repository, and an unbound repository falls back
  // to egma's own platform — so a list that named it first would send every
  // other identifier in the folder to hosted egma on the very next command.
  expect(deletions.at(-1)).toContain("the whole platform: block");
  expect(said).toContain("Your tests move with you");
  expect(said).toContain("stay on the platform that ran them");
  // The refusal teaches the move. Nothing offers to perform it.
  expect(said).not.toMatch(/egma rebind|--rebind|Egma move/u);
}

describe("verifying an egma platform", () => {
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

  /**
   * A binding cannot disagree with itself.
   *
   * The origin is a line in a file a person edits, and a person writes a
   * trailing slash, or the host in capitals, or the default port spelled out.
   * Every one of those is the same platform. Read as written, the repository is
   * refused for moving nowhere — told that the binding names something other
   * than the binding, told to drop something that is not there, and handed four
   * deletions for a move it is not making. So the committed origin is read in
   * the one shape origins are compared in, and this is a repository reached
   * rather than refused.
   */
  it("reaches a bound platform whose committed origin is written another way", async () => {
    await workspace.signIn(platform.url);
    for (const written of [`${platform.url}/`, `  ${platform.url}  `]) {
      await rm(folderPathsIn(workspace.dir).root, { recursive: true, force: true });
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: written, instance: platform.instanceId },
          agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
          connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
          suite: { name: "first-suite", id: "sui_01K3XQ7M4E8YB2FVN0H9TZQWET" },
        },
      });

      const access = await resolvePlatformAccess({
        env: workspace.env(),
        flag: null,
        cwd: workspace.dir,
      });
      expect(access, written).toMatchObject({
        url: platform.url,
        instanceId: platform.instanceId,
      });

      // And the binding is still what it always was: the same platform reached
      // at the address it recorded, so nothing is rewritten for anybody.
      expect(
        (await bindRepositoryPlatform(workspace.dir, {
          origin: platform.url,
          instance: platform.instanceId,
        })).platform,
      ).toEqual({ origin: platform.url, instance: platform.instanceId });
    }
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

      const refusal = await refusalFrom(
        resolvePlatformAccess({
          env: workspace.env(),
          flag: other.url,
          cwd: workspace.dir,
        }),
      );
      expect(refusal).toBeInstanceOf(BoundPlatformAddressError);

      // Naming another platform on the command line is how a developer says
      // they want to move, so this is the refusal that has to teach the move.
      expectTheWholeMove(refusal.message);

      // The two edits it offers contradict each other — change the platform
      // origin, or delete the whole platform block — so the sentence says which
      // situation each belongs to. Under ADR-0007 a refusal holding both
      // without a condition is one a coding agent cannot act on.
      expect(refusal.message).toContain("Drop --url to use the bound platform.");
      expect(refusal.message).toContain(
        `edit the platform origin in egma/config.yaml to ${other.url} and change nothing else`,
      );
      expect(refusal.message).toContain(
        "the move below is for a different platform, not a new address for this one",
      );

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

    const refusal = await refusalFrom(
      resolvePlatformAccess({ env: workspace.env(), flag: null, cwd: workspace.dir }),
    );
    expect(refusal).toBeInstanceOf(PlatformBindingMismatchError);

    // Both identities, because which one is which is the whole of what
    // happened: the one the repository recorded, and the one answering now.
    expect(refusal.message).toContain("pf_01K3XQ7M4E8YB2FVN0H9TZQWEA");
    expect(refusal.message).toContain(platform.instanceId);

    // And no flag anywhere in it. Nothing a developer typed can be the cause
    // here — an address that is not the bound one was refused before anybody
    // was asked, and the same address is the same address — so the only way to
    // arrive is the platform at the recorded address having changed. Telling
    // somebody to remove a flag is unfollowable at the one moment this fires,
    // and it fires when they have least idea why.
    expect(refusal.message).not.toContain("--url");
    expect(refusal.message).toContain("edit the platform instance in egma/config.yaml");

    // A rebuilt stack is the same repository meeting a platform that issued
    // none of its identifiers, which is the move whether the developer meant
    // it or not — so this refusal teaches it too.
    expectTheWholeMove(refusal.message);

    // One question asked, and it was the public one that carries nothing.
    expect(platform.records.map((record) => `${record.method} ${record.path}`)).toEqual([
      "GET /api/platform",
    ]);
  });

  it("takes the explicit URL before egma's own, then verifies the selected instance", async () => {
    const built = await startPlatform();
    try {
      const access = await resolvePlatformAccess({
        // The step below the flag, stood in for. Nothing else names a platform:
        // this repository has no folder, so the flag is against the last step.
        env: workspace.env({ EGMA_TEST_DEFAULT_URL: built.url }),
        flag: platform.url,
        cwd: workspace.dir,
      });

      expect(access.url).toBe(platform.url);
      expect(platform.records.map((record) => record.path)).toEqual(["/api/platform"]);
      expect(built.records).toEqual([]);
    } finally {
      await built.close();
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
   * Nobody typed egma's built-in address, nobody but egma runs what is at it,
   * and nobody outside egma can fix it. So the **advice** is suppressed — go
   * and look at that address, reconfigure that deployment — because every word
   * of it is addressed to somebody who is not reading.
   *
   * **What happened is not suppressed.** A redirect, a 500 and a page that is
   * not a platform are three different things, and a refusal that called all
   * three "it did not answer" was wrong about the fact for two of them. The
   * shape travels too: something that will answer the same way in a minute is
   * `refused` and does not invite a retry, and only a bad moment says to wait.
   */
  it("says what happened at its own built-in address, without passing on its advice", async () => {
    const answers = [
      {
        what: "a redirect",
        answer: () => new Response(null, { status: 307, headers: { location: "/login" } }),
        says: "it redirected to /login instead.",
        refusal: "refused" as const,
      },
      {
        what: "a bad minute",
        answer: () => new Response("nope", { status: 502 }),
        says: "it answered 502 rather than its identity.",
        refusal: "unreachable" as const,
      },
      {
        what: "an address that is not Egma",
        answer: () => new Response("<html>somebody else</html>", { status: 404 }),
        says: "it answered 404 rather than its identity.",
        refusal: "refused" as const,
      },
      {
        what: "a page that answers but says nothing Egma knows",
        answer: () => Response.json({ nothing: "useful" }),
        says: "what came back carries no platform identity Egma can use.",
        refusal: "refused" as const,
      },
      {
        what: "a platform naming an address nobody asked for",
        answer: () =>
          Response.json({
            instance_id: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEA",
            origin: "https://somewhere.else.example",
          }),
        says: "it answered that it lives at https://somewhere.else.example instead.",
        refusal: "refused" as const,
      },
    ];

    for (const shape of answers) {
      const refusal = (await refusalFrom(
        resolvePlatformAccess({
          env: workspace.env({ EGMA_TEST_DEFAULT_URL: "https://built-in.example" }),
          flag: null,
          cwd: workspace.dir,
          fetchImpl: async () => shape.answer(),
        }),
      )) as DefaultPlatformUnusableError;

      expect(refusal, shape.what).toBeInstanceOf(DefaultPlatformUnusableError);
      // The address egma tried, so "hosted egma is down" can be told apart from
      // "I typed something wrong" — and there was nothing to type.
      expect(refusal.message, shape.what).toContain("https://built-in.example");
      // What happened there, said rather than flattened into "it did not
      // answer". The spec's own further notes rely on a developer being told
      // about a redirect.
      expect(refusal.message, shape.what).toContain(shape.says);
      // The one move that is theirs is always offered — and it is one move,
      // because naming a platform on the command is the only way to name one.
      expect(refusal.message, shape.what).toContain("--url <address>");
      expect(refusal.message, shape.what).not.toContain("EGMA_URL");
      expect(refusal.message, shape.what).toContain("Nothing was sent");

      // Not the underlying advice: none of it is the developer's to act on.
      expect(refusal.message, shape.what).not.toMatch(
        /sign-in page|proxy|this is where to look/u,
      );
      expect(refusal.message, shape.what).not.toContain("Check the address");
      expect(refusal.message, shape.what).not.toContain("EGMA_BASE_URL");

      // And the shape, which is what decides whether anything is worth
      // retrying. "Try again in a moment" over a permanent answer is a loop
      // with no way out of it.
      expect(refusal.refusal, shape.what).toBe(shape.refusal);
      if (shape.refusal === "refused") {
        expect(refusal.message, shape.what).not.toContain("Try again in a moment");
        expect(refusal.message, shape.what).toContain("waiting will not change it");
      } else {
        expect(refusal.message, shape.what).toContain("Try again in a moment");
      }

      // And the real fault is still there for whoever goes looking.
      expect(refusal.cause, shape.what).toBeInstanceOf(Error);
    }
  });

  /**
   * The same refusal for the way it will really happen: nobody answering at
   * all. It is the one an unbound repository meets on a train.
   */
  it("names the built-in address it tried when nothing answers there", async () => {
    const refusal = await refusalFrom(
      resolvePlatformAccess({
        // A closed port, which is what every workspace stands in for the real
        // built-in address by default.
        env: workspace.env(),
        flag: null,
        cwd: workspace.dir,
      }),
    );

    expect(refusal).toBeInstanceOf(DefaultPlatformUnusableError);
    expect(refusal.message).toContain(NO_DEFAULT_PLATFORM);
    expect(refusal.message).toContain("nothing answered there");
    expect(refusal.message).toContain("Nothing was sent");
    // The one shape where waiting really can change the answer, and the only
    // one that says so.
    expect((refusal as DefaultPlatformUnusableError).refusal).toBe("unreachable");
    expect(refusal.message).toContain("Try again in a moment");
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
    const timeoutSignal = AbortSignal.abort(
      new DOMException("the platform identity deadline passed", "TimeoutError"),
    );
    const stalled = resolvePlatformAccess({
      env: workspace.env(),
      flag: "https://accepts-and-waits.example",
      cwd: workspace.dir,
      identityTimeoutSignal: timeoutSignal,
      fetchImpl: async (_input, init) => {
        expect(init?.signal).toBe(timeoutSignal);
        throw init?.signal?.reason ?? new Error("aborted");
      },
    });

    await expect(stalled).rejects.toBeInstanceOf(PlatformTimedOutError);
    await expect(stalled).rejects.toThrow("did not answer within");
  });

  it("asks egma's own platform, and only that, when nothing names another", async () => {
    const requested: string[] = [];
    const access = await resolvePlatformAccess({
      env: workspace.env({ EGMA_TEST_DEFAULT_URL: platform.url }),
      flag: null,
      cwd: workspace.dir,
      fetchImpl: async (input, init) => {
        requested.push(String(input));
        return fetch(input, init);
      },
    });

    // The last step of the order, and the only one nobody typed: a repository
    // with nothing configured reaches egma's own platform.
    expect(access.url).toBe(platform.url);
    expect(access.instanceId).toBe(platform.instanceId);

    // One address asked, and it is that one. Nothing goes looking anywhere else
    // for a repository that named nothing.
    expect(requested).toEqual([`${platform.url}/api/platform`]);
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

  it("refuses an unavailable bound platform and does not try egma's own", async () => {
    // A closed port, and deliberately not the one standing in for the built-in
    // address: the request list below is the proof that the fall-back step was
    // never taken, and two identical addresses would make it prove nothing.
    const boundOrigin = "http://127.0.0.1:2";
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
    await expect(resolution).rejects.toThrow(
      "Egma did not fall back to its own platform",
    );
    // One address asked, and it is the bound one. The built-in address exists
    // now, so this list is what proves a bound repository never reaches it.
    expect(requested).toEqual([`${boundOrigin}/api/platform`]);
    expect(requested).not.toContain(`${NO_DEFAULT_PLATFORM}/api/platform`);
  });
});
