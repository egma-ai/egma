/**
 * A throwaway folder for a test to run a walk inside, and the fake agent that
 * gets driven in it.
 */

import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DrivenAgentLaunch } from "../../src/acp/registry.ts";
import type { FakeScript } from "./fake-agent.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

/**
 * A small repository shaped like a Retell voice agent, committed so CI has one.
 *
 * Every word of it is invented: a bookbinding workshop that does not exist,
 * with prompts and tools written for this test and nowhere else.
 */
export const RETELL_FIXTURE_REPO = fileURLToPath(
  new URL("../fixtures/retell-agent", import.meta.url),
);

/** The file a workspace is given so the walk has something to read. */
export const MANIFEST = JSON.stringify({ name: "customer-repo", version: "1.0.0" }, null, 2);

export const CLI_ENTRY = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export const PRETEND_OLD_NODE = fileURLToPath(
  new URL("./pretend-old-node.ts", import.meta.url),
);

export type Workspace = {
  readonly dir: string;
  /** Writes a script and answers the path to it. */
  script(script: FakeScript): Promise<string>;
  /** How egma would be told to start the fake agent with that script. */
  launch(scriptPath: string): DrivenAgentLaunch;
  remove(): Promise<void>;
};

export type WorkspaceOptions = {
  /** A folder copied in whole before anything else, e.g. a fixture repository. */
  readonly from?: string;
};

export async function makeWorkspace(
  files: Readonly<Record<string, string>> = {},
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-cli-"));
  if (options.from !== undefined) await cp(options.from, dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }

  let scripts = 0;
  return {
    dir,
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

/**
 * Every file in a folder, relative and sorted — the way to check that a step
 * which promised to leave a repository alone left it alone.
 */
export async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(path.join(dir, entry.name), name)));
    else found.push(name);
  }
  return found.sort();
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
