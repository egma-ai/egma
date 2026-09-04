/** A throwaway repository and isolated Egma credentials folder. */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeCredentials } from "../../src/platform/credentials.ts";

export const APPROVING_BROWSER = fileURLToPath(
  new URL("./approving-browser.ts", import.meta.url),
);

export const MANIFEST = JSON.stringify(
  { name: "customer-repo", version: "1.0.0" },
  null,
  2,
);

export const CLI_ENTRY = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export const PRETEND_OLD_NODE = fileURLToPath(
  new URL("./pretend-old-node.ts", import.meta.url),
);

export type Workspace = {
  readonly dir: string;
  readonly egmaFolder: string;
  readonly credentialsFile: string;
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  signIn(url: string, key?: string): Promise<void>;
  browser(): Promise<{ readonly command: string; readonly opened: string }>;
  remove(): Promise<void>;
};

export const NO_BROWSER = "/usr/bin/true";
export const NO_RETELL = "http://127.0.0.1:1";
export const NO_DEFAULT_PLATFORM = "http://127.0.0.1:1";

const CLEARED_VARIABLES = [
  "EGMA_API_KEY",
  "EGMA_RETELL_API_KEY",
  "RETELL_API_KEY",
  "EGMA_RETELL_AGENT_ID",
  "EGMA_LANES",
  "EGMA_PHONE_NUMBER",
  "EGMA_LIVEKIT_API_KEY",
  "EGMA_LIVEKIT_API_SECRET",
  "EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

export async function makeWorkspace(
  files: Readonly<Record<string, string>> = {},
): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-cli-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }

  const egmaFolder = path.join(dir, "egma-home");
  const credentialsFile = path.join(egmaFolder, "credentials");

  return {
    dir,
    egmaFolder,
    credentialsFile,
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        EGMA_HOME: egmaFolder,
        BROWSER: NO_BROWSER,
        EGMA_RETELL_URL: NO_RETELL,
        EGMA_TEST_DEFAULT_URL: NO_DEFAULT_PLATFORM,
        ...extra,
      };
      for (const variable of CLEARED_VARIABLES) {
        if (extra[variable] === undefined) delete env[variable];
      }
      return env;
    },
    async signIn(url, key = "egma_sk_already-held") {
      await writeCredentials(credentialsFile, { url, key });
    },
    async browser() {
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
    async remove() {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
