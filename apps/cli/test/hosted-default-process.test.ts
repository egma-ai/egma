/**
 * The bare command, as a developer with nothing configured really types it.
 *
 * No `--url` and no platform in the committed folder: the last step of
 * resolution is Egma's own platform, and this is the check that proves it
 * the way it is run — the built CLI as its own process, against a platform
 * standing where the built-in address is. Proving it only inside the resolver
 * would leave the one thing a developer meets — typing `npx @egma/cli` and
 * getting the wizard — unproven.
 *
 * The stand-in arrives through `EGMA_TEST_DEFAULT_URL`, which is why that seam
 * exists. Nothing here dials the real hosted platform.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEgmaFolder,
  folderPathsIn,
  MOVE_TO_ANOTHER_PLATFORM,
  readConfig,
  updateConfig,
  writeTestFile,
} from "../src/folder/egma-folder.ts";
import { parseTestFile } from "../src/folder/test-file.ts";
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
  /** The platform standing where Egma's own address is. */
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
   * The command, run the way a developer runs it: with nothing naming a
   * platform, so that the last step of resolution is what answers.
   *
   * There is one way to name one — `--url` — so a check that is deliberately
   * proving the flag wins says it in its own arguments, and every other check
   * here is one where nothing did.
   */
  async function egma(
    workspace: Workspace,
    args: readonly string[],
    extra: NodeJS.ProcessEnv = {},
  ): Promise<Ended> {
    const env = workspace.env({ EGMA_RETELL_URL: retell.url, ...extra });
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
  it("takes the bare command through the whole walk on Egma's own platform", async () => {
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

      // Which Egma, said as one plain line in the same place in the walk the
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

      // `run` is the one verb that cannot be asked this question with nothing
      // in the folder: it needs the agent and connection ids, and those are
      // only ever written by `connect`, which binds before it writes them. So
      // an unbound repository that `run` could run in is not a state Egma can
      // produce — taking the platform block back out here would leave the
      // half-moved folder, which is refused on purpose by the check below.
      //
      // What is proven instead is the same claim from the other side: `connect`
      // reached the built-in address with nothing naming one, and bound this
      // repository to what answered there, so `run` goes to that same Egma.
      expect((await readConfig(paths.config)).platform).toEqual({
        origin: own.url,
        instance: own.instanceId,
      });
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
  it("refuses by name when Egma's own platform does not answer", async () => {
    const workspace = await makeWorkspace();
    try {
      // The stand-in every workspace uses by default is a closed port.
      const refused = await egma(workspace, ["login"]);

      expect(refused.code).toBe(4);
      expect(refused.stdout).toContain("status: unreachable");
      expect(refused.stderr).toContain(NO_DEFAULT_PLATFORM);
      expect(refused.stderr).toContain("Nothing was sent");
      expect(refused.stderr).toContain("--url <address>");

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

  /** Both deliberate places still win, in their order, over Egma's own. */
  it("keeps every step above it winning", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);
      const before = own.records.length;

      // One command pointed elsewhere: the built-in address is not consulted.
      const byFlag = await egma(workspace, ["login", "--url", elsewhere.url], {
        EGMA_TEST_DEFAULT_URL: own.url,
      });
      expect(byFlag.code, byFlag.stderr).toBe(0);
      expect(byFlag.stdout).toContain(`url: ${elsewhere.url}`);

      // And the committed file, with neither of those in play. This is the step
      // directly above the built-in address, so it is the one whose win the new
      // last step could have taken away.
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: elsewhere.url, instance: elsewhere.instanceId },
          agent: null,
          connection: null,
          suite: null,
        },
      });
      const byBinding = await egma(workspace, ["login"], {
        EGMA_TEST_DEFAULT_URL: own.url,
      });
      expect(byBinding.code, byBinding.stderr).toBe(0);
      expect(byBinding.stdout).toContain(`url: ${elsewhere.url}`);

      expect(own.records.slice(before)).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });

  /**
   * The rung that went, proven gone from the outside.
   *
   * `EGMA_URL` used to sit between the flag and the binding, so a shell that
   * held it decided every command run in that shell. There is one explicit way
   * to name a platform per invocation now, which makes the variable an ordinary
   * word in the environment: it selects nothing, and — this is the half that
   * could have been missed — it refuses nothing either. A bound repository used
   * to be told it was being moved by a shell somebody set up months ago, which
   * is a refusal about a decision nobody made today.
   */
  it("is not moved by EGMA_URL, on a repository bound or unbound", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(own.url, PLATFORM_KEY);
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);
      const shell = { EGMA_TEST_DEFAULT_URL: own.url, EGMA_URL: elsewhere.url };
      const elsewhereBefore = elsewhere.records.length;

      // Unbound: the built-in address, exactly as with nothing in the shell.
      const unbound = await egma(workspace, ["login"], shell);
      expect(unbound.code, unbound.stderr).toBe(0);
      expect(unbound.stdout).toContain(`url: ${own.url}`);

      // Bound: the committed platform, and no refusal about a move nobody is
      // making.
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: own.url, instance: own.instanceId },
          agent: null,
          connection: null,
          suite: null,
        },
      });
      const bound = await egma(workspace, ["login"], shell);
      expect(bound.code, bound.stderr).toBe(0);
      expect(bound.stdout).toContain(`url: ${own.url}`);
      expect(bound.stdout).not.toContain("status: refused");

      // And the platform that shell named was never asked so much as who it is.
      expect(elsewhere.records.slice(elsewhereBefore)).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });

  /**
   * Egma's own instructions, followed the way they are written.
   *
   * The refusal that keeps a bound repository where it belongs ends with a list
   * of lines to delete, and a developer — or the coding agent reading it out of
   * their terminal — works down that list from the top. Every state on the way
   * down is a real repository somebody runs a command in.
   *
   * Deleting the platform block is the line that unbinds the repository, and an
   * unbound repository falls back to Egma's own platform. So if that line came
   * first, applying Egma's own list top-down would leave, after one edit, a
   * repository with no binding and every other platform's identifiers still
   * committed — and the next command would carry them to hosted Egma. That is
   * why it is last, and this is the check that keeps it there: the list is
   * driven in its own order, and nothing may reach the built-in address until
   * the last line has been applied and there is nothing left to leak.
   */
  it("applies its own list top-down without anything reaching the built-in address", async () => {
    const workspace = await makeWorkspace();
    try {
      await workspace.signIn(own.url, PLATFORM_KEY);
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);

      const paths = folderPathsIn(workspace.dir);
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: elsewhere.url, instance: elsewhere.instanceId },
          agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
          connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
          suite: { name: "first-suite", id: "sui_01K3XQ7M4E8YB2FVN0H9TZQWET" },
        },
      });
      const pinned = path.join(paths.tests, "moves-appointment.md");
      await writeTestFile(pinned, {
        name: "moves-appointment",
        personas: [],
        version: "tv_01K3XQ7M4E8YB2FVN0H9TZQWEU",
        scenario: "The persona needs a different appointment time.",
        expectedBehaviors: ["The agent confirms the new time."],
        mockTools: [],
      });

      /** One line of Egma's list, and the edit it asks for. */
      const deletions: readonly {
        readonly mentions: string;
        readonly apply: () => Promise<void>;
      }[] = [
        {
          mentions: "under agent:",
          apply: async () => {
            const held = await readConfig(paths.config);
            await updateConfig(paths.config, {
              agent: { name: held.agent?.name ?? "receptionist", id: null },
            });
          },
        },
        {
          mentions: "under connection:",
          apply: async () => {
            const held = await readConfig(paths.config);
            await updateConfig(paths.config, {
              connection: { name: held.connection?.name ?? "retell-1", id: null },
            });
          },
        },
        {
          mentions: "under suite:",
          apply: async () => {
            const held = await readConfig(paths.config);
            await updateConfig(paths.config, {
              suite: { name: held.suite?.name ?? "first-suite", id: null },
            });
          },
        },
        {
          mentions: "the version: line",
          apply: async () => {
            const held = parseTestFile(
              await readFile(pinned, "utf8"),
              "moves-appointment.md",
              "moves-appointment",
            );
            await writeTestFile(pinned, { ...held, version: null });
          },
        },
        {
          mentions: "the whole platform: block",
          apply: async () => {
            await updateConfig(paths.config, { platform: null });
          },
        },
      ];

      // Driven in the list's own order, so that reordering the list is what
      // this check reads — not a copy of the order written out again here.
      const listed = MOVE_TO_ANOTHER_PLATFORM.filter((line) => line.startsWith("  - "));
      expect(listed).toHaveLength(deletions.length);

      const seam = { EGMA_TEST_DEFAULT_URL: own.url };
      for (const [index, line] of listed.entries()) {
        const deletion = deletions.find((step) => line.includes(step.mentions));
        expect(deletion, line).toBeDefined();
        await deletion?.apply();

        const before = own.records.length;
        const pulled = await egma(workspace, ["pull"], seam);
        const reached = own.records.slice(before);
        const last = index === listed.length - 1;

        expect(pulled.code, `${line}: ${pulled.stderr}`).toBe(0);
        if (last) {
          // The list is applied. Nothing in the folder belongs to the old
          // platform any more, so the repository is free to reach Egma's own —
          // which is the whole point of doing the deletions.
          expect(pulled.stdout).toContain(`url: ${own.url}`);
          expect(reached.map((request) => request.path)).toContain("/api/platform");
        } else {
          // Part way down the list, and still bound. Every command still goes
          // to the platform that issued these identifiers, and Egma's own
          // address is not asked so much as who it is.
          expect(pulled.stdout, line).toContain(`url: ${elsewhere.url}`);
          expect(reached, line).toEqual([]);
        }
      }
    } finally {
      await workspace.remove();
    }
  });

  /**
   * The half-applied move, refused rather than acted on.
   *
   * Deleting the platform block is one edit; deleting the identifiers it was
   * keeping in place is four more. In between, the repository names no platform
   * and still holds every identifier the old one issued — and the step below
   * "names nothing" is now Egma's own platform. Without this refusal the next
   * command carries somebody else's identifiers to hosted Egma, which is the
   * one thing ADR-0008 exists to stop.
   *
   * It is refused on what is already on this machine, so no address is asked so
   * much as who it is — and it is refused **whichever of the three places named
   * that address.** The deleted line is the one that said which platform these
   * identifiers belong to, so once it is gone there is nowhere Egma can safely
   * send them, including somewhere a developer typed. `--url` is not an escape
   * from this; it is the flag somebody reaches for in the middle of the move.
   */
  it("refuses a folder holding identifiers from a platform it no longer names", async () => {
    /** The half-applied move: the binding gone, everything it held still here. */
    async function halfMoved(): Promise<Workspace> {
      const workspace = await makeWorkspace();
      await workspace.signIn(own.url, PLATFORM_KEY);
      await workspace.signIn(elsewhere.url, PLATFORM_KEY);
      await createEgmaFolder({
        repository: workspace.dir,
        config: {
          platform: { origin: elsewhere.url, instance: elsewhere.instanceId },
          agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
          connection: { name: "retell-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
          suite: { name: "first-suite", id: "sui_01K3XQ7M4E8YB2FVN0H9TZQWET" },
        },
      });
      // The one edit that unbinds it, and nothing else — somebody starting the
      // move at the wrong end of the list.
      await updateConfig(folderPathsIn(workspace.dir).config, { platform: null });
      return workspace;
    }

    // Every way a platform gets selected, and the same answer from both.
    for (const [how, args, extra] of [
      ["the built-in address", ["pull"], {}],
      ["--url", ["pull", "--url", own.url], {}],
    ] as const) {
      const workspace = await halfMoved();
      try {
        const before = own.records.length;
        const elsewhereBefore = elsewhere.records.length;
        const refused = await egma(workspace, [...args], {
          EGMA_TEST_DEFAULT_URL: own.url,
          ...extra,
        });

        expect(refused.code, how).toBe(4);
        expect(refused.stdout, how).toContain("status: refused");
        expect(refused.stderr, how).toContain("This repository names no Egma platform");
        expect(refused.stderr, how).toContain("agent, connection, suite");
        expect(refused.stderr, how).toContain("Nothing was sent");

        // Both ways out, because somebody who deleted that block by mistake is
        // not making the move at all and must not be told to throw away four
        // working identifiers to recover from a typo.
        expect(refused.stderr, how).toContain("put the platform: block back");
        expect(refused.stderr, how).toContain(
          "To move this repository to another platform, delete these in this order and run egma again:",
        );

        // Nothing reached the address Egma would have used, and nothing reached
        // the platform the identifiers came from either.
        expect(own.records.slice(before), how).toEqual([]);
        expect(elsewhere.records.slice(elsewhereBefore), how).toEqual([]);
      } finally {
        await workspace.remove();
      }
    }

    // The first way out: the block put back. It is a committed line, so this is
    // recovering a file from history rather than knowing something Egma hid.
    const restored = await halfMoved();
    try {
      await updateConfig(folderPathsIn(restored.dir).config, {
        platform: { origin: elsewhere.url, instance: elsewhere.instanceId },
      });
      const pulled = await egma(restored, ["pull"], { EGMA_TEST_DEFAULT_URL: own.url });
      expect(pulled.code, pulled.stderr).toBe(0);
      expect(pulled.stdout).toContain(`url: ${elsewhere.url}`);
    } finally {
      await restored.remove();
    }

    // The second: the identifiers taken out. That is also the shape `egma init`
    // leaves behind — a bare platform: line and three names with no ids under
    // them — which this must never refuse.
    const emptied = await halfMoved();
    try {
      const paths = folderPathsIn(emptied.dir);
      await updateConfig(paths.config, {
        agent: { name: "receptionist", id: null },
        connection: { name: "retell-1", id: null },
        suite: { name: "first-suite", id: null },
      });
      const pulled = await egma(emptied, ["pull"], { EGMA_TEST_DEFAULT_URL: own.url });
      expect(pulled.code, pulled.stderr).toBe(0);
      expect(pulled.stdout).toContain(`url: ${own.url}`);
    } finally {
      await emptied.remove();
    }
  });

  /**
   * The rule the whole binding exists for, now that there is something to fall
   * back to: a repository that named its platform is never quietly moved to
   * Egma's own, whatever is wrong with the one it named.
   */
  it("never falls back to Egma's own from a repository that is bound", async () => {
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
      // The platform standing where Egma's own address is saw nothing at all.
      expect(own.records.slice(before)).toEqual([]);
    } finally {
      await workspace.remove();
    }
  });
});
