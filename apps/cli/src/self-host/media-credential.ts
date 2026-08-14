/**
 * The credential the media server, the simulator and the SIP gateway
 * authenticate each other with.
 *
 * **It is a password between egma's own parts**, in the same class as the
 * Postgres password: generated when a workspace is prepared, written beside the
 * other bootstrap variables, and never seen, chosen or typed by the operator.
 *
 * It exists because the alternative was live. All three containers used to fall
 * back to a key and a secret written into the compose file in the public
 * repository, and nothing in the CLI, the skills or the documentation ever
 * replaced them. Published to loopback the exposure is small — but the compose
 * file invites a wider bind for testing from another machine, and at that
 * moment the media server accepts anyone who read the repository.
 *
 * **A pair that already exists is left exactly as it is.** The three containers
 * hold whatever they were created with, so a preparation that minted a fresh
 * pair would leave a running deployment whose parts no longer agree — and the
 * symptom is every phone simulation failing to authenticate, a long way from
 * the command that caused it. Regenerating is therefore the one thing this must
 * never do on its own.
 */

import { randomBytes } from "node:crypto";
import { rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  platformDirectory,
  readPlatformConfig,
  writePlatformConfig,
} from "./workspace.ts";

/** What the compose file reads the pair from, and therefore what is written. */
export const MEDIA_KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
export const MEDIA_SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";

/**
 * The pair a workspace is to use, and whether this call is what made it.
 *
 * `generated` is not a detail: it is the difference between a start that leaves
 * a deployment alone and one that replaces its media containers, and the
 * operator is told which of the two happened.
 */
export type MediaCredential = {
  readonly values: Readonly<Record<string, string>>;
  readonly generated: boolean;
};

/**
 * The first pair any of these sources carries, or a fresh one where none does.
 *
 * Sources are given in order of precedence, and the caller's order is the same
 * one `up` already uses for the platform's address: the environment first,
 * because a self-hoster who exported this pair meant it, then the workspace's
 * own configuration. A pair egma is handed is a pair egma keeps.
 *
 * **Half a pair counts as none, one source at a time.** A key with no secret
 * authenticates nothing, and a key from one source beside a secret from another
 * is two halves of two different passwords — worse than either. So a source
 * carrying one of the two is passed over whole, and the two are always minted
 * together.
 *
 * Both generated values are drawn from `A-Za-z0-9_-` alone. They travel through
 * a `NAME=value` file with no quoting, a child process environment, and a YAML
 * scalar in the compose file, and a character that needed escaping in any one
 * of those would break a deployment in a way that reads as a wrong password.
 */
export function mediaCredential(
  ...sources: readonly Readonly<Record<string, string | undefined>>[]
): MediaCredential {
  for (const source of sources) {
    const key = source[MEDIA_KEY_VARIABLE]?.trim() ?? "";
    const secret = source[MEDIA_SECRET_VARIABLE]?.trim() ?? "";
    if (key !== "" && secret !== "") {
      return {
        values: { [MEDIA_KEY_VARIABLE]: key, [MEDIA_SECRET_VARIABLE]: secret },
        generated: false,
      };
    }
  }
  return {
    values: {
      // Named so that a person reading the media server's logs can tell egma's
      // own credential from one they brought themselves.
      [MEDIA_KEY_VARIABLE]: `egma${randomBytes(9).toString("base64url")}`,
      // 32 bytes. The media server refuses a secret shorter than 32
      // characters, and this is well past that in any encoding.
      [MEDIA_SECRET_VARIABLE]: randomBytes(32).toString("base64url"),
    },
    generated: true,
  };
}

/**
 * Whether a workspace's configuration already says exactly this pair.
 *
 * The question asked before writing, and it is not the same question as
 * `generated`. A pair that arrived from the environment was made by nobody
 * here, and still has to be written down: one that lives only in a shell is one
 * the next start cannot find, and that start would mint a third pair and lock
 * the deployment out of itself.
 */
function recorded(
  credential: MediaCredential,
  stored: Readonly<Record<string, string>>,
): boolean {
  return (
    stored[MEDIA_KEY_VARIABLE] === credential.values[MEDIA_KEY_VARIABLE] &&
    stored[MEDIA_SECRET_VARIABLE] === credential.values[MEDIA_SECRET_VARIABLE]
  );
}

/** What holds the workspace while one command decides its media credential. */
const MINTING_LOCK_FILE = ".media-credential.lock";

/** Owner read and write, like everything else in the platform directory. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * How long a lock may exist before whoever left it is treated as gone.
 *
 * Generous by two orders of magnitude. What the lock is held across is reading
 * a small file, making 41 random bytes and writing that file back, so a lock
 * this old belongs to a process that died holding it rather than to one still
 * working — and a lock nobody will ever release must not stop a deployment
 * from starting for ever.
 */
const LOCK_IS_ABANDONED_AFTER_MS = 30_000;
const LOCK_POLL_MS = 25;

/**
 * The pair this workspace uses, written down if it was not already, with
 * exactly one winner when two commands ask at the same moment.
 *
 * **Two commands mint.** `egma self-host up` and `egma self-host phone setup`
 * both reach here, so the two racers need not even be the same command. Left
 * unguarded, each would generate its own pair, each would write the file, and
 * each would then hand *its* pair to Compose — leaving the recorded pair and
 * the running containers' pair different. That failure passes every health
 * check and surfaces minutes later as a carrier or media refusal that names
 * nothing about configuration, which is the exact failure this whole effort
 * exists to remove. Shipping a new one of those inside it would be a poor
 * trade.
 *
 * So the read-decide-write step has one winner. The loser waits, re-reads, and
 * **adopts** what the winner recorded rather than overwriting it. The value
 * returned is read back off the disk after the step, so the pair handed to
 * Compose is the pair in the file by construction rather than by argument.
 *
 * A file lock rather than an exclusive create of the configuration itself:
 * that file legitimately already exists on the deployment this most matters to
 * — one upgraded from a release that wrote carrier settings and no media pair
 * — so creating it exclusively would decide nothing there.
 */
export async function recordMediaCredential(
  workspace: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<MediaCredential> {
  // The ordinary path, and the only one on every start after the first: what
  // is on disk is already what this command would use. Nothing is written and
  // no lock is taken, so a plain start neither creates a lock file nor
  // contends for one.
  const held = readPlatformConfig(workspace);
  if (recorded(mediaCredential(environment, held), held)) {
    return mediaCredential(environment, held);
  }

  const release = await takeMintingLock(workspace);
  try {
    // Read again inside the lock. Whoever held it before us may have been
    // recording the very pair we were about to generate, and this is the read
    // that sees it.
    const stored = readPlatformConfig(workspace);
    const decided = mediaCredential(environment, stored);
    if (!recorded(decided, stored)) {
      writePlatformConfig(workspace, { ...stored, ...decided.values });
    }
    // What actually landed, rather than what was decided in memory.
    return { ...mediaCredential(readPlatformConfig(workspace)), generated: decided.generated };
  } finally {
    release();
  }
}

/**
 * Hold the workspace until the returned function gives it back.
 *
 * `wx` is the whole mechanism: creating a file that must not already exist is
 * one atomic operation, so of any number of commands asking at once exactly
 * one succeeds and the rest see `EEXIST`.
 */
async function takeMintingLock(workspace: string): Promise<() => void> {
  const file = path.join(platformDirectory(workspace), MINTING_LOCK_FILE);
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    const heldSince = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    // Either it was released between the failed create and this look, or it
    // was left behind by a process that is not coming back. Both end the same
    // way: try again, and this time there is nothing in the way.
    if (heldSince === undefined || Date.now() - heldSince > LOCK_IS_ABANDONED_AFTER_MS) {
      rmSync(file, { force: true });
      continue;
    }
    await new Promise((wake) => setTimeout(wake, LOCK_POLL_MS));
  }
}
