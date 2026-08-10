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
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCredentialsFor } from "../src/platform/credentials.ts";
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

/**
 * Say, in the repository, which egma it belongs to — what the wizard writes
 * after its first login, and the only thing a later command reads it from.
 */
async function bindWorkspaceTo(named: Platform): Promise<void> {
  await mkdir(path.join(workspace.dir, "egma", "tests"), { recursive: true });
  await writeFile(
    path.join(workspace.dir, "egma", "config.yaml"),
    ["platform:", `  origin: ${named.url}`, `  instance: ${named.identity.instanceId}`, ""].join(
      "\n",
    ),
    "utf8",
  );
}

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
    expect(said.code).toMatch(/^[A-Z0-9]{8}$/u);
    expect(said.approve_url).toContain(platform.url);
    expect(said.approve_url).toContain(encodeURIComponent(said.code as string));
    expect(said.browser).toBe("opened");
    expect(said.status).toBe("stored");
    expect(said.credentials).toBe(workspace.credentialsFile);

    // The address egma handed the browser is the address it printed.
    expect((await readFile(browser.opened, "utf8")).trim()).toBe(said.approve_url);

    // The key is on disk, and nobody else on the machine can read it.
    const held = await readCredentialsFor(workspace.credentialsFile, platform.url);
    expect(held?.url).toBe(platform.url);
    expect(held?.key).toBe(platform.device.keys.at(-1));
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");

    // And it works on a request that needs one.
    const used = await fetch(`${platform.url}/api/keys`, {
      headers: { authorization: `Bearer ${held?.key ?? ""}` },
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

  it("is said once: the repository keeps the address, so later commands do not", async () => {
    // A self-hoster names it once, for one shell.
    const first = await egma(["login"], { EGMA_URL: platform.url });
    expect(first.code).toBe(0);
    expect(facts(first.stdout).status).toBe("stored");

    // The repository this walk is in says which egma it belongs to — which is
    // what the wizard writes there, and what a machine's own last login is
    // deliberately never allowed to say.
    await bindWorkspaceTo(platform);

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
    const again = await egma(["login", "--force", "--url", platform.url]);

    expect(again.code).toBe(0);
    expect(facts(again.stdout).status).toBe("stored");
    expect(platform.device.keys).toHaveLength(2);

    const held = await readCredentialsFor(workspace.credentialsFile, platform.url);
    expect(held?.key).toBe(platform.device.keys.at(-1));
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

  it("answers 4 and says so in egma's own words when egma refuses", async () => {
    // A refusal is not a silence, and the help says so: 4 is both.
    platform.device.answerTokenWith(
      "invalid_grant",
      "this authorization was approved without naming an organization and a project, so there is nothing to mint a key for. Start again from the terminal.",
    );

    const result = await egma(["login", "--url", platform.url]);

    expect(result.code).toBe(4);
    const said = facts(result.stdout);
    expect(said.status).toBe("refused");
    expect(said.reason).toBe(
      "egma would not mint a key for this login. Start again from the terminal.",
    );
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
  });

  /**
   * The words a terminal never says, held against every way a login can end.
   *
   * A new account is signed up in the browser page and gets everything it needs
   * there. What egma set up is never named out here — locked rule. The real
   * instance's own `error_description` says both words, so each refusal it can
   * answer with is played back through the fixture in its own words, and none
   * of them may reach a screen.
   */
  describe("never says the words a terminal does not say", () => {
    const BANNED = ["organization", "organisation", "project", "tenant"];

    /** What the real API answers, code and description, copied from it. */
    const refusals = [
      {
        named: "access_denied",
        error: "access_denied",
        said: "this was denied in the browser",
      },
      {
        named: "expired_token",
        error: "expired_token",
        said: "this authorization is over",
      },
      {
        named: "invalid_grant, aimed at nothing",
        error: "invalid_grant",
        said: "this authorization was approved without naming an organization and a project, so there is nothing to mint a key for. Start again from the terminal.",
      },
      {
        named: "invalid_grant, whoever approved it has gone",
        error: "invalid_grant",
        said: "the person who approved this is no longer in that organization",
      },
      {
        named: "invalid_grant, what it was aimed at has gone",
        error: "invalid_grant",
        said: "the project this terminal was authorized for is gone. Start again from the terminal.",
      },
      {
        named: "unsupported_grant_type",
        error: "unsupported_grant_type",
        said: "this endpoint understands urn:ietf:params:oauth:grant-type:device_code and nothing else",
      },
      {
        named: "a refusal egma has never sent before",
        error: "not_permitted",
        said: "this role may not mint a key for that project in that organization",
      },
    ];

    it("on the way through a login that works", async () => {
      const result = await egma(["login", "--url", platform.url]);
      for (const banned of BANNED) {
        expect(
          new RegExp(`\\b${banned}`, "iu").test(result.stdout + result.stderr),
          `the command says "${banned}"`,
        ).toBe(false);
      }
    });

    for (const refusal of refusals) {
      it(`when egma answers ${refusal.named}`, async () => {
        platform.device.answerTokenWith(refusal.error, refusal.said);

        const result = await egma(["login", "--url", platform.url]);

        // It ended somehow, and nothing it printed came from the instance.
        expect(result.code).not.toBe(0);
        const shown = result.stdout + result.stderr;
        expect(shown).not.toContain(refusal.said);
        for (const banned of BANNED) {
          expect(
            new RegExp(`\\b${banned}`, "iu").test(shown),
            `the command says "${banned}" on ${refusal.error}`,
          ).toBe(false);
        }
      });
    }
  });

  it("is offered in the help, with what it prints and what it answers", async () => {
    const help = await egma(["--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("egma login");
    expect(help.stdout).toContain("--url <address>");
    expect(help.stdout).toContain("approve_url");
    expect(help.stdout).toContain("2 denied");
    // 4 is both an egma that never answered and one that said no, and the help
    // says both rather than only the one that reads better.
    expect(help.stdout).toContain("4 egma did not answer, or refused");
  });

  it("names the two things a self-hoster sets, in the help", async () => {
    const help = await egma(["--help"]);

    expect(help.stdout).toContain("EGMA_URL");
    expect(help.stdout).toContain("EGMA_HOME");
    expect(help.stdout).toContain("--force");
  });

  it("refuses an address that is not one, before it starts anything", async () => {
    const result = await egma(["login", "--url", "javascript:alert(1)"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("http:// or https://");
    // Nothing was asked of anything: the address was turned away at the door.
    expect(platform.records).toHaveLength(0);
    expect((await readFile(browser.opened, "utf8").catch(() => ""))).toBe("");
  });
});
