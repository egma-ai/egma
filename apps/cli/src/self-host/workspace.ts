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

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/** What names a directory as a platform workspace. */
export const COMPOSE_FILE = "docker-compose.yml";

/** Where a workspace keeps what `egma self-host` left behind. */
export const PLATFORM_DIRECTORY = ".egma-platform";

/**
 * The file this workspace's **bootstrap variables** are written to.
 *
 * Not `.env`: that file is the self-hoster's, hand-edited and often committed
 * to whatever holds their infrastructure, and a command that rewrote it would
 * be editing somebody's notes. This one is egma's to write and is read back on
 * every `self-host` command.
 *
 * It holds only `BOOTSTRAP_VARIABLES`. Provider keys and the optional carrier
 * route live in the operator's deployment environment.
 */
export const PLATFORM_CONFIG_FILE = "platform.env";

/**
 * The variables this file may carry into a container, and therefore the only
 * ones anything reads out of it.
 *
 * The list is closed because each value is read when a container is created.
 * The media pair is a password between egma's own parts, held from birth by its
 * media server, its SIP gateway and its simulator; the address is what the
 * platform reports itself as, which every agent repository then binds to.
 */
export const PLATFORM_CREDENTIAL_VARIABLES = [
  "EGMA_ENCRYPTION_KEY",
  "EGMA_AUTH_SECRET",
  "EGMA_SIMULATOR_SERVICE_TOKEN",
  "EGMA_S3_ACCESS_KEY_ID",
  "EGMA_S3_SECRET_ACCESS_KEY",
  "EGMA_S3_READ_ACCESS_KEY_ID",
  "EGMA_S3_READ_SECRET_ACCESS_KEY",
  "EGMA_S3_INGEST_ACCESS_KEY_ID",
  "EGMA_S3_INGEST_SECRET_ACCESS_KEY",
  "EGMA_LIVEKIT_API_KEY",
  "EGMA_LIVEKIT_API_SECRET",
] as const;

export const BOOTSTRAP_VARIABLES = [
  "EGMA_BASE_URL",
  ...PLATFORM_CREDENTIAL_VARIABLES,
] as const;

/**
 * What is written at the top of that file, whichever command wrote it.
 *
 * One header rather than one per writer: the file is the same file, read by
 * every `self-host` command and rewritten by more than one of them, and a
 * header that changed depending on which command last touched it would tell a
 * person the wrong story about what is in it.
 */
export const PLATFORM_CONFIG_HEADER = [
  "Egma bootstrap variables — written by `egma self-host`.",
  "",
  "This file holds credentials. It is created readable by you and nobody",
  "else, it belongs wherever the rest of this deployment's secrets do, and",
  "it belongs in no repository.",
  "",
  "The credentials below are Egma's own passwords between its containers.",
  "They are generated when this workspace is prepared and never regenerated.",
  "An existing deployment's values are adopted before any new value is made,",
  "so stored credentials and running containers do not lose agreement.",
  "",
  "The carrier route and model-provider keys are deliberately not here.",
  "They stay in the operator's .env file and are loaded by `self-host up`.",
] as const;

/** Owner read and write, and nothing for anybody else. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export class NoPlatformWorkspaceError extends Error {
  constructor(startedAt: string) {
    super(
      `this is not a platform workspace: no ${COMPOSE_FILE} here or above ${startedAt}.\n\n` +
        "A platform workspace is the directory Egma's deployment lives in — the " +
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
 * Every line the file holds, or an empty record where nothing has written one.
 *
 * Parsed rather than sourced: these are `NAME=value` lines egma wrote itself,
 * one per line, with no quoting and no expansion, because anything cleverer
 * would be a shell dialect to get subtly wrong.
 *
 * Callers pass the result through `bootstrapVariables` before it reaches a
 * container or a later write.
 */
export function readPlatformConfig(workspace: string): Record<string, string> {
  const file = platformConfigPath(workspace);
  if (!existsSync(file)) return {};
  // A restored or manually copied file may have arrived with a broad mode.
  // Repair both levels before the early no-op bootstrap path can return.
  chmodSync(path.dirname(file), PRIVATE_DIRECTORY_MODE);
  chmodSync(file, PRIVATE_FILE_MODE);
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
 * Make the operator environment private before Docker Compose reads it.
 *
 * The values themselves are resolved by Compose's own parser in
 * `composeEnvironment`. This function owns only the filesystem guarantee.
 */
export function protectOperatorEnvironment(workspace: string): void {
  const file = path.join(workspace, ".env");
  if (!existsSync(file)) return;

  // This file now holds model-provider keys and may hold a SIP password. A
  // normal `cp .env.example .env` follows the user's umask and is commonly
  // world-readable. Tighten it before reading, on every start, so the safe
  // mode is a property of the command rather than a setup instruction a person
  // must remember.
  chmodSync(file, PRIVATE_FILE_MODE);
}

/**
 * The bootstrap variables this workspace holds, and nothing else it happens to
 * carry.
 *
 * The one door between the file and a container. The closed list is enforced
 * here instead of repeated by every caller.
 */
export function bootstrapVariables(
  stored: Readonly<Record<string, string>>,
): Record<string, string> {
  const held: Record<string, string> = {};
  for (const name of BOOTSTRAP_VARIABLES) {
    const value = stored[name];
    if (value !== undefined && value !== "") held[name] = value;
  }
  return held;
}

/**
 * The workspace's platform directory, made if it is not there and made private
 * either way.
 *
 * **The `chmod` is the point, not the `mkdir`.** `mkdirSync`'s `mode` applies
 * only when it creates the directory, so whichever write happened to be first
 * decided the mode for good. This one door sets the mode every time.
 */
export function platformDirectory(workspace: string): string {
  const directory = path.join(workspace, PLATFORM_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  return directory;
}

/**
 * Write this workspace's bootstrap variables, replacing whatever was there.
 *
 * Created private and kept private: it holds the media server's secret, and a
 * mode is set on every write rather than only at creation, so a file somebody
 * loosened is tightened again the next time `self-host up` runs. The directory it sits
 * in is held the same way.
 *
 * The writer applies the same closed bootstrap list as the reader. No carrier
 * route or provider key can enter this file through a caller.
 */
export function writePlatformConfig(
  workspace: string,
  values: Record<string, string>,
): string {
  platformDirectory(workspace);
  const file = platformConfigPath(workspace);
  const bootstrap = bootstrapVariables(values);
  const body = [
    ...PLATFORM_CONFIG_HEADER.map((line) => (line === "" ? "#" : `# ${line}`)),
    "",
    ...Object.entries(bootstrap).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
  // **Written beside the file and renamed over it, never into it.**
  //
  // This file holds the media-server credential shared by three containers,
  // and `writeFileSync` onto the live path truncates before it writes. A process
  // that dies in that window leaves a half-written config — a deployment whose
  // media components disagree about authentication, which is harder to
  // diagnose than one that is plainly absent.
  //
  // A rename within a directory is atomic, so a reader sees the whole old file
  // or the whole new one and never a partial. `wx` makes the temporary this
  // run's own file or nothing at all, and it is removed if anything downstream
  // of it fails, so a crash leaves no litter beside a working configuration.
  // The same mechanism the credentials store uses, for the same reason.
  const fresh = path.join(
    path.dirname(file),
    `.platform-${process.pid}-${randomBytes(6).toString("hex")}.env`,
  );
  writeFileSync(fresh, body, { mode: PRIVATE_FILE_MODE, flag: "wx" });
  try {
    // The umask can only narrow what a file is created with, so this is what
    // makes the mode exactly 0600 rather than 0600-or-less.
    chmodSync(fresh, PRIVATE_FILE_MODE);
    renameSync(fresh, file);
  } catch (cause) {
    rmSync(fresh, { force: true });
    throw cause;
  }
  return file;
}
