/**
 * The bare command, as a developer with nothing configured really types it.
 *
 * No `--url`, no `EGMA_URL`, no platform in the committed folder: the last step
 * of resolution is egma's own platform, and this is the check that proves it
 * the way it is run — the built CLI as its own process, against a platform
 * standing where the built-in address is. Proving it only inside the resolver
 * would leave the one thing a developer meets — typing `npx @egma/cli` and
 * getting the wizard — unproven.
 *
 * The stand-in arrives through `EGMA_TEST_DEFAULT_URL`, which is why that seam
 * exists. Nothing here dials the real hosted platform.
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  folderPathsIn,
  readConfig,
  updateConfig,
  writeTestFile,
} from "../src/folder/egma-folder.ts";
import { DEFAULT_TEST_COUNT } from "../src/wizard/test-generation.ts";
import { startFakeRetell, type FakeRetell } from "./support/fake-retell.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { gradeEveryRun } from "./support/grading.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  makeWorkspace,
  NO_DEFAULT_PLATFORM,
  type Workspace,
} from "./support/workspace.ts";

const PLATFORM_KEY = "egma_sk_for-the-built-in-address";
const PROVIDER_KEY = "synthetic-retell-key-for-the-built-in-address";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Ended = { readonly stdout: string; readonly stderr: string; readonly code: number };

describe("a repository that names no platform", () => {
  /** The platform standing where egma's own address is. */
  let own: Platform;
  /** A second platform, which must never see a request. */
  let elsewhere: Platform;
  let retell: FakeRetell;

  beforeAll(async () => {
    [own, elsewhere, retell] = await Promise.all([
      startPlatform(),
      startPlatform(),
      startFakeRetell({
        keys: [PROVIDER_KEY],
        agents: [
          {
            agent_id: "synthetic-retell-agent",
            agent_name: "Default receptionist",
            response_engine: { type: "retell-llm", llm_id: "synthetic-llm" },
          },
        ],
        llms: [
          {
            llm_id: "synthetic-llm",
            general_prompt: "Help each persona move an appointment.",
          },
        ],
      }),
    ]);
    own.signedInWith(PLATFORM_KEY);
    elsewhere.signedInWith(PLATFORM_KEY);
  });

  afterAll(async () => {
    await Promise.all([own.close(), elsewhere.close(), retell.close()]);
  });

  /**
   * The command, run the way a developer runs it: never with `--url`, and
   * never with `EGMA_URL` in the environment. Both are asserted rather than
   * assumed, because either one would make every claim below vacuous.
   */
  async function egma(
    workspace: Workspace,
    args: readonly string[],
    extra: NodeJS.ProcessEnv = {},
  ): Promise<Ended> {
    const env = workspace.env({ EGMA_RETELL_URL: retell.url, ...extra });
    // Unless the check is deliberately proving that one of them wins, neither
    // way of naming a platform is in play — and that is asserted rather than
    // assumed, because either one would make every claim below vacuous.
    if (!args.includes("--url") && extra.EGMA_URL === undefined) {
      expect(env.EGMA_URL).toBeUndefined();
    }

    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // `connect` checks standard input before its environment. End the pipe so
    // the real process sees the same promptless EOF a coding agent sends.
    child.stdin.end();
    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 1));
    });
    return { stdout, stderr, code };
  }

  /**
   * The whole walk, from a folder with nothing in it, on the platform nobody
   * named. It is the claim the published package's front page makes.
   */
  it("takes the bare command through the whole walk on egma's own platform", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(own.url, PLATFORM_KEY);
      // Written second on purpose: a key this machine holds for another
      // platform still selects nothing.
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);

      const paths = folderPathsIn(workspace.dir);
      // Tests the developer already had, and deliberately no config file at
      // all: nothing here names a platform.
      await mkdir(paths.tests, { recursive: true });
      await expect(readConfig(paths.config)).rejects.toMatchObject({ code: "ENOENT" });

      const script = await workspace.script({
        steps: [
          { kind: "say", text: "egma:found framework retell-sdk\n" },
          { kind: "stop", reason: "end_turn" },
        ],
      });
      for (let number = 1; number <= DEFAULT_TEST_COUNT; number += 1) {
        const name = `moves-appointment-${number}`;
        await writeTestFile(path.join(paths.tests, `${name}.md`), {
          name,
          personas: [],
          version: null,
          scenario: `The persona needs a different appointment time in case ${number}.`,
          expectedBehaviors: ["The agent confirms the new time."],
          mockTools: [],
        });
      }

      const before = own.records.length;
      const grading = gradeEveryRun(own);
      let walked: Ended;
      try {
        walked = await egma(
          workspace,
          ["--headless", "--", process.execPath, FAKE_AGENT, script],
          {
            EGMA_TEST_DEFAULT_URL: own.url,
            EGMA_RETELL_API_KEY: PROVIDER_KEY,
            EGMA_REACH: "text",
          },
        );
      } finally {
        grading.stop();
      }

      expect(walked.code, walked.stderr).toBe(0);
      expect(walked.stdout).toMatch(/^first-verdict: /mu);

      // Which egma, said as one plain line in the same place in the walk the
      // wizard's first screen says it: before the login, and before anything
      // this repository owns has moved.
      const named = walked.stdout.indexOf(`url: ${own.url}`);
      expect(named).toBeGreaterThanOrEqual(0);
      expect(walked.stdout.indexOf("signed in to")).toBeGreaterThan(named);

      const asked = own.records.slice(before);
      expect(asked[0]).toMatchObject({ method: "GET", path: "/api/platform" });
      for (const expected of ["/api/agents", "/api/tests", "/api/runs"]) {
        expect(asked.some((request) => request.path === expected), expected).toBe(true);
      }

      // And the repository is now bound to the platform it reached, so the next
      // command in it needs nothing said either.
      const config = await readConfig(paths.config);
      expect(config.platform).toEqual({ origin: own.url, instance: own.instanceId });

      expect(elsewhere.records).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });

  /**
   * One repository, one platform, for every command in it — which is the whole
   * claim, and the reason resolution lives in one place rather than per verb.
   */
  it("sends every verb there too, while nothing else names one", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(own.url, PLATFORM_KEY);
      const seam = { EGMA_TEST_DEFAULT_URL: own.url };
      const paths = folderPathsIn(workspace.dir);

      // `init` writes a folder and talks to nothing, so it names no platform
      // and reaches none.
      const started = await egma(
        workspace,
        ["init", "--agent", "Receptionist", "--connection", "retell-1"],
        seam,
      );
      expect(started.code, started.stderr).toBe(0);
      expect((await readConfig(paths.config)).platform).toBeNull();

      await writeTestFile(path.join(paths.tests, "moves-appointment.md"), {
        name: "moves-appointment",
        personas: [],
        version: null,
        scenario: "The persona needs a different appointment time.",
        expectedBehaviors: ["The agent confirms the new time."],
        mockTools: [],
      });

      for (const [verb, args] of [
        ["login", ["login"]],
        ["push", ["push"]],
        ["pull", ["pull"]],
      ] as const) {
        const before = own.records.length;
        const result = await egma(workspace, args, seam);
        expect(result.code, `${verb}: ${result.stderr}`).toBe(0);
        expect(result.stdout, verb).toContain(`url: ${own.url}`);
        expect(own.records.slice(before)[0], verb).toMatchObject({
          method: "GET",
          path: "/api/platform",
        });
      }

      const connected = await egma(workspace, ["connect"], {
        ...seam,
        EGMA_RETELL_API_KEY: PROVIDER_KEY,
        EGMA_REACH: "text",
      });
      expect(connected.code, connected.stderr).toBe(0);
      expect(connected.stdout).toContain("status: connected");
      expect(connected.stdout).toContain(`url: ${own.url}`);

      // `connect` binds, so the platform block goes back out to leave `run`
      // where every other command here was: naming nothing.
      await updateConfig(paths.config, { platform: null });
      const ran = await egma(workspace, ["run", "--no-follow"], seam);
      expect(ran.code, ran.stderr).toBe(0);
      expect(ran.stdout).toContain("status: started");
      expect(ran.stdout).toContain(`url: ${own.url}`);

      expect(elsewhere.records).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });

  /**
   * The developer never typed this address and cannot fix what is at it, so the
   * refusal names it, says nothing was sent, and answers with the number every
   * other unreachable platform answers with.
   */
  it("refuses by name when egma's own platform does not answer", async () => {
    const workspace = await makeWorkspace();
    try {
      // The stand-in every workspace uses by default is a closed port.
      const refused = await egma(workspace, ["login"]);

      expect(refused.code).toBe(4);
      expect(refused.stdout).toContain("status: unreachable");
      expect(refused.stderr).toContain(NO_DEFAULT_PLATFORM);
      expect(refused.stderr).toContain("Nothing was sent");
      expect(refused.stderr).toContain("--url <address>");
      expect(refused.stderr).toContain("EGMA_URL");

      // The wizard answers the same way, and says which address it was going to
      // use before it finds out that nothing is there.
      const script = await workspace.script({
        steps: [{ kind: "stop", reason: "end_turn" }],
      });
      const wizard = await egma(workspace, [
        "--headless",
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ]);

      expect(wizard.code).toBe(4);
      expect(wizard.stdout).toContain(`url: ${NO_DEFAULT_PLATFORM}`);
      expect(wizard.stdout).toContain("status: unreachable");
      expect(wizard.stderr).toContain("Nothing was sent");
    } finally {
      await workspace.remove();
    }
  });

  /** The three deliberate places still win, in their order, over egma's own. */
  it("keeps every step above it winning", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);
      const before = own.records.length;

      // A whole shell pointed elsewhere: the built-in address is not consulted.
      const byEnvironment = await egma(workspace, ["login"], {
        EGMA_TEST_DEFAULT_URL: own.url,
        EGMA_URL: elsewhere.url,
      });
      expect(byEnvironment.code, byEnvironment.stderr).toBe(0);
      expect(byEnvironment.stdout).toContain(`url: ${elsewhere.url}`);

      // And one command pointed elsewhere beats even that.
      const byFlag = await egma(workspace, ["login", "--url", elsewhere.url], {
        EGMA_TEST_DEFAULT_URL: own.url,
      });
      expect(byFlag.code, byFlag.stderr).toBe(0);
      expect(byFlag.stdout).toContain(`url: ${elsewhere.url}`);

      expect(own.records.slice(before)).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });

  /**
   * The rule the whole binding exists for, now that there is something to fall
   * back to: a repository that named its platform is never quietly moved to
   * egma's own, whatever is wrong with the one it named.
   */
  it("never falls back to egma's own from a repository that is bound", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(own.url, PLATFORM_KEY);
      const closed = "http://127.0.0.1:2";
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: closed, instance: "pf_01K3XQ7M4E8YB2FVN0H9TZQWEP" },
          agent: null,
          connection: null,
          suite: null,
        },
      });

      const before = own.records.length;
      const refused = await egma(workspace, ["push"], { EGMA_TEST_DEFAULT_URL: own.url });

      expect(refused.code).toBe(4);
      expect(refused.stdout).toContain("status: unreachable");
      expect(refused.stderr).toContain(closed);
      expect(refused.stderr).toContain("no repository identifiers were sent");
      // The platform standing where egma's own address is saw nothing at all.
      expect(own.records.slice(before)).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });
});
