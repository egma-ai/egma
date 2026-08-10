/**
 * The platform workspace: where a self-hoster operates their own egma.
 *
 * **Two contexts, one CLI.** An *agent repository* holds tests and a binding to
 * the platform that owns their identifiers. A *platform workspace* holds the
 * deployment itself — the compose file, the containers, the carrier
 * configuration. They are different directories with different state and
 * different secrets, and on one laptop they are often owned by the same person.
 * Keeping them apart is what stops platform credentials spreading into every
 * repository that talks to the platform.
 *
 * A platform workspace is recognised by its `docker-compose.yml`, walking up
 * from wherever the command was run — the same way a git command finds its
 * repository. Nothing is created to make a directory into one: a workspace with
 * no compose file is not an unconfigured workspace, it is somewhere else.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What names a directory as a platform workspace. */
export const COMPOSE_FILE = "docker-compose.yml";

/** Where a workspace keeps what phone setup left behind. */
export const PLATFORM_DIRECTORY = ".egma-platform";

/**
 * The file the platform's own configuration is written to.
 *
 * Not `.env`: that file is the self-hoster's, hand-edited and often committed
 * to whatever holds their infrastructure, and a command that rewrote it would
 * be editing somebody's notes. This one is egma's to write and is read back on
 * every `self-host` command.
 */
export const PLATFORM_CONFIG_FILE = "platform.env";

/** Owner read and write, and nothing for anybody else. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export class NoPlatformWorkspaceError extends Error {
  constructor(startedAt: string) {
    super(
      `this is not a platform workspace: no ${COMPOSE_FILE} here or above ${startedAt}.\n\n` +
        "A platform workspace is the directory egma's deployment lives in — the " +
        "checkout that holds its compose file. It is deliberately not your agent " +
        "repository: the platform's carrier and provider credentials belong to " +
        "whoever runs the platform, and an agent repository holds only tests and " +
        "the address of the platform that owns their identifiers.\n\n" +
        "Run this from the platform workspace, or use --cwd to name it.",
    );
    this.name = "NoPlatformWorkspaceError";
  }
}

/** The platform workspace containing a directory, walking up from it. */
export function findWorkspace(startedAt: string): string {
  let here = path.resolve(startedAt);
  for (;;) {
    if (existsSync(path.join(here, COMPOSE_FILE))) return here;
    const above = path.dirname(here);
    if (above === here) throw new NoPlatformWorkspaceError(path.resolve(startedAt));
    here = above;
  }
}

export function platformConfigPath(workspace: string): string {
  return path.join(workspace, PLATFORM_DIRECTORY, PLATFORM_CONFIG_FILE);
}

/**
 * What phone setup wrote, or an empty record where it has not run.
 *
 * Parsed rather than sourced: these are `NAME=value` lines egma wrote itself,
 * one per line, with no quoting and no expansion, because anything cleverer
 * would be a shell dialect to get subtly wrong.
 */
export function readPlatformConfig(workspace: string): Record<string, string> {
  const file = platformConfigPath(workspace);
  if (!existsSync(file)) return {};
  const found: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const split = text.indexOf("=");
    if (split <= 0) continue;
    found[text.slice(0, split)] = text.slice(split + 1);
  }
  return found;
}

/**
 * Write the platform's configuration, replacing whatever was there.
 *
 * Created private and kept private: it holds the SIP password egma minted and
 * the provider key the deployment speaks with, and a mode is set on every write
 * rather than only at creation, so a file somebody loosened is tightened again
 * the next time setup runs.
 */
export function writePlatformConfig(
  workspace: string,
  values: Record<string, string>,
  { header }: { readonly header: readonly string[] },
): string {
  const directory = path.join(workspace, PLATFORM_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const file = platformConfigPath(workspace);
  const body = [
    ...header.map((line) => (line === "" ? "#" : `# ${line}`)),
    "",
    ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
  writeFileSync(file, body, { mode: PRIVATE_FILE_MODE });
  chmodSync(file, PRIVATE_FILE_MODE);
  return file;
}
