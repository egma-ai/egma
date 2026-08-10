/**
 * Which egma a repository belongs to, held against the built command.
 *
 * Every check here runs `egma` as a real process against fixtures of egma's
 * public HTTP API — two of them, because the whole claim is about telling two
 * platforms apart. What is asserted is what a developer could check afterwards:
 * what the committed file says, which platform was spoken to, what the terminal
 * printed, and the number the command exited with.
 *
 * The proof that closes the ticket is `binding-across-platforms.test.ts`, which
 * does this against two real API instances. This file is the floor under it:
 * the branches that are cheap to hold here, held here, so a change that breaks
 * one of them fails in a second rather than in a minute.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BOUND_ELSEWHERE_EXIT,
  PLATFORM_UNREACHABLE_EXIT,
} from "../src/platform/binding.ts";
import { parseConfig } from "../src/folder/egma-folder.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, FAKE_AGENT, MANIFEST, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

let here: Platform;
let elsewhere: Platform;
let workspace: Workspace;

beforeEach(async () => {
  here = await startPlatform();
  elsewhere = await startPlatform();
  workspace = await makeWorkspace({ "package.json": MANIFEST });
});

afterEach(async () => {
  await here.close();
  await elsewhere.close();
  await workspace.remove();
});

type Result = { stdout: string; stderr: string; code: number };

async function egma(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(env),
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/** The printed lines, read the way something driving the command reads them. */
function facts(stdout: string): Record<string, string> {
  const read: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) read[line.slice(0, at)] = line.slice(at + 2);
  }
  return read;
}

/** The folder a `connect` would have left: ids, and the platform they are on. */
async function repositoryOn(
  platform: Platform,
  ids: { readonly agent: string; readonly connection: string } = {
    agent: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER",
    connection: "con_01K3XQ7M4E8YB2FVN0H9TZQWES",
  },
): Promise<void> {
  await mkdir(path.join(workspace.dir, "egma", "tests"), { recursive: true });
  await writeFile(
    path.join(workspace.dir, "egma", "config.yaml"),
    [
      "platform:",
      `  origin: ${platform.url}`,
      `  instance: ${platform.identity.instanceId}`,
      "agent:",
      "  name: order-line",
      `  id: ${ids.agent}`,
      "connection:",
      "  name: retell-1",
      `  id: ${ids.connection}`,
      "suite:",
      "  name: first-suite",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("writing the binding", () => {
  it("names the platform the wizard signed in to, and no key with it", async () => {
    const browser = await workspace.browser();
    // A folder somebody already made — `egma init`, or a clone of a repository
    // that had one. The binding lands in it the moment the wizard signs in.
    await egma(["init", "--cwd", workspace.dir]);

    const script = await workspace.script({
      steps: [{ kind: "say", text: "Nothing here.\n" }, { kind: "stop", reason: "end_turn" }],
    });
    await egma(
      [
        "--headless",
        "--cwd",
        workspace.dir,
        "--url",
        here.url,
        "--",
        process.execPath,
        FAKE_AGENT,
        script,
      ],
      { BROWSER: browser.command, FIXTURE_BROWSER_WRITES_TO: browser.opened },
    );

    const written = await readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8");
    expect(parseConfig(written, "config.yaml").platform).toEqual({
      origin: here.url,
      instance: here.identity.instanceId,
    });

    // Committed, and therefore never a credential. The key is in the home
    // folder, keyed by the same origin.
    expect(written).not.toContain("egma_sk_");
    expect(JSON.parse(await readFile(workspace.credentialsFile, "utf8"))).toMatchObject({
      platforms: [{ url: here.url }],
    });
  });
});

describe("a bound repository", () => {
  it("finds its platform with nothing said on the command", async () => {
    await repositoryOn(here);
    await workspace.signIn(here.url, here.device.mint());

    const result = await egma(["pull", "--cwd", workspace.dir]);

    expect(result.code).toBe(0);
    expect(facts(result.stdout).url).toBe(here.url);
    // And the other platform was never asked anything at all.
    expect(elsewhere.records).toHaveLength(0);
  });

  it("refuses an explicit address that is a different egma, and sends it nothing", async () => {
    await repositoryOn(here);
    await workspace.signIn(elsewhere.url, elsewhere.device.mint());

    const result = await egma(["push", "--cwd", workspace.dir, "--url", elsewhere.url]);

    expect(result.code).toBe(BOUND_ELSEWHERE_EXIT);
    expect(facts(result.stdout).status).toBe("bound-elsewhere");
    expect(facts(result.stdout).bound_to).toBe(`${here.url} ${here.identity.instanceId}`);
    expect(result.stderr).toContain(here.url);
    expect(result.stderr).toContain("--url");

    // The whole point: the other platform heard the one question that names
    // nothing — who are you — and not one identifier.
    expect(elsewhere.records.map((one) => one.path)).toEqual(["/api/platform"]);
  });

  it("refuses an environment address that is a different egma", async () => {
    await repositoryOn(here);

    const result = await egma(["run", "--cwd", workspace.dir], { EGMA_URL: elsewhere.url });

    expect(result.code).toBe(BOUND_ELSEWHERE_EXIT);
    expect(result.stderr).toContain("EGMA_URL");
    expect(elsewhere.records.map((one) => one.path)).toEqual(["/api/platform"]);
  });

  it("refuses when its own platform has been replaced by another egma", async () => {
    await repositoryOn(here);
    await workspace.signIn(here.url, here.device.mint());
    const bound = here.identity.instanceId;

    // The same address, a different egma behind it: a fresh deployment, or the
    // same one on a new database. An origin alone could never catch this.
    const now = here.identity.becomeAnother();

    const result = await egma(["push", "--cwd", workspace.dir]);

    expect(result.code).toBe(BOUND_ELSEWHERE_EXIT);
    expect(result.stderr).toContain(bound);
    expect(result.stderr).toContain(now);
    expect(here.records.map((one) => one.path)).toEqual(["/api/platform"]);
  });

  it("stops when its platform is down, and never falls back to Egma Cloud", async () => {
    await repositoryOn(here);
    await workspace.signIn(here.url, here.device.mint());
    const origin = here.url;
    await here.close();

    const result = await egma(["run", "--cwd", workspace.dir]);

    expect(result.code).toBe(PLATFORM_UNREACHABLE_EXIT);
    expect(facts(result.stdout).status).toBe("unreachable");
    expect(facts(result.stdout).url).toBe(origin);
    expect(result.stderr).toContain(origin);
    expect(result.stderr).toContain("Egma Cloud");
  });

  it("still makes a folder when its platform is down, because init talks to nobody", async () => {
    await repositoryOn(here);
    await here.close();

    const result = await egma(["init", "--cwd", workspace.dir]);

    expect(result.code).toBe(0);
  });
});

describe("an unbound repository", () => {
  it("uses the address it was given and is refused nothing", async () => {
    await workspace.signIn(here.url, here.device.mint());
    await egma(["init", "--cwd", workspace.dir]);

    const result = await egma(["pull", "--cwd", workspace.dir, "--url", here.url]);

    expect(result.code).toBe(0);
    expect(facts(result.stdout).url).toBe(here.url);
  });

  it("is not aimed by whatever this machine signed in to last", async () => {
    // A key for one egma, and a repository that names none: the command goes
    // to Egma Cloud, not to the egma whose key happens to be on this machine.
    await workspace.signIn(here.url, here.device.mint());
    await egma(["init", "--cwd", workspace.dir]);

    const result = await egma(["pull", "--cwd", workspace.dir]);

    expect(facts(result.stdout).url).toBe("https://app.egma.ai");
    expect(here.records).toHaveLength(0);
  });
});

describe("the keys this machine holds", () => {
  it("are one per egma, so signing in to a second keeps the first", async () => {
    const browser = await workspace.browser();
    const env = { BROWSER: browser.command, FIXTURE_BROWSER_WRITES_TO: browser.opened };

    expect((await egma(["login", "--url", here.url], env)).code).toBe(0);
    expect((await egma(["login", "--url", elsewhere.url], env)).code).toBe(0);

    const held = JSON.parse(await readFile(workspace.credentialsFile, "utf8")) as {
      platforms: { url: string; key: string }[];
    };
    expect(held.platforms.map((one) => one.url)).toEqual([here.url, elsewhere.url]);

    // Each key opens a door on the platform that minted it and on no other.
    for (const [platform, other] of [
      [here, elsewhere],
      [elsewhere, here],
    ] as const) {
      const key = held.platforms.find((one) => one.url === platform.url)?.key ?? "";
      expect(platform.device.keys).toContain(key);
      expect(other.device.keys).not.toContain(key);
    }
  });
});
