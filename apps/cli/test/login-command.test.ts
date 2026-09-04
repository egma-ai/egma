/**
 * `egma login` as a coding agent runs it: the built command, in a real
 * subprocess, against a fixture of egma's public HTTP API.
 *
 * Nothing here is a terminal and nothing here answers a question, because the
 * whole promise of the verb is that neither is needed. What is asserted is the
 * two things something driving it can act on: the prose it prints and the
 * number it exits with.
 */

import { execFile, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCredentials } from "../src/platform/credentials.ts";
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

function valueAfter(stdout: string, label: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(label));
  if (line === undefined) throw new Error(`Missing ${label} in:\n${stdout}`);
  return line.slice(label.length);
}

describe("egma login", () => {
  it("signs the machine in with no terminal, no keystroke and no question", async () => {
    const result = await egma(["login", "--url", platform.url]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Signing in to ${platform.url}.`);
    expect(result.stdout).toContain("Approve this login in your browser.");
    const code = valueAfter(result.stdout, "Code: ");
    const approvalUrl = valueAfter(result.stdout, "Approval URL: ");
    expect(code).toMatch(/^[A-Z0-9]{8}$/u);
    expect(approvalUrl).toContain(platform.url);
    expect(approvalUrl).toContain(encodeURIComponent(code));
    expect(result.stdout).toContain("The approval page was opened in your browser.");
    expect(result.stdout).toContain(`Login saved in ${workspace.credentialsFile}.`);
    expect(result.stdout).not.toContain("status:");

    // The address egma handed the browser is the address it printed.
    expect((await readFile(browser.opened, "utf8")).trim()).toBe(approvalUrl);

    // The key is on disk, and nobody else on the machine can read it.
    const held = await readCredentials(workspace.credentialsFile, platform.url);
    expect(held).not.toBeNull();
    if (held === null) throw new Error("login did not store credentials");
    expect(held.url).toBe(platform.url);
    expect(held.key).toBe(platform.device.keys.at(-1));
    expect(held.login).toEqual({
      apiKeyId: expect.stringMatching(/^ak_/u),
      projectId: platform.projectId,
    });
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");

    // And it works on a request that needs one.
    const used = await fetch(`${platform.url}/v1/keys`, {
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
    expect(stdout).toContain(`Login saved in ${workspace.credentialsFile}.`);
  });

  it.each(["/api/device/code", "/api/device/token"])(
    "returns 130 when Ctrl-C interrupts a pending %s request",
    async (heldPath) => {
      let interrupt: (() => void) | undefined;
      const server = createServer((request, answer) => {
        request.resume();
        if (request.url === heldPath) {
          interrupt?.();
          return;
        }
        if (request.url === "/api/device/code") {
          const address = server.address() as AddressInfo;
          answer.writeHead(200, { "content-type": "application/json" });
          answer.end(
            JSON.stringify({
              device_code: "device-code-for-interrupt",
              user_code: "ABCD1234",
              verification_uri_complete: `http://127.0.0.1:${address.port}/device?user_code=ABCD1234`,
              expires_in: 900,
              interval: 0,
            }),
          );
          return;
        }
        answer.writeHead(404, { "content-type": "application/json" });
        answer.end(JSON.stringify({ error: "not_found" }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;

      try {
        const result = await new Promise<{
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
          readonly stdout: string;
          readonly stderr: string;
        }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [CLI_ENTRY, "login", "--url", url],
            {
              cwd: workspace.dir,
              env: workspace.env({ BROWSER: "/usr/bin/true" }),
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
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
          interrupt = () => child.kill("SIGINT");

          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`egma did not stop while ${heldPath} was pending`));
          }, 5_000);
          child.on("error", reject);
          child.on("close", (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stdout, stderr });
          });
        });

        expect(result.signal).toBeNull();
        expect(result.code).toBe(130);
        expect(result.stderr).toContain(
          "The login was stopped before it finished. Nothing was stored.",
        );
        await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("returns 130 when Ctrl-C interrupts the token response body", async () => {
    let interrupt: (() => void) | undefined;
    const server = createServer((request, answer) => {
      request.resume();
      if (request.url === "/api/device/code") {
        const address = server.address() as AddressInfo;
        answer.writeHead(200, { "content-type": "application/json" });
        answer.end(
          JSON.stringify({
            device_code: "device-code-for-body-interrupt",
            user_code: "BODY1234",
            verification_uri_complete: `http://127.0.0.1:${address.port}/device?user_code=BODY1234`,
            expires_in: 900,
            interval: 0,
          }),
        );
        return;
      }
      if (request.url === "/api/device/token") {
        answer.writeHead(200, { "content-type": "application/json" });
        answer.flushHeaders();
        interrupt?.();
        return;
      }
      answer.writeHead(404, { "content-type": "application/json" });
      answer.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;

    try {
      const result = await new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
        readonly stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_ENTRY, "login", "--url", url], {
          cwd: workspace.dir,
          env: workspace.env({ BROWSER: "/usr/bin/true" }),
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        interrupt = () => child.kill("SIGINT");

        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("egma did not stop while the token body was pending"));
        }, 5_000);
        child.on("error", reject);
        child.on("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, stderr });
        });
      });

      expect(result.signal).toBeNull();
      expect(result.code).toBe(130);
      expect(result.stderr).toContain(
        "The login was stopped before it finished. Nothing was stored.",
      );
      expect(result.stderr).not.toContain("Egma refused this login");
      await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not use the most recent login as the next command's target", async () => {
    // A self-hoster selects the platform for this command.
    const first = await egma(["login", "--url", platform.url]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(`Login saved in ${workspace.credentialsFile}.`);

    // The held key does not choose a platform. Name the platform again because
    // this repository is not bound by the standalone login command.
    const second = await egma(["login", "--url", platform.url]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`Signing in to ${platform.url}.`);
    expect(second.stdout).toContain("This machine is already signed in.");

    // Nothing was approved the second time, because nothing needed to be.
    expect(platform.records.filter((seen) => seen.path === "/api/device/code")).toHaveLength(1);
    expect((await readFile(browser.opened, "utf8")).trimEnd().split("\n")).toHaveLength(1);
  });

  it("refuses the removed --force option and keeps the saved login", async () => {
    await egma(["login", "--url", platform.url]);
    const recordsBefore = platform.records.length;
    const heldBefore = await readCredentials(
      workspace.credentialsFile,
      platform.url,
    );
    const again = await egma(["login", "--url", platform.url, "--force"]);

    expect(again.code).toBe(1);
    expect(again.stdout).toBe("");
    expect(again.stderr).toContain("--force");
    expect(platform.records).toHaveLength(recordsBefore);
    expect(
      await readCredentials(workspace.credentialsFile, platform.url),
    ).toEqual(heldBefore);
  });

  it("answers 1 when the login is denied, and stores nothing", async () => {
    const result = await egma(["login", "--url", platform.url], {
      FIXTURE_BROWSER_DOES: "deny",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("status:");
    expect(result.stderr).toContain("The login was denied in the browser.");
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
  });

  it("answers 1 when the code runs out, which is not being told no", async () => {
    const result = await egma(["login", "--url", platform.url], {
      FIXTURE_BROWSER_DOES: "expire",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nobody approved the login before the code ran out.");
    await expect(readFile(workspace.credentialsFile, "utf8")).rejects.toThrow();
  });

  it("answers 1 and names the address when egma does not answer", async () => {
    // Nothing listens here, and the address is in the message rather than in a
    // stack trace.
    const result = await egma(["login", "--url", "http://127.0.0.1:1"]);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("status:");
    expect(result.stderr).toContain("127.0.0.1:1");
  });

  it("answers 1 and says so in egma's own words when egma refuses", async () => {
    platform.device.answerTokenWith(
      "invalid_grant",
      "this authorization was approved without naming an organization and a project, so there is nothing to mint a key for. Start again from the terminal.",
    );

    const result = await egma(["login", "--url", platform.url]);

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("status:");
    expect(result.stderr).toContain(
      "Egma would not mint a key for this login. Start again from the terminal.",
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
        named: "a refusal Egma has never sent before",
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
    const help = await egma(["login", "--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("egma login");
    expect(help.stdout).toContain("--url <address>");
    expect(help.stdout).toContain("approval URL");
    expect(help.stdout).toContain("Exit 0 means signed in");
    expect(help.stdout).toContain("1 means sign-in did not complete");
    expect(help.stdout).toContain("130 means interrupted");
  });

  it("names what a self-hoster sets, in the help", async () => {
    const help = await egma(["login", "--help"]);

    // Which egma is said on the command and nowhere else, so the flag is the
    // whole of that half. What is left in the environment is where the key it
    // brings back is kept.
    expect(help.stdout).toContain("--url <address>");
    expect(help.stdout).toContain("EGMA_HOME");
    expect(help.stdout).not.toContain("--force");
  });

  it("refuses an address that is not one, before it starts anything", async () => {
    const result = await egma(["login", "--url", "javascript:alert(1)"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("http:// or https://");
    // Nothing was asked of anything: the address was turned away at the door.
    expect(platform.records).toHaveLength(0);
    expect((await readFile(browser.opened, "utf8").catch(() => ""))).toBe("");
  });

  it("never repeats a supplied password from an invalid platform URL", async () => {
    const suppliedSecret = "supplied-password-must-stay-private";
    const result = await egma([
      "login",
      "--url",
      `https://person:${suppliedSecret}@egma.example`,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(suppliedSecret);
    expect(result.stderr).toContain("--url");
    expect(platform.records).toHaveLength(0);
  });
});
