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
 * **It stopped being where this deployment's settings live.** It used to hold
 * the carrier, the persona's model and the speech providers as well, and a
 * platform started any way but through this CLI had none of them — every
 * container started, every health check passed, and the failure arrived minutes
 * later as a provider or carrier refusal naming nothing about configuration.
 * Those are the platform's own settings now: sealed in its store, put there by
 * `egma self-host setup` or by the environment, and handed to each simulator on
 * the work order it claims. What is left here is `BOOTSTRAP_VARIABLES`.
 */
export const PLATFORM_CONFIG_FILE = "platform.env";

/**
 * The variables this file may carry into a container, and therefore the only
 * ones anything reads out of it.
 *
 * **A closed list rather than "whatever the file says", because the file
 * outlives the release that wrote it.** A workspace upgraded from the release
 * that kept settings here still has a carrier password and a provider key
 * sitting in it. Handing those to Compose would seed the platform from the file
 * all over again — a compatibility reader nobody decided to build, arriving by
 * accident, and quietly contradicting the upgrade note that tells an operator
 * their settings are gone and setup runs once more.
 *
 * So a line egma no longer writes reaches nothing. It is **left on the disk**
 * rather than deleted: an operator upgrading may need to read their own key out
 * of it once, and a provider that shows a key exactly once is a provider whose
 * key egma must not throw away on their behalf. It is inert, and the upgrade
 * note says to clear it.
 *
 * Each of the three is here because a container reads it when it is *created*.
 * The media pair is a password between egma's own parts, held from birth by its
 * media server, its SIP gateway and its simulator; the address is what the
 * platform reports itself as, which every agent repository then binds to.
 */
export const BOOTSTRAP_VARIABLES = [
  "EGMA_BASE_URL",
  "EGMA_LIVEKIT_API_KEY",
  "EGMA_LIVEKIT_API_SECRET",
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
  "egma bootstrap variables — written by `egma self-host`.",
  "",
  "This file holds credentials. It is created readable by you and nobody",
  "else, it belongs wherever the rest of this deployment's secrets do, and",
  "it belongs in no repository.",
  "",
  "The media server's key and secret are egma's own. They are generated when",
  "this workspace is prepared and never regenerated, because the three",
  "containers that authenticate each other with them hold whatever they were",
  "created with. Nobody chooses them and nobody types them.",
  "",
  "This deployment's settings are deliberately not here — not the carrier,",
  "not the persona's model, not a provider key. The platform keeps those in",
  "its own store, sealed, so that they survive a restart, an upgrade and a",
  "move to another machine. `egma self-host setup` puts them there.",
  "",
  "A line below naming anything but the variables above was left by an older",
  "egma. Nothing reads it any more. Clear it once you have run",
  "`egma self-host setup`.",
] as const;

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
 * Every line the file holds, or an empty record where nothing has written one.
 *
 * Parsed rather than sourced: these are `NAME=value` lines egma wrote itself,
 * one per line, with no quoting and no expansion, because anything cleverer
 * would be a shell dialect to get subtly wrong.
 *
 * **This answers the whole file, including lines egma no longer writes**, and
 * it has exactly one caller who is entitled to them: the writer, which carries
 * a line it does not recognise forward untouched rather than deleting somebody's
 * only copy of a key. Everything that hands values to a container asks
 * `bootstrapVariables` instead, which is the narrow door and the one that keeps
 * a settings line an older egma left behind from reaching anything.
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
 * The bootstrap variables this workspace holds, and nothing else it happens to
 * carry.
 *
 * The one door between the file and a container. See `BOOTSTRAP_VARIABLES` for
 * why the list is closed: a settings line an older egma wrote is inert, and
 * that has to be a property of the reader rather than a promise each caller
 * keeps.
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
 * decided the mode for good — and the documented order runs `--plan` before
 * `--apply`, so the directory was created by the receipt at the default 0755
 * and the later private write never tightened it. This is the one door both
 * writers go through, and it sets the mode every time.
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
 * loosened is tightened again the next time setup runs. The directory it sits
 * in is held the same way.
 *
 * It writes exactly what it is handed, which is how a line an older egma left
 * behind survives: the caller reads the whole file, puts its own values on top
 * and hands the result back. Nothing is deleted on somebody's behalf.
 */
export function writePlatformConfig(
  workspace: string,
  values: Record<string, string>,
): string {
  platformDirectory(workspace);
  const file = platformConfigPath(workspace);
  const body = [
    ...PLATFORM_CONFIG_HEADER.map((line) => (line === "" ? "#" : `# ${line}`)),
    "",
    ...Object.entries(values).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
  // **Written beside the file and renamed over it, never into it.**
  //
  // This file holds the only copy of a SIP password Twilio has already
  // accepted, and `writeFileSync` onto the live path truncates before it
  // writes. A process that dies in that window leaves a half-written config —
  // a deployment that reads as configured and authenticates nothing, which is
  // harder to diagnose than one that is plainly absent.
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
