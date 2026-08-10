/**
 * Two egmas, one repository: the check that closes the platform-binding ticket.
 *
 * Nothing here is a fixture of anything. Two whole platforms run as their own
 * processes — the real API entry point, over a real Postgres and a real
 * ClickHouse each, applying their own migrations on boot — and each mints its
 * own instance identifier because each has its own database. The command under
 * test is the built `egma`, started as a real process, once per step.
 *
 * What it proves, in one walk:
 *
 * - the two addresses a platform has — the one a developer types and the one it
 *   is configured with — settle into one, so the key and the binding can never
 *   name different strings;
 * - a machine holds a key for each platform, and neither login disturbs the
 *   other;
 * - the wizard writes the platform it signed in to into the committed file, and
 *   writes no credential with it;
 * - every later command in that repository finds that platform with nothing
 *   said on the command line, and the run address it prints is on it and
 *   carries no token;
 * - an explicit address naming the *other* platform is refused, and that
 *   platform's own log proves it was never told a single identifier;
 * - a bound platform that is down stops the command instead of falling back to
 *   Egma Cloud;
 * - and nothing either platform was told, and nothing either printed, holds a
 *   key.
 *
 * The steps share one repository and one pair of platforms and run in order:
 * they are one walk written as several claims, not several independent checks.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseConfig, updateConfig } from "../src/folder/egma-folder.ts";
import { registerAgent } from "../src/platform/agents.ts";
import {
  BOUND_ELSEWHERE_EXIT,
  PLATFORM_UNREACHABLE_EXIT,
} from "../src/platform/binding.ts";
import { RetellKey } from "../src/retell/key.ts";
import { startRealPlatform, type RealPlatform } from "./support/real-platform.ts";
import {
  CLI_ENTRY,
  FAKE_AGENT,
  MANIFEST,
  makeWorkspace,
  waitUntil,
  type Workspace,
} from "./support/workspace.ts";

const run = promisify(execFile);

// Two whole platforms, each migrating two stores on boot, and a wizard walk
// driving a scripted coding agent: generous, so only a broken walk reaches it.
const LONG = 180_000;

/** The Retell key the seeded connection is sealed with. Invented, and unused. */
const PRETEND_RETELL_KEY = "key_only_this_check_ever_uses";

let here: RealPlatform;
let elsewhere: RealPlatform;
let workspace: Workspace;
/** The key this machine holds for each platform, once login has minted it. */
const keys = new Map<string, string>();
/** What the repository ends up holding that only `here` knows about. */
const owned: string[] = [];

beforeAll(async () => {
  // One at a time. Both migrate two stores on boot, and the rest of the suite
  // is running beside them — two of those at once is a spike in a shared
  // Postgres that buys this check nothing.
  here = await startRealPlatform("bind_here");
  elsewhere = await startRealPlatform("bind_elsewhere");
  workspace = await makeWorkspace({ "package.json": MANIFEST });
}, LONG);

afterAll(async () => {
  await here?.close();
  await elsewhere?.close();
  await workspace?.remove();
});

type Result = { stdout: string; stderr: string; code: number };

/** Everything the command has printed in this walk, for the sweep at the end. */
const transcript: string[] = [];

async function egma(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env(env),
      // A login nobody approves polls until its code runs out, which is
      // minutes. Nothing here should ever take this long, and a command that
      // does is a failure to read rather than a suite to wait out.
      timeout: 90_000,
    });
    transcript.push(stdout, stderr);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    transcript.push(failure.stdout ?? "", failure.stderr ?? "");
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

function facts(stdout: string): Record<string, string> {
  const read: Record<string, string> = {};
  for (const line of stdout.trimEnd().split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) read[line.slice(0, at)] = line.slice(at + 2);
  }
  return read;
}

/**
 * Run a command that will stop to be approved, and approve it — which is what
 * the person in the browser does on a real login.
 *
 * The address egma really handed a browser is read out of the file the stand-in
 * browser writes, so what gets approved is what egma showed and not what this
 * check thinks it showed.
 */
async function approving<T>(
  platform: RealPlatform,
  cookie: string,
  work: (browser: { command: string; opened: string }) => Promise<T>,
): Promise<T> {
  const browser = await workspace.browser();
  // The stand-in appends, and this walk opens more than one login, so what is
  // waited for is the *next* address rather than any address.
  const already = await addressesOpened(browser.opened);

  const approve = (async () => {
    const found = await waitUntil(
      async () => (await addressesOpened(browser.opened)).length > already.length,
      60_000,
    );
    if (!found) return;
    const opened = (await addressesOpened(browser.opened)).at(-1) ?? "";
    const code = new URL(opened).searchParams.get("user_code") ?? "";
    await platform.approve(code, cookie);
  })();

  const answer = await work(browser);
  await approve;
  return answer;
}

/** Every address egma has handed the stand-in browser, in order. */
async function addressesOpened(file: string): Promise<readonly string[]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("user_code="));
  } catch {
    return [];
  }
}

function browserEnv(browser: { command: string; opened: string }): NodeJS.ProcessEnv {
  return {
    BROWSER: browser.command,
    FIXTURE_BROWSER_WRITES_TO: browser.opened,
    // The stand-in only writes the address down; approving is this check's own
    // job, because a real platform approves in a signed-in browser.
    FIXTURE_BROWSER_DOES: "nothing",
  };
}

describe("two platforms on one machine", () => {
  it("are two egmas, each with an identity of its own", () => {
    expect(here.instanceId).toMatch(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(elsewhere.instanceId).toMatch(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(here.instanceId).not.toBe(elsewhere.instanceId);
    // And each answers as an address that is not the one it is dialled at, so
    // nothing below can pass by the two strings happening to be equal.
    expect(here.canonicalOrigin).not.toBe(here.origin);
  });

  it("each mint this machine a key, and neither login replaces the other", async () => {
    for (const platform of [here, elsewhere]) {
      const cookie = await platform.signUp("ada@acme.example");
      const result = await approving(platform, cookie, (browser) =>
        egma(["login", "--url", platform.origin], browserEnv(browser)),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(facts(result.stdout).status).toBe("stored");
    }

    const held = JSON.parse(await readFile(workspace.credentialsFile, "utf8")) as {
      platforms: { url: string; key: string }[];
    };
    // Under the address each platform gave for itself — the one the binding
    // will name — and not under the address that was typed.
    expect(held.platforms.map((one) => one.url)).toEqual([
      here.canonicalOrigin,
      elsewhere.canonicalOrigin,
    ]);
    for (const one of held.platforms) keys.set(one.url, one.key);

    // Each key opens a door on the platform that minted it, and is refused by
    // the other — which is the reason a repository may not send one platform's
    // identifiers to the other in the first place.
    for (const [platform, other] of [
      [here, elsewhere],
      [elsewhere, here],
    ] as const) {
      const key = keys.get(platform.canonicalOrigin) ?? "";
      const asKeyholder = { authorization: `Bearer ${key}` };
      expect((await fetch(`${platform.origin}/api/keys`, { headers: asKeyholder })).status).toBe(200);
      expect((await fetch(`${other.origin}/api/keys`, { headers: asKeyholder })).status).toBe(401);
    }
  }, LONG);

  it("write the platform the wizard signed in to into the committed file", async () => {
    // A folder somebody already made, which is what a second developer cloning
    // the repository has. The binding lands in it as the wizard signs in.
    expect((await egma(["init", "--cwd", workspace.dir])).code).toBe(0);

    const script = await workspace.script({
      steps: [{ kind: "say", text: "Nothing to find here.\n" }, { kind: "stop", reason: "end_turn" }],
    });
    // Already signed in to this platform, so the walk needs no approval; it
    // stops where a scripted agent finds no voice agent.
    await egma([
      "--headless",
      "--cwd",
      workspace.dir,
      "--url",
      here.origin,
      "--",
      process.execPath,
      FAKE_AGENT,
      script,
    ]);

    const written = await readFile(path.join(workspace.dir, "egma", "config.yaml"), "utf8");
    expect(parseConfig(written, "config.yaml").platform).toEqual({
      origin: here.canonicalOrigin,
      instance: here.instanceId,
    });

    // Committed on purpose, and therefore never a credential.
    expect(written).not.toContain("egma_sk_");
    expect(written).not.toContain(keys.get(here.canonicalOrigin) ?? "no key");
  }, LONG);

  it("use the bound platform with nothing said, and print a run address on it", async () => {
    // What `connect` leaves behind: an agent and a way to reach it, on the
    // platform this repository is bound to. Registered through the same module
    // the wizard uses, so these are real identifiers minted by a real egma.
    const registered = await registerAgent(
      {
        name: "order-line",
        connection: {
          type: "retell",
          modality: "voice",
          config: { retellAgentId: "agent_0001" },
          credentials: RetellKey.from(PRETEND_RETELL_KEY) ?? undefined,
        },
      },
      { url: here.canonicalOrigin, key: keys.get(here.canonicalOrigin) ?? "" },
    );
    expect(registered.kind, JSON.stringify(registered)).toBe("registered");
    if (registered.kind !== "registered") return;

    const config = path.join(workspace.dir, "egma", "config.yaml");
    await updateConfig(config, {
      agent: { name: registered.registered.agent.name, id: registered.registered.agent.id },
      connection: {
        name: registered.registered.connection.name,
        id: registered.registered.connection.id,
      },
    });
    owned.push(registered.registered.agent.id, registered.registered.connection.id);

    await writeFile(
      path.join(workspace.dir, "egma", "tests", "asks-for-a-price.md"),
      [
        "---",
        "name: asks-for-a-price",
        "---",
        "## Scenario",
        "Somebody asks what a rebinding costs.",
        "## Expected behaviors",
        "1. The agent does not quote a price.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Nothing on the command says which egma. The repository does.
    const pushed = await egma(["push", "--cwd", workspace.dir]);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(facts(pushed.stdout).url).toBe(here.canonicalOrigin);

    const started = await egma(["run", "--cwd", workspace.dir, "--no-follow"]);
    expect(started.code, started.stderr).toBe(0);
    const said = facts(started.stdout);
    expect(said.url).toBe(here.canonicalOrigin);
    expect(said.status).toBe("started");

    // A run address on this platform, and one a person can paste anywhere: no
    // key, no token, no query at all.
    expect(said.results).toMatch(new RegExp(`^${here.canonicalOrigin}/runs/run_`, "u"));
    expect(said.results).not.toContain("?");
    expect(said.results).not.toContain(keys.get(here.canonicalOrigin) ?? "no key");
    owned.push(said.run as string);

    const version = parseConfig(await readFile(config, "utf8"), "config.yaml");
    expect(version.platform?.instance).toBe(here.instanceId);
  }, LONG);

  it("refuse the other platform outright, and tell it nothing", async () => {
    const before = elsewhere.pathsAsked().length;

    const named = await egma(["push", "--cwd", workspace.dir, "--url", elsewhere.origin]);
    expect(named.code).toBe(BOUND_ELSEWHERE_EXIT);
    expect(facts(named.stdout).status).toBe("bound-elsewhere");
    expect(facts(named.stdout).bound_to).toBe(`${here.canonicalOrigin} ${here.instanceId}`);
    expect(named.stderr).toContain("--url");
    expect(named.stderr).toContain(here.canonicalOrigin);

    const fromTheShell = await egma(["run", "--cwd", workspace.dir], {
      EGMA_URL: elsewhere.origin,
    });
    expect(fromTheShell.code).toBe(BOUND_ELSEWHERE_EXIT);
    expect(fromTheShell.stderr).toContain("EGMA_URL");

    // The proof, read off the other platform's own log: the only thing it was
    // ever asked is who it is. Not one identifier this repository holds
    // reached it, and no credentialed request was made against it.
    const asked = elsewhere.pathsAsked().slice(before);
    expect(asked.length).toBeGreaterThan(0);
    expect([...new Set(asked)]).toEqual(["/api/platform"]);
    for (const identifier of owned) {
      expect(elsewhere.log()).not.toContain(identifier);
    }
    expect(elsewhere.log()).not.toContain(keys.get(here.canonicalOrigin) ?? "no key");
  }, LONG);

  it("stop when the bound platform is down, and never fall back to Egma Cloud", async () => {
    await here.stop();
    const before = elsewhere.pathsAsked().length;

    const result = await egma(["push", "--cwd", workspace.dir]);

    expect(result.code).toBe(PLATFORM_UNREACHABLE_EXIT);
    expect(facts(result.stdout).status).toBe("unreachable");
    expect(facts(result.stdout).url).toBe(here.canonicalOrigin);
    expect(result.stderr).toContain(here.canonicalOrigin);
    expect(result.stderr).toContain("Egma Cloud");
    // And it did not quietly try the other egma on this machine either.
    expect(elsewhere.pathsAsked().slice(before)).toEqual([]);
  }, LONG);

  it("said nothing, anywhere, that holds a key", () => {
    // Every line either platform logged, and every line the command printed
    // across the whole walk, swept for both keys this machine now holds. The
    // committed file is checked where it is written; this is the rest of it.
    const secrets = [...keys.values()];
    expect(secrets).toHaveLength(2);

    for (const secret of secrets) {
      expect(here.log(), "the bound platform's log").not.toContain(secret);
      expect(elsewhere.log(), "the other platform's log").not.toContain(secret);
      expect(transcript.join("\n"), "what the command printed").not.toContain(secret);
    }
  });
});
