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
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BOOTSTRAP_VARIABLES,
  bootstrapVariables,
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
 * Every credential the bundled self-hosted platform uses only between its own
 * containers, grouped where two halves must always move together.
 *
 * None is an operator decision. A self-hoster chooses external provider keys;
 * Egma chooses these values once per platform workspace and records them in
 * `platform.env`. An existing value from `.env` is adopted before generation,
 * which is how an older deployment moves to the smaller operator interface
 * without losing the encryption key that opens its stored credentials.
 */
const INTERNAL_CREDENTIALS = [
  {
    names: ["EGMA_ENCRYPTION_KEY"],
    make: (): readonly string[] => [randomBytes(32).toString("hex")],
  },
  {
    names: ["EGMA_AUTH_SECRET"],
    make: (): readonly string[] => [randomBytes(32).toString("base64url")],
  },
  {
    names: ["EGMA_SIMULATOR_SERVICE_TOKEN"],
    make: (): readonly string[] => [`egma_st_${randomBytes(32).toString("hex")}`],
  },
  {
    names: ["EGMA_S3_ACCESS_KEY_ID", "EGMA_S3_SECRET_ACCESS_KEY"],
    make: (): readonly string[] => [
      randomBytes(8).toString("hex"),
      randomBytes(24).toString("base64url"),
    ],
  },
  {
    names: ["EGMA_S3_READ_ACCESS_KEY_ID", "EGMA_S3_READ_SECRET_ACCESS_KEY"],
    make: (): readonly string[] => [
      randomBytes(8).toString("hex"),
      randomBytes(24).toString("base64url"),
    ],
  },
  {
    names: ["EGMA_S3_INGEST_ACCESS_KEY_ID", "EGMA_S3_INGEST_SECRET_ACCESS_KEY"],
    make: (): readonly string[] => [
      randomBytes(8).toString("hex"),
      randomBytes(24).toString("base64url"),
    ],
  },
] as const;

export type PlatformBootstrap = {
  /** The complete closed bootstrap set handed to Compose. */
  readonly values: Readonly<Record<string, string>>;
  /** Names generated by this decision; values are never reported. */
  readonly generated: readonly string[];
  /** Kept separately because only media containers need special recreation. */
  readonly mediaGenerated: boolean;
};

/** One complete group from the first source that holds every member. */
function completeGroup(
  names: readonly string[],
  sources: readonly Readonly<Record<string, string | undefined>>[],
): Record<string, string> | undefined {
  for (const source of sources) {
    const values = names.map((name) => source[name]?.trim() ?? "");
    if (values.every((value) => value !== "")) {
      return Object.fromEntries(names.map((name, index) => [name, values[index] as string]));
    }
  }
  return undefined;
}

/** Decide one complete bootstrap set without writing it. */
export function platformBootstrap(
  address: string,
  ...sources: readonly Readonly<Record<string, string | undefined>>[]
): PlatformBootstrap {
  const media = mediaCredential(...sources);
  const values: Record<string, string> = {
    EGMA_BASE_URL: address,
    ...media.values,
  };
  const generated = media.generated
    ? [MEDIA_KEY_VARIABLE, MEDIA_SECRET_VARIABLE]
    : [];

  for (const group of INTERNAL_CREDENTIALS) {
    const existing = completeGroup(group.names, sources);
    if (existing !== undefined) {
      Object.assign(values, existing);
      continue;
    }
    const made = group.make();
    for (const [index, name] of group.names.entries()) {
      values[name] = made[index] as string;
      generated.push(name);
    }
  }

  return { values, generated, mediaGenerated: media.generated };
}

/** Internal credential names absent from every complete source group. */
function missingPlatformCredentials(
  sources: readonly Readonly<Record<string, string | undefined>>[],
): readonly string[] {
  const groups: readonly (readonly string[])[] = [
    [MEDIA_KEY_VARIABLE, MEDIA_SECRET_VARIABLE],
    ...INTERNAL_CREDENTIALS.map((group) => group.names),
  ];
  return groups.flatMap((names) =>
    completeGroup(names, sources) === undefined ? [...names] : [],
  );
}

/** Whether the private workspace file already holds this complete decision. */
function bootstrapRecorded(
  decided: PlatformBootstrap,
  stored: Readonly<Record<string, string>>,
): boolean {
  return BOOTSTRAP_VARIABLES.every(
    (name) => stored[name] === decided.values[name],
  );
}

/**
 * Prepare and record every platform-internal credential with one winner.
 *
 * The workspace file wins for every group it already holds. An older
 * deployment's `.env` supplies only groups not recorded there yet, including
 * its encryption key. Missing groups are generated. Pair groups never mix
 * halves from different sources.
 */
export async function recordPlatformBootstrap(
  workspace: string,
  environment: Readonly<Record<string, string | undefined>>,
  address: string,
  postgresVolumes: readonly string[] = [],
): Promise<PlatformBootstrap> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const held = readPlatformConfig(workspace);
    const missingBeforeLock = missingPlatformCredentials([held, environment]);
    if (missingBeforeLock.length === 0) {
      const already = platformBootstrap(address, held, environment);
      if (bootstrapRecorded(already, held)) return already;
    }

    const lock = await takeMintingLock(workspace);
    let landed: PlatformBootstrap;
    try {
      const stored = readPlatformConfig(workspace);
      const missing = missingPlatformCredentials([stored, environment]);
      if (postgresVolumes.length > 0 && missing.length > 0) {
        throw new Error(
          `this workspace already has the Postgres volume${
            postgresVolumes.length === 1 ? "" : "s"
          } ${postgresVolumes.join(", ")}, but its internal credential record is ` +
            `missing ${missing.join(", ")}. Nothing was generated. Restore ` +
            ".egma-platform/platform.env from the same backup as Postgres, or " +
            "restore the complete legacy values to .env and run this again. " +
            "If the named volume belongs only to an unused first start, remove " +
            "that exact volume before trying again.",
        );
      }
      const decided = platformBootstrap(address, stored, environment);
      if (!bootstrapRecorded(decided, stored)) {
        writePlatformConfig(workspace, {
          ...bootstrapVariables(stored),
          ...decided.values,
        });
      }
      const onDisk = bootstrapVariables(readPlatformConfig(workspace));
      landed = {
        values: onDisk,
        generated: decided.generated,
        mediaGenerated: decided.mediaGenerated,
      };
    } catch (cause) {
      lock.release();
      throw cause;
    }
    if (lock.release()) return landed;
  }

  const settled = bootstrapVariables(readPlatformConfig(workspace));
  const missing = BOOTSTRAP_VARIABLES.filter(
    (name) => settled[name] === undefined || settled[name] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      "another command held this workspace's bootstrap configuration for all " +
        `${ATTEMPTS} attempts and left ${missing.join(", ")} unset. Run this again.`,
    );
  }
  return { values: settled, generated: [], mediaGenerated: false };
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
export const MINTING_LOCK_FILE = ".media-credential.lock";

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
 * How many times a displaced holder starts over.
 *
 * Displacement takes a stall longer than the window above, so a second one in
 * the same command is already beyond anything this can reason about. The
 * attempts are bounded rather than unbounded because a loop that cannot end is
 * worse than a refusal that says what happened.
 */
const ATTEMPTS = 3;

/**
 * The pair this workspace uses, written down if it was not already, with
 * exactly one winner when two commands ask at the same moment.
 *
 * Two concurrent `egma self-host up` commands can both reach here. Left
 * unguarded, each could generate its own pair, write the file, and hand a
 * different pair to Compose. The read-decide-write step therefore has one
 * winner.
 *
 * So the read-decide-write step has one winner. The loser waits, re-reads, and
 * **adopts** what the winner recorded rather than overwriting it. The value
 * returned is read back off the disk after the step, so the pair handed to
 * Compose is the pair in the file by construction rather than by argument.
 *
 * A file lock rather than an exclusive create of the configuration itself:
 * the configuration file can already hold the platform address, so creating it
 * exclusively would decide nothing there.
 *
 * **A holder that was displaced starts over rather than trusting itself.** A
 * lock old enough to look abandoned is taken from whoever left it, and a
 * process that stalled past that window — a closed lid, a machine deep in swap
 * — wakes to find its turn was given away, possibly after it had already
 * written a pair. What it decided is then worth nothing, so it goes back to
 * the top and reads the disk again like any other latecomer.
 */
export async function recordMediaCredential(
  workspace: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<MediaCredential> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // The ordinary path, and the only one on every start after the first: what
    // is on disk is already what this command would use. Nothing is written and
    // no lock is taken, so a plain start neither creates a lock file nor
    // contends for one.
    const held = readPlatformConfig(workspace);
    const already = mediaCredential(environment, held);
    if (recorded(already, held)) return already;

    const lock = await takeMintingLock(workspace);
    let landed: MediaCredential;
    try {
      // Read again inside the lock. Whoever held it before us may have been
      // recording the very pair we were about to generate, and this is the read
      // that sees it.
      const stored = readPlatformConfig(workspace);
      const decided = mediaCredential(environment, stored);
      if (!recorded(decided, stored)) {
        writePlatformConfig(workspace, {
          ...bootstrapVariables(stored),
          ...decided.values,
        });
      }
      // What actually landed, rather than what was decided in memory.
      landed = {
        ...mediaCredential(readPlatformConfig(workspace)),
        generated: decided.generated,
      };
    } catch (cause) {
      lock.release();
      throw cause;
    }
    // Only now is the answer worth anything: a holder still holding its own
    // lock did this step alone, and a displaced one did not.
    if (lock.release()) return landed;
  }

  // Displaced every time. Nothing more is written — whatever is on the disk is
  // what the deployment runs on, and this command uses that or says it cannot.
  const settled = readPlatformConfig(workspace);
  const onDisk = mediaCredential(settled);
  if (onDisk.generated) {
    throw new Error(
      "another command held this workspace's media-server credential for the whole of " +
        `${ATTEMPTS} attempts and left none behind. Run this again.`,
    );
  }
  return onDisk;
}

/** A held minting lock, and the only thing that may give it back. */
export type MintingLock = {
  /**
   * Give the lock back, and say whether it was still ours to give.
   *
   * `false` means this holder was displaced while it worked: the file now
   * carries somebody else's token, and **it is not removed**. Removing it
   * would put the displacer and the next command inside the step together,
   * which is the state the lock exists to prevent.
   */
  release(): boolean;
};

/**
 * Hold the workspace until the returned lock is released.
 *
 * `wx` is the whole mechanism: creating a file that must not already exist is
 * one atomic operation, so of any number of commands asking at once exactly
 * one succeeds and the rest see `EEXIST`.
 *
 * **The file carries a token naming this holder**, because a lock file's
 * existence does not say whose it is. Without one, a holder that stalled past
 * the takeover window would come back and delete its successor's lock, and a
 * third command would then walk straight into the step beside that successor.
 * So every removal — a release, and a takeover — first reads the token and
 * acts only on the lock it meant to act on.
 *
 * Exported so the ownership contract can be checked directly. The alternative
 * is a test that stalls a real process for longer than the takeover window,
 * which is half a minute of waiting to assert one comparison.
 */
export async function takeMintingLock(workspace: string): Promise<MintingLock> {
  const file = path.join(platformDirectory(workspace), MINTING_LOCK_FILE);
  const ours = `${process.pid}:${randomBytes(12).toString("base64url")}\n`;
  for (;;) {
    try {
      writeFileSync(file, ours, { mode: PRIVATE_FILE_MODE, flag: "wx" });
      return {
        release: () => {
          if (lockToken(file) !== ours) return false;
          rmSync(file, { force: true });
          return true;
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }

    const holder = lockToken(file);
    const heldSince = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    // Released between the failed create and this look. Go straight round.
    if (holder === null || heldSince === undefined) continue;

    if (Date.now() - heldSince > LOCK_IS_ABANDONED_AFTER_MS) {
      // Displace that holder, and only that one. Reading the token again
      // before removing keeps a lock somebody took in the meantime — after
      // the old one was released — from being thrown away by this branch.
      if (lockToken(file) === holder) rmSync(file, { force: true });
      continue;
    }
    await new Promise((wake) => setTimeout(wake, LOCK_POLL_MS));
  }
}

/** Whose lock this is, or `null` where there is no lock to read. */
function lockToken(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}
