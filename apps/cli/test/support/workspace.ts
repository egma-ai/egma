/**
 * A throwaway folder for a test to run a walk inside, and the fake agent that
 * gets driven in it.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DrivenAgentLaunch } from "../../src/acp/registry.ts";
import type { FakeScript } from "./fake-agent.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

/** The stand-in browser a workspace wraps in a command of its own. */
export const APPROVING_BROWSER = fileURLToPath(
  new URL("./approving-browser.ts", import.meta.url),
);

/** The file a workspace is given so the walk has something to read. */
export const MANIFEST = JSON.stringify({ name: "customer-repo", version: "1.0.0" }, null, 2);

export const CLI_ENTRY = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export const PRETEND_OLD_NODE = fileURLToPath(
  new URL("./pretend-old-node.ts", import.meta.url),
);

export type Workspace = {
  readonly dir: string;
  /**
   * The egma folder this workspace's runs use, inside the throwaway directory.
   *
   * Every check that starts the command hands this over, so no check anywhere
   * can read or write the credentials of the person running the suite.
   */
  readonly egmaFolder: string;
  /** The credentials file inside it. */
  readonly credentialsFile: string;
  /** What the command is given so it looks there and nowhere else. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Puts a key in that folder, as a login would have. */
  signIn(url: string, key?: string): Promise<void>;
  /**
   * A stand-in browser to point `BROWSER` at, and the file it writes every
   * address egma hands it into.
   */
  browser(): Promise<{ readonly command: string; readonly opened: string }>;
  /** Writes a script and answers the path to it. */
  script(script: FakeScript): Promise<string>;
  /** How egma would be told to start the fake agent with that script. */
  launch(scriptPath: string): DrivenAgentLaunch;
  remove(): Promise<void>;
};

/**
 * A browser that opens nothing.
 *
 * The command is handed one, rather than none, because the code that starts a
 * browser is part of what is being checked — and a check that started a real
 * browser on the machine running it would be intolerable.
 */
export const NO_BROWSER = "/usr/bin/true";

export async function makeWorkspace(
  files: Readonly<Record<string, string>> = {},
): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-cli-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }

  const egmaFolder = path.join(dir, "egma-home");
  const credentialsFile = path.join(egmaFolder, "credentials");

  let scripts = 0;
  return {
    dir,
    egmaFolder,
    credentialsFile,
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        EGMA_HOME: egmaFolder,
        BROWSER: NO_BROWSER,
        ...extra,
      };
      // Whatever the person running the suite has set, a check talks to the
      // egma it is checking against and to nothing else. Removed rather than
      // set to nothing: a pseudo-terminal turns an unset value into the word.
      if (extra.EGMA_URL === undefined) delete env.EGMA_URL;
      return env;
    },
    async signIn(url, key = "egma_sk_already-held") {
      await mkdir(egmaFolder, { recursive: true, mode: 0o700 });
      await writeFile(credentialsFile, `${JSON.stringify({ url, key })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    async browser() {
      // `BROWSER` names one command, exactly as it does for every other tool
      // that honours it, so the stand-in is a command rather than a command
      // line.
      const command = path.join(dir, "stand-in-browser");
      const opened = path.join(dir, "addresses-opened.txt");
      await writeFile(
        command,
        `#!/bin/sh\nexec '${process.execPath}' '${APPROVING_BROWSER}' "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      await chmod(command, 0o755);
      return { command, opened };
    },
    async script(script) {
      scripts += 1;
      const file = path.join(dir, `.fake-agent-${scripts}.json`);
      await writeFile(file, JSON.stringify(script), "utf8");
      return file;
    },
    launch(scriptPath) {
      return {
        id: "fake-agent",
        name: "Fake Agent",
        command: process.execPath,
        args: [FAKE_AGENT, scriptPath],
        env: {},
      };
    },
    async remove() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** True while the process is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
