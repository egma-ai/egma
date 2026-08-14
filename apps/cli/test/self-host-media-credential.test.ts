/**
 * The media server's credential, which a deployment now makes for itself.
 *
 * **This closes a hole that was open in a running deployment**, not a
 * hypothetical one. The media server, the simulator and the SIP gateway all
 * fell back to a key and a secret written into the compose file in the public
 * repository, and nothing in the CLI, the skills or the documentation ever
 * replaced them. Bound to loopback the exposure is small; the compose file
 * invites a wider bind for testing from another machine, and at that moment the
 * media server accepts anyone who read the repository.
 *
 * So preparing a workspace mints a random pair. What is worth proving, in the
 * order it would cost to get wrong:
 *
 * 1. **A second preparation does not replace it.** A regenerated pair is a
 *    running deployment whose three media containers stop agreeing, and the
 *    symptom is every phone simulation failing to authenticate.
 * 2. **The pair reaches compose**, because a credential written to a file no
 *    container reads is the same as no credential at all.
 * 3. **The secret is never printed, and the file it lands in is private.** It
 *    is a password between egma's own parts, and the operator never sees it,
 *    chooses it or types it.
 * 4. **A workspace prepared before this change is told** what happened, because
 *    its containers are recreated underneath it.
 */

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  makePlatformWorkspace,
  runSelfHost,
  startPlatform,
  type FakePlatform,
  type PlatformWorkspace,
  type SelfHostRun,
} from "./support/platform-workspace.ts";

/** The pair that was published in this repository, and must never come back. */
const PUBLISHED_KEY = "egma-devkey";
const PUBLISHED_SECRET = "egma-development-only-livekit-secret-change-it";

const KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
const SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";

const WORKSPACE_PREFIX = "egma-media-credential-";

function runUp(
  workspace: PlatformWorkspace,
  platform: FakePlatform,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<SelfHostRun> {
  return runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url, ...extraEnv });
}

describe("the media server's credential", () => {
  it("is generated when a workspace is prepared, and is not the published one", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const run = await runUp(workspace, platform);

      expect(run.code).toBe(0);
      expect(run.stdout).toContain("media_credential: generated");

      const stored = await workspace.storedConfig();
      const key = stored[KEY_VARIABLE] ?? "";
      const secret = stored[SECRET_VARIABLE] ?? "";

      expect(key).not.toBe("");
      expect(secret).not.toBe("");
      expect(key).not.toBe(PUBLISHED_KEY);
      expect(secret).not.toBe(PUBLISHED_SECRET);
      // LiveKit refuses a secret shorter than 32 characters, and a short one is
      // guessable besides. Asserted rather than trusted, because the length is
      // one edit away from being trimmed to something tidy-looking.
      expect(secret.length).toBeGreaterThanOrEqual(32);
      // Nothing in either value may need quoting: they travel through a
      // `NAME=value` file egma parses itself, a child process environment, and
      // a YAML scalar in the compose file.
      expect(key).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/u);

      // It is a password between egma's own parts. The operator never sees it.
      expect(`${run.stdout}\n${run.stderr}`).not.toContain(secret);

      // And `up` is now the *first* writer of this file, so the mode it creates
      // it with is this command's to get right. It holds a generated secret
      // from the moment it exists, and a file the rest of the machine can read
      // is a password the rest of the machine has.
      expect((await stat(workspace.configFile)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(path.dirname(workspace.configFile))).mode & 0o777,
      ).toBe(0o700);
    } finally {
      await platform.close();
    }
  });

  it("hands that one pair to compose, so the three media containers agree", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      await runUp(workspace, platform);

      const stored = await workspace.storedConfig();
      const calls = await workspace.dockerCalls();
      // A credential written to a file no container reads is no credential at
      // all: what proves this works is compose being handed the same pair.
      expect(calls).toContain(`${KEY_VARIABLE}=${stored[KEY_VARIABLE] as string}`);
      expect(calls).toContain(`${SECRET_VARIABLE}=${stored[SECRET_VARIABLE] as string}`);
    } finally {
      await platform.close();
    }
  });

  it("leaves a pair that already exists alone, so a second start breaks nothing", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      await runUp(workspace, platform);
      const first = await workspace.storedConfig();

      const second = await runUp(workspace, platform);
      const after = await workspace.storedConfig();

      expect(second.code).toBe(0);
      expect(after[KEY_VARIABLE]).toBe(first[KEY_VARIABLE]);
      expect(after[SECRET_VARIABLE]).toBe(first[SECRET_VARIABLE]);
      // And it says which of the two happened, because "generated" on a running
      // deployment is the line that explains why its containers were replaced.
      expect(second.stdout).toContain("media_credential: existing");
      expect(second.stdout).not.toContain("media_credential: generated");
    } finally {
      await platform.close();
    }
  });

  it("gives a workspace prepared before this change a pair, and says so", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      // What an upgrading deployment's workspace holds: everything phone setup
      // wrote, and no media credential, because there was nothing to write it.
      await mkdir(path.dirname(workspace.configFile), { recursive: true });
      await writeFile(
        workspace.configFile,
        "EGMA_PHONE_SOURCE_NUMBER=+15550100100\nEGMA_SIMULATOR_MEDIA_BACKEND=livekit\n",
      );

      const run = await runUp(workspace, platform);

      expect(run.code).toBe(0);
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).not.toBe(undefined);
      expect(stored[SECRET_VARIABLE]).not.toBe(undefined);
      // Everything the carrier paperwork left behind survives the rewrite.
      expect(stored.EGMA_PHONE_SOURCE_NUMBER).toBe("+15550100100");
      expect(stored.EGMA_SIMULATOR_MEDIA_BACKEND).toBe("livekit");
      // A file somebody loosened is tightened again by the write, rather than
      // keeping whatever mode it happened to have.
      expect((await stat(workspace.configFile)).mode & 0o777).toBe(0o600);
      // And the operator is told, in sentences, because their media containers
      // are being replaced by this run — and because what those containers held
      // until this moment is a security fact they are entitled to hear plainly.
      expect(run.stderr).toContain("media-server credential was generated");
      expect(run.stderr).toContain("published in egma's own repository");
      expect(run.stderr).toContain("media containers are replaced by this start");
    } finally {
      await platform.close();
    }
  });

  it("keeps a pair the operator brought, and writes it down rather than replacing it", async () => {
    // `.env.example` names these two variables, so somebody exporting them
    // meant it — and a CLI that quietly minted its own over the top would be
    // ignoring a setting it told them to make. Recording it matters as much as
    // honouring it: a pair that lives only in one shell is one the next start
    // cannot find, and that start would mint a third and lock the deployment
    // out of itself.
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const run = await runUp(workspace, platform, {
        [KEY_VARIABLE]: "a-key-the-operator-chose",
        [SECRET_VARIABLE]: "a-secret-the-operator-chose-that-is-long-enough",
      });

      expect(run.stdout).toContain("media_credential: existing");
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).toBe("a-key-the-operator-chose");
      expect(stored[SECRET_VARIABLE]).toBe("a-secret-the-operator-chose-that-is-long-enough");
    } finally {
      await platform.close();
    }
  });

  it("mints one pair when two commands prepare the same workspace at once", async () => {
    // Two preparations racing on a workspace with no pair is reachable without
    // anybody doing anything strange: `up` and `phone setup` both mint, so the
    // racers need not even be the same command. Unguarded, each generates its
    // own pair, each writes the file, and each hands *its* pair to Compose — so
    // the recorded pair and the running containers' pair differ. That passes
    // every health check and surfaces minutes later as an authentication
    // refusal naming nothing about configuration, which is the exact failure
    // this whole effort exists to remove.
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const [first, second] = await Promise.all([
        runUp(workspace, platform),
        runUp(workspace, platform),
      ]);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);

      // Exactly one winner. The loser adopted what the winner recorded rather
      // than writing over it, which is the whole property.
      const runs = [first, second];
      expect(runs.filter((run) => run.stdout.includes("media_credential: generated"))).toHaveLength(1);
      expect(runs.filter((run) => run.stdout.includes("media_credential: existing"))).toHaveLength(1);

      // One pair on disk, and every pair either command handed to Compose is
      // that pair. Read from what the docker stand-in wrote down, so this is
      // what the containers would really have been created with.
      const stored = await workspace.storedConfig();
      const calls = await workspace.dockerCalls();
      for (const variable of [KEY_VARIABLE, SECRET_VARIABLE]) {
        const onDisk = stored[variable] ?? "";
        expect(onDisk).not.toBe("");
        const handed = [...calls.matchAll(new RegExp(`^${variable}=(.*)$`, "gmu"))].map(
          (line) => line[1] as string,
        );
        expect(handed).toHaveLength(2);
        expect(new Set(handed)).toEqual(new Set([onDisk]));
      }

      // And nothing is left holding the workspace once both have finished.
      expect(
        existsSync(path.join(path.dirname(workspace.configFile), ".media-credential.lock")),
      ).toBe(false);
    } finally {
      await platform.close();
    }
  });

  it("replaces half a pair, because half a credential authenticates nothing", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      await mkdir(path.dirname(workspace.configFile), { recursive: true });
      await writeFile(workspace.configFile, `${KEY_VARIABLE}=a-key-with-no-secret\n`);

      const run = await runUp(workspace, platform);

      expect(run.stdout).toContain("media_credential: generated");
      const stored = await workspace.storedConfig();
      expect(stored[KEY_VARIABLE]).not.toBe("a-key-with-no-secret");
      expect(stored[SECRET_VARIABLE] ?? "").not.toBe("");
    } finally {
      await platform.close();
    }
  });
});
