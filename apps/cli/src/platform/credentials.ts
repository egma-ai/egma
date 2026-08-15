/**
 * The keys Egma mints for this machine, keyed by platform origin.
 *
 * One file in the developer's home folder is readable by nobody else. Each key
 * stays beside the normalized origin that minted it. The file never chooses a
 * repository target; the repository binding does that.
 *
 * The folder is resolved rather than assumed. That is what lets a test and a
 * check against a real instance each run a whole login without ever reading or
 * writing the credentials of the person running them.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  folderPathsIn,
  readConfig,
  teachingTheMove,
  type PlatformBinding,
} from "../folder/egma-folder.ts";
import {
  normalizePlatformOrigin,
  readPlatformIdentity,
  type PlatformIdentity,
} from "./identity.ts";
import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";

/**
 * The egma an agent repository uses when nothing else names one.
 *
 * It is the last step of resolution and the only one nobody typed: a flag, the
 * environment and the repository's own binding all come first, and a bound
 * repository never falls back to it. A developer with nothing configured
 * reaches egma's own platform — and the wizard says which egma that is on its
 * first screen, before it asks that address anything at all.
 */
export const DEFAULT_PLATFORM_URL = "https://app.egma.ai";

/**
 * A test seam, not product surface: this stands in for the built-in address
 * while a check runs, so the suite never signs in to the real hosted egma.
 *
 * It is not documented and it is not stable — the same treatment `main.ts`
 * gives the `-- <command>` seam that starts a scripted coding agent in place of
 * a real one. It is not a second way for a developer to select a platform:
 * `EGMA_URL` is that, and it sits above the built-in address in the order.
 */
export const TEST_DEFAULT_URL_VARIABLE = "EGMA_TEST_DEFAULT_URL";

/** Which built-in address this run uses: egma's own, or a check's stand-in. */
export function defaultPlatformUrlIn(env: NodeJS.ProcessEnv): string {
  const named = env[TEST_DEFAULT_URL_VARIABLE]?.trim();
  return named === undefined || named === "" ? DEFAULT_PLATFORM_URL : named;
}

/** Owner only, on the file and on the folder that holds it. */
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

export type Credentials = {
  /** The egma that minted this key. */
  readonly url: string;
  /** The key itself, handed over once at the end of login and kept here. */
  readonly key: string;
};

/**
 * The folder egma keeps this machine's credentials in.
 *
 * `EGMA_HOME` names the folder outright rather than naming a home to put
 * `.egma` inside, so a caller that has to be certain — a test, a check against a
 * real instance — can say exactly one path and be sure nothing widens it.
 */
export function egmaFolderIn(env: NodeJS.ProcessEnv): string {
  const named = env.EGMA_HOME?.trim();
  if (named !== undefined && named !== "") return named;

  const home = env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? "";
  return path.join(home === "" ? homedir() : home, ".egma");
}

export function credentialsFileIn(env: NodeJS.ProcessEnv): string {
  return path.join(egmaFolderIn(env), "credentials");
}

type CredentialEntries = ReadonlyMap<string, string>;

/**
 * The file is here and egma cannot make sense of it.
 *
 * This is a refusal and not a shrug on purpose. Treating an unreadable file as
 * an empty one reads well until the next login writes: the write starts from
 * nothing, renames itself over the file, and every other platform's key is
 * gone. A truncated file is recoverable; a file egma overwrote is not.
 */
/**
 * Something is wrong with this machine's keys file, and egma stopped.
 *
 * One family, because every command reaches this file and none of them owns
 * it: whoever is driving needs one word to branch on rather than a list to
 * keep up with.
 */
export abstract class KeysUnusableError extends Error {}

/** The `status:` line every command prints when the keys file cannot be used. */
export const KEYS_UNUSABLE = "unusable-keys";

export class CredentialsFileUnreadableError extends KeysUnusableError {
  constructor(file: string, cause: unknown) {
    super(
      `egma could not read the keys in ${file}, so it stopped rather than write over them. Look at that file. If it is damaged, move it aside and sign in again — you will be signed out of every platform, which is why egma will not do that for you.`,
      { cause },
    );
    this.name = "CredentialsFileUnreadableError";
  }
}

/** Another egma held the keys file for longer than this one would wait. */
export class CredentialsFileBusyError extends KeysUnusableError {
  constructor(file: string, lock: string) {
    super(
      `egma waited for another egma to finish writing ${file} and it did not. If nothing else is running, delete ${lock} and try again.`,
    );
    this.name = "CredentialsFileBusyError";
  }
}

function entriesIn(raw: string, file: string): CredentialEntries {
  // An empty file is an empty file: a first login can find one where a folder
  // was made and nothing was written yet.
  if (raw.trim() === "") return new Map();

  let held: { url?: unknown; key?: unknown; platforms?: unknown };
  try {
    held = JSON.parse(raw) as typeof held;
  } catch (cause) {
    throw new CredentialsFileUnreadableError(file, cause);
  }
  if (typeof held !== "object" || held === null) {
    throw new CredentialsFileUnreadableError(file, new Error("not a JSON object"));
  }

  const entries = new Map<string, string>();

  // The first shipped format held one pair. It is read so an upgrade does not
  // sign a developer out, and the next write moves it into the map.
  if (typeof held.url === "string" && typeof held.key === "string") {
    try {
      const origin = normalizePlatformOrigin(held.url);
      const key = held.key.trim();
      if (key !== "") entries.set(origin, key);
    } catch {
      // Not a usable legacy entry.
    }
  }

  if (typeof held.platforms === "object" && held.platforms !== null) {
    for (const [givenOrigin, value] of Object.entries(held.platforms)) {
      if (typeof value !== "object" || value === null || !("key" in value)) continue;
      const key = typeof value.key === "string" ? value.key.trim() : "";
      if (key === "") continue;
      try {
        entries.set(normalizePlatformOrigin(givenOrigin), key);
      } catch {
        // One bad hand-edited key must not hide every usable platform entry.
      }
    }
  }
  return entries;
}

/**
 * The keys file's bytes, or `null` when there is no keys file yet.
 *
 * **Only `ENOENT` means nobody has signed in here.** Every other way a read can
 * fail — a permission change, a directory standing where the file goes, a
 * machine out of descriptors — means the keys are there and egma cannot see
 * them, which is the one thing that must never be mistaken for an empty file.
 * The write below merges what this returns, so a read that quietly answered
 * nothing would be every other platform's key deleted by the next login.
 *
 * Both callers go through here rather than each opening the file themselves,
 * because this distinction is exactly the kind that gets fixed on one path and
 * left on the other.
 */
async function bytesOf(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CredentialsFileUnreadableError(file, cause);
  }
}

/** What is on disk for one platform, or `null` when none is usable there. */
export async function readCredentials(
  file: string,
  platformUrl: string,
): Promise<Credentials | null> {
  const raw = await bytesOf(file);
  if (raw === null) return null;

  const entries = entriesIn(raw, file);
  let origin: string;
  try {
    origin = normalizePlatformOrigin(platformUrl);
  } catch {
    return null;
  }
  const key = entries.get(origin);
  return key === undefined ? null : { url: origin, key };
}

export type WriteOptions = {
  /** Where a folder egma could not lock down is said out loud. */
  readonly warn?: (line: string) => void;
};

/** How long a write waits for another one to finish before giving up. */
const LOCK_WAIT_MS = 5_000;
/** After this, a lock is a leftover from something that died holding it. */
const LOCK_STALE_MS = 30_000;

/**
 * Hold the file while it is read, merged and replaced.
 *
 * The write is a read-modify-write over everybody's keys, so two of them
 * running together is one platform's key being dropped: both read the same
 * file, both merge their own entry into it, and the second rename wins. Two
 * terminals in two repositories signing in at once is an ordinary Tuesday, and
 * the loser finds out the next time a command says "not signed in".
 *
 * A neighbouring file taken with `wx` is the whole mechanism, because `wx` is
 * one atomic question the filesystem answers for exactly one caller. A lock
 * left behind by something that died is taken over once it is plainly old, so
 * a crash cannot lock a developer out of signing in.
 */
async function whileLocked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, `${String(process.pid)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const held = await stat(lock).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > until) throw new CredentialsFileBusyError(file, lock);
      await new Promise((resume) => setTimeout(resume, 50));
    }
  }

  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Write the key, owner-readable and no wider.
 *
 * The key is written to a fresh file beside the target and renamed over it,
 * which is the only way to be sure of the mode it lands with. `writeFile` with
 * a mode applies that mode when it *creates* a file and never afterwards, so
 * writing straight at the target would put the key inside whatever was already
 * there, keeping whatever that was readable by — and if the target is a symlink
 * it would put the key wherever the link points. A rename replaces the name
 * itself, symlink and all, and it either happened or it did not, so no reader
 * ever sees half a file.
 *
 * The new file is created with `wx`, so it is this run's file or nothing.
 */
export async function writeCredentials(
  file: string,
  credentials: Credentials,
  options: WriteOptions = {},
): Promise<void> {
  const warn = options.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));

  const folder = path.dirname(file);
  await mkdir(folder, { recursive: true, mode: FOLDER_MODE });
  try {
    await chmod(folder, FOLDER_MODE);
  } catch {
    // A folder egma cannot narrow is not a reason to fail a login that worked —
    // but it is a reason to say so, because the developer is about to hold a
    // key in a place other people on this machine can look into.
    warn(
      `egma could not make ${folder} readable by you alone. The key is written, and anybody who can read that folder can read it.`,
    );
  }

  // Read, merge and replace, with nothing else allowed in between.
  await whileLocked(file, async () => {
    // `null` here is the first login, which has nothing to merge. A file that
    // is there and cannot be read stops this instead: what follows renames a
    // freshly built document over the target, so carrying on with nothing
    // merged would replace every platform's key with just this one.
    const existing = await bytesOf(file);
    const entries = new Map(entriesIn(existing ?? "", file));
    const origin = normalizePlatformOrigin(credentials.url);
    entries.set(origin, credentials.key);

    const platforms = Object.fromEntries(
      [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([url, key]) => [url, { key }]),
    );
    const document = `${JSON.stringify({ version: 1, platforms }, null, 2)}\n`;

    const fresh = path.join(
      folder,
      `.credentials-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    await writeFile(fresh, document, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    try {
      // The umask can only narrow what a file is created with, never widen it,
      // so this is the one that makes 0600 true rather than 0600-or-less.
      await chmod(fresh, FILE_MODE);
      await rename(fresh, file);
    } catch (cause) {
      await rm(fresh, { force: true });
      throw cause;
    }
  });
}

export type PlatformChoice = {
  /** `--url`, which beats everything because it is the most deliberate. */
  readonly flag?: string | null;
  /** `EGMA_URL`, which is how a self-hoster sets it for a whole shell. */
  readonly env?: string | undefined;
  /** The platform committed in this agent repository. */
  readonly binding?: string | null;
  /**
   * The built-in address, for a repository that names none.
   *
   * Passed in rather than reached for, so that the one place which decides
   * *which* built-in address this run has — egma's own, or a check's stand-in —
   * is the caller that also holds the environment.
   */
  readonly fallback: string;
};

/** What a developer is told when the address they named is not one. */
export class UnusableUrlError extends Error {
  constructor(where: string) {
    super(
      `${where} is not a platform origin Egma can use. Give a whole address that starts with http:// or https:// and contains no credentials, path, query, or fragment.`,
    );
    this.name = "UnusableUrlError";
  }
}

/** Where a selected address came from. It decides who a refusal names. */
export type PlatformSource = "--url" | "EGMA_URL" | "binding" | "default";

export type SelectedPlatform = {
  readonly url: string;
  readonly source: PlatformSource;
};

const SOURCE_NAMES: Record<PlatformSource, string> = {
  "--url": "--url",
  EGMA_URL: "EGMA_URL",
  binding: "the repository platform binding",
  default: "egma's built-in address",
};

/**
 * Which egma this command talks to, and which of the four places said so.
 *
 * Deliberate beats ambient beats committed: a flag on the command, then the
 * environment, then the repository binding, then egma's own platform for an
 * unbound repository. A machine-level login never chooses a repository target.
 *
 * The source travels with the address because a refusal that names the wrong
 * platform sends a developer to fix something they did not ask for: told to
 * start the platform this repository is bound to when what they actually named
 * on the command line is the one that is down.
 *
 * An address a person typed is checked here, at the edge that takes it, and a
 * bad one is refused by name rather than carried into the flow.
 */
export function selectPlatform(choice: PlatformChoice): SelectedPlatform {
  const named: readonly [PlatformSource, string | null | undefined][] = [
    ["--url", choice.flag],
    ["EGMA_URL", choice.env],
    ["binding", choice.binding],
    ["default", choice.fallback],
  ];
  for (const [source, candidate] of named) {
    const tidy = typeof candidate === "string" ? candidate.trim() : "";
    if (tidy === "") continue;
    try {
      return { url: normalizePlatformOrigin(tidy), source };
    } catch {
      // The rejected value can itself contain a supplied password. Name only
      // the source, never the value.
      throw new UnusableUrlError(SOURCE_NAMES[source]);
    }
  }
  // The built-in address is always there, so nothing reaches this in a shipped
  // copy. It is a sentence rather than an exhausted `switch` because the one
  // way to get here is a stand-in address set to nothing, and a test seam that
  // was set wrong should say so rather than resolve to something.
  throw new UnusableUrlError(SOURCE_NAMES.default);
}

/** The address alone, for callers that do not have to say where it came from. */
export function resolvePlatformUrl(choice: PlatformChoice): string {
  return selectPlatform(choice).url;
}

/** Which egma a run signs in to, and where the key it gets is kept. */
export type PlatformAccess = {
  readonly url: string;
  readonly credentialsFile: string;
};

/** Platform access after its public identity has answered. */
export type VerifiedPlatformAccess = PlatformAccess & {
  readonly instanceId: string;
};

/**
 * A selected instance is not the platform committed in this repository.
 *
 * This and the address refusal below are the two a developer meets when they
 * really are moving a repository — they point egma at the platform they want
 * and are told no — so both end with the whole move rather than its first step.
 * Naming one deletion and stopping is what leaves somebody deleting a line,
 * running again, and meeting a stranger failure about identifiers the new
 * platform never issued.
 */
export class PlatformBindingMismatchError extends Error {
  constructor(binding: PlatformBinding, selected: PlatformIdentity) {
    super(
      teachingTheMove(
        `This repository is bound to Egma platform ${binding.instance} at ${binding.origin}, but the selected address identifies platform ${selected.instanceId} at ${selected.origin}. Remove --url or EGMA_URL to use the bound platform. egma does not move a repository between platforms, and no repository identifiers were sent.`,
      ),
    );
    this.name = "PlatformBindingMismatchError";
  }
}

/**
 * A bound repository was pointed at a different address than the one it
 * recorded, whoever is answering there.
 *
 * Separate from the instance mismatch above because it is refused before
 * anybody answers: the move is out of this effort either way, and the same
 * instance served at a new address is still a change to a committed file that
 * a developer has to make on purpose rather than have made for them. That case
 * keeps its own sentence, because editing one address is not the move and
 * treating it as one would have somebody throw away identifiers that are still
 * good.
 */
export class BoundPlatformAddressError extends Error {
  constructor(binding: PlatformBinding, source: PlatformSource, selected: string) {
    super(
      teachingTheMove(
        `This repository is bound to Egma platform ${binding.instance} at ${binding.origin}, and ${SOURCE_NAMES[source]} names ${selected} instead. Drop it to use the bound platform. If that platform has only changed address, edit the platform origin in egma/config.yaml on purpose. egma does not move a repository between platforms, and no repository identifiers were sent.`,
      ),
    );
    this.name = "BoundPlatformAddressError";
  }
}

/** The bound platform did not answer, and egma's own was deliberately not tried. */
export class BoundPlatformUnavailableError extends Error {
  constructor(binding: PlatformBinding, cause: unknown) {
    super(
      `This repository is bound to Egma platform ${binding.instance} at ${binding.origin}, and it did not answer. Start the bound platform and run this again. egma did not fall back to its own platform, and no repository identifiers were sent.`,
      { cause },
    );
    this.name = "BoundPlatformUnavailableError";
  }
}

/**
 * Nothing named a platform, so egma used its own, and its own is no use today.
 *
 * One refusal for every way that address can fail, because the developer never
 * typed it, does not run what is at it, and cannot fix any of them. Handing on
 * the underlying sentence would send them to check an address they did not
 * choose, or to reconfigure a deployment that is not theirs. So this says the
 * two moves that are theirs — wait, or name a platform of their own — and keeps
 * the real fault as the cause for anybody who goes looking.
 */
export class DefaultPlatformUnusableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `This repository names no Egma platform, so egma used its own at ${url}, and it did not answer. Try again in a moment, or point egma at another platform with --url <address> or EGMA_URL. Nothing was sent.`,
      { cause },
    );
    this.name = "DefaultPlatformUnusableError";
  }
}

/** The committed config could not safely take part in platform resolution. */
export class RepositoryPlatformConfigError extends Error {
  constructor(cause: unknown) {
    super(
      "Egma could not read this repository's egma/config.yaml, so it did not select a platform. Fix that file and run this again. egma did not fall back to its own platform.",
      { cause },
    );
    this.name = "RepositoryPlatformConfigError";
  }
}

async function bindingIn(repository: string): Promise<PlatformBinding | null> {
  try {
    return (await readConfig(folderPathsIn(repository).config)).platform;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RepositoryPlatformConfigError(cause);
  }
}

/** Which egma a command will use, before anybody there has been asked anything. */
export type ChosenPlatform = SelectedPlatform & {
  /** The platform committed in this repository, when there is one. */
  readonly binding: PlatformBinding | null;
  readonly credentialsFile: string;
};

/**
 * Which egma, chosen without asking anybody anything.
 *
 * Separate from the read that follows it because the wizard names the address
 * on its first screen and takes the keystroke of consent there: a bare command
 * asks nothing of any address until the developer has read which address it is.
 * A verb has no screen and no keystroke to take, so it does both in one step.
 *
 * Everything refused here is refused on what is already on this machine — a bad
 * address, an unreadable config, a bound repository pointed somewhere else — so
 * none of it costs a request.
 */
export async function choosePlatform(choice: {
  readonly env: NodeJS.ProcessEnv;
  /** `--url`, when one was given. */
  readonly flag: string | null;
  /** The agent repository whose binding is part of resolution. */
  readonly cwd: string;
}): Promise<ChosenPlatform> {
  const credentialsFile = credentialsFileIn(choice.env);
  const binding = await bindingIn(choice.cwd);
  const selected = selectPlatform({
    flag: choice.flag,
    env: choice.env.EGMA_URL,
    binding: binding?.origin ?? null,
    fallback: defaultPlatformUrlIn(choice.env),
  });

  // Refused before anybody is asked anything: a bound repository is reached at
  // the address it recorded, and at no other.
  if (binding !== null && selected.url !== binding.origin) {
    throw new BoundPlatformAddressError(binding, selected.source, selected.url);
  }

  return { ...selected, binding, credentialsFile };
}

/** Who is answering there — the first thing a command asks of any address. */
export async function verifyPlatform(
  chosen: ChosenPlatform,
  fetchImpl?: Fetch,
): Promise<VerifiedPlatformAccess> {
  const { binding } = chosen;
  let identity: PlatformIdentity;
  try {
    identity = await readPlatformIdentity(chosen.url, fetchImpl);
  } catch (cause) {
    // Safe to name the binding here, and only here: any address that is not the
    // bound one was already refused above, so a bound repository that got this
    // far was reaching its own platform.
    if (binding !== null && cause instanceof PlatformUnreachableError) {
      throw new BoundPlatformUnavailableError(binding, cause);
    }
    // Nobody chose this address, so nobody can be sent to go and look at it.
    if (chosen.source === "default") {
      throw new DefaultPlatformUnusableError(chosen.url, cause);
    }
    throw cause;
  }

  if (binding !== null && binding.instance !== identity.instanceId) {
    throw new PlatformBindingMismatchError(binding, identity);
  }

  return {
    url: identity.origin,
    instanceId: identity.instanceId,
    credentialsFile: chosen.credentialsFile,
  };
}

/**
 * Resolved once, in one place, so the wizard and every verb read the same
 * answer from the same four places in the same order. Two copies of this would
 * be two answers to "which egma is this", and the one that is wrong would be
 * the one that wrote the key.
 */
export async function resolvePlatformAccess(choice: {
  readonly env: NodeJS.ProcessEnv;
  /** `--url`, when one was given. */
  readonly flag: string | null;
  /** The agent repository whose binding is part of resolution. */
  readonly cwd: string;
  readonly fetchImpl?: Fetch;
}): Promise<VerifiedPlatformAccess> {
  return verifyPlatform(await choosePlatform(choice), choice.fetchImpl);
}
