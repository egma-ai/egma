/**
 * `egma login` as a coding agent runs it: the built command, in a real
 * subprocess, against a fixture of egma's public HTTP API.
 *
 * Nothing here is a terminal and nothing here answers a question, because the
 * whole promise of the verb is that neither is needed. What is asserted is the
 * two things something driving it can act on: the lines it prints and the
 * number it exits with.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

const run = promisify(execFile);

let platform: Platform;
let workspace: Workspace;
let browser: { command: string; opened: string };

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace();
  browser = await workspace.browser();
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

type Result = { stdout: string; stderr: string; code: number };

async function egma(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_ENTRY, ...args], {
      cwd: workspace.dir,
      env: workspace.env({
        BROWSER: browser.command,
        FIXTURE_BROWSER_WRITES_TO: browser.opened,
        ...env,
      }),
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

describe("egma login", () => {
  it("signs the machine in with no terminal, no keystroke and no question", async () => {
    const result = await egma(["login", "--url", platform.url]);

    expect(result.code).toBe(0);
    const said = facts(result.stdout);

    // Everything something driving this needs, one fact per line.
    expect(said.url).toBe(platform.url);
    expect(said.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(said.approve_url).toContain(platform.url);
    expect(said.approve_url).toContain(encodeURIComponent(said.code as string));
    expect(said.browser).toBe("opened");
    expect(said.status).toBe("stored");
    expect(said.credentials).toBe(workspace.credentialsFile);

    // The address egma handed the browser is the address it printed.
    expect((await readFile(browser.opened, "utf8")).trim()).toBe(said.approve_url);

    // The key is on disk, and nobody else on the machine can read it.
    const held = JSON.parse(await readFile(workspace.credentialsFile, "utf8")) as {
      url: string;
      key: string;
    };
    expect(held.url).toBe(platform.url);
    expect(held.key).toBe(platform.device.keys.at(-1));
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");

    // And it works on a request that needs one.
    const used = await fetch(`${platform.url}/api/keys`, {
      headers: { authorization: `Bearer ${held.key}` },
    });
    expect(used.status).toBe(200);
  });

  it("finishes with no standard input at all, which is what promptless means", async () => {
    // Not a terminal and not even a pipe: there is nothing here to read a
    // keystroke from, so a command that asked anything could not finish.
    const child = spawn(process.execPath, [CLI_ENTRY, "login", "--url", platform.url], {
      cwd: workspace.dir,
      env: workspace.env({
        BROWSER: browser.command,
        FIXTURE_BROWSER_WRITES_TO: browser.opened,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const code = await new Promise<number>((resolve) => {
      child.on("close", (value) => resolve(value ?? 0));
    });

    expect(code).toBe(0);
    expect(facts(stdout).status).toBe("stored");
  });

  it("keeps the address it was given, so later commands never repeat it", async () => {
    // A self-hoster sets it once, for one shell.
    const first = await egma(["login"], { EGMA_URL: platform.url });
    expect(first.code).toBe(0);
    expect(facts(first.stdout).status).toBe("stored");

    // And the next command finds it with nothing said at all: no flag, and the
    // variable gone from the environment.
    const second = await egma(["login"]);
    expect(second.code).toBe(0);
    const said = facts(second.stdout);
    expect(said.url).toBe(platform.url);
    expect(said.status).toBe("already-stored");

    // Nothing was approved the second time, because nothing needed to be.
    expect(platform.records.filter((seen) => seen.path === "/api/device/code")).toHaveLength(1);
    expect((await readFile(browser.opened, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("signs in again when told to, even though a key is already held", async () => {
    await egma(["login", "--url", platform.url]);
    const again = await egma(["login", "--force"]);

    expect(again.code).toBe(0);
    expect(facts(again.stdout).status).toBe("stored");
    expect(platform.device.keys).toHaveLength(2);

    const held = JSON.parse(await readFile(workspace.credentialsFile, "utf8")) as { key: string };
    expect(held.key).toBe(platform.device.keys.at(-1));
  });

  it("answers 2 when the login is denied, and stores nothing", async () => {
    const result = await egma(["login", "--url", platform.url], {
      FIXTURE_BROWSER_DOES: "deny",
    });

    expect(result.code).toBe(2);
    expect(facts(result.stdout).status).toBe("denied");
    expect(result.stderr).toContain("denied");
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
  });

  it("answers 3 when the code runs out, which is not being told no", async () => {
    const result = await egma(["login", "--url", platform.url], {
      FIXTURE_BROWSER_DOES: "expire",
    });

    expect(result.code).toBe(3);
    expect(facts(result.stdout).status).toBe("expired");
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
  });

  it("answers 4 and names the address when egma does not answer", async () => {
    // Nothing listens here, and the address is in the message rather than in a
    // stack trace.
    const result = await egma(["login", "--url", "http://127.0.0.1:1"]);

    expect(result.code).toBe(4);
    const said = facts(result.stdout);
    expect(said.status).toBe("unreachable");
    expect(said.reason).toContain("127.0.0.1:1");
    expect(result.stderr).toContain("127.0.0.1:1");
  });

  it("never says the words a terminal does not say", async () => {
    const result = await egma(["login", "--url", platform.url]);

    // A new account is signed up in the browser page and gets everything it
    // needs there. What egma set up is never named out here — locked rule.
    for (const banned of ["organization", "organisation", "project", "tenant"]) {
      expect(
        new RegExp(`\\b${banned}`, "iu").test(result.stdout + result.stderr),
        `the command says "${banned}"`,
      ).toBe(false);
    }
  });

  it("is offered in the help, with what it prints and what it answers", async () => {
    const help = await egma(["--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("egma login");
    expect(help.stdout).toContain("--url <address>");
    expect(help.stdout).toContain("approve_url");
    expect(help.stdout).toContain("2 denied");
  });
});
