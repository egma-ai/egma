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
  platformOwnedIds,
  readConfig,
  readRepository,
  teachingTheMove,
  type FolderConfig,
  type PlatformBinding,
} from "../folder/egma-folder.ts";
import { normalizePlatformOrigin } from "./url.ts";

/**
 * The egma an agent repository uses when nothing else names one.
 *
 * It is the last step of resolution and the only one nobody typed: `--url` and
 * the repository's own binding both come first, and a bound repository never
 * falls back to it. A developer with nothing configured reaches egma's own
 * platform — and the wizard says which egma that is on its first screen, before
 * it asks that address anything at all.
 */
export const DEFAULT_PLATFORM_URL = "https://app.egma.ai";

/**
 * A test seam, not product surface: this stands in for the built-in address
 * while a check runs, so the suite never signs in to the real hosted egma.
 *
 * It is not documented and it is not stable — the same treatment `main.ts`
 * gives the `-- <command>` seam that starts a scripted coding agent in place of
 * a real one. It is not a way for a developer to select a platform either:
 * `--url` is the one way to do that, and it sits above the built-in address in
 * the order rather than replacing it.
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
      `Egma could not read the keys in ${file}, so it stopped rather than write over them. Look at that file. If it is damaged, move it aside and sign in again — you will be signed out of every platform, which is why Egma will not do that for you.`,
      { cause },
    );
    this.name = "CredentialsFileUnreadableError";
  }
}

/** Another egma held the keys file for longer than this one would wait. */
export class CredentialsFileBusyError extends KeysUnusableError {
  constructor(file: string, lock: string) {
    super(
      `Egma waited for another Egma process to finish writing ${file} and it did not. If nothing else is running, delete ${lock} and try again.`,
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
      `Egma could not make ${folder} readable by you alone. The key is written, and anybody who can read that folder can read it.`,
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
export type PlatformSource = "--url" | "binding" | "default";

export type SelectedPlatform = {
  readonly url: string;
  readonly source: PlatformSource;
};

const SOURCE_NAMES: Record<PlatformSource, string> = {
  "--url": "--url",
  binding: "the repository platform binding",
  default: "Egma's built-in address",
};

/**
 * Which egma this command talks to, and which of the three places said so.
 *
 * Said on the command beats committed in the repository beats egma's own: one
 * explicit way to name a platform per invocation, one committed way per
 * repository, one default, and nothing else. A machine-level login never
 * chooses a repository target.
 *
 * There was a fourth place: an environment variable that was a second name for
 * `--url` over a whole shell. Two ways to say one thing is two answers to
 * "which egma is this" to keep straight — in a refusal, in a `--help` line, and
 * in the head of whoever is debugging — so the shell-wide one went and the flag
 * stayed. What it was for is served better by the rung below it: a script or a
 * container that cannot type a flag on each command binds the repository once
 * with `egma init --url`, and a binding is a committed file that travels with
 * the checkout rather than a shell nobody else has.
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

/**
 * A bound repository was pointed at a different address than the one it
 * recorded, whoever is answering there.
 *
 * A new address is still a change to a committed file that a developer must
 * make on purpose rather than have made for them.
 *
 * The sentence offers two edits that contradict each other — change the
 * platform origin, or delete the whole platform block — so it says which one
 * belongs to which situation. Under ADR-0007 a refusal that holds both without
 * a condition is one a coding agent cannot act on.
 *
 * The block under it is attached only when a developer really is being told no
 * about another platform. `binding` as the source would be the binding refusing
 * itself, which is not a move and must never end with four deletions.
 */
export class BoundPlatformAddressError extends Error {
  constructor(binding: PlatformBinding, source: PlatformSource, selected: string) {
    const named = SOURCE_NAMES[source];
    const refusal = `This repository is bound to the Egma platform at ${binding.origin}, and ${named} names ${selected} instead. Drop ${named} to use the bound platform. If ${selected} is the same platform at a new address, edit the platform origin in egma/config.yaml on purpose. Egma does not move a repository between platforms, and no repository identifiers were sent.`;
    super(source === "binding" ? refusal : teachingTheMove(refusal));
    this.name = "BoundPlatformAddressError";
  }
}

/**
 * The folder holds identifiers from a platform it no longer names.
 *
 * The half-applied move, refused rather than acted on. Deleting the platform
 * block is one edit; deleting the identifiers it was keeping in place is four
 * more. Between those two moments the repository names nothing and still holds
 * everything, and ADR-0008's rule is that those identifiers cannot silently
 * cross a platform boundary.
 *
 * **The deleted line is the one that said which platform they belong to**, so
 * once it is gone there is no address egma can safely send them to — not the
 * built-in one it would have chosen, and not one somebody types either. That is
 * why this cannot end by offering to use another platform, and why the two ways
 * out are the only two there are: put the line back, or take the identifiers
 * out. Both are named, because somebody who deleted that block by mistake is
 * not making the move at all and must not be told to throw away four working
 * identifiers to recover from a typo. The block is committed, which is exactly
 * what makes putting it back an ordinary thing to do.
 *
 * It ends with the same list every other refusal about moving ends with,
 * because the developer is in the middle of exactly that list: what they need
 * next is the rest of it, not a new set of words for the same five lines.
 */
export class UnboundPlatformIdentifiersError extends Error {
  constructor(held: readonly string[]) {
    super(
      teachingTheMove(
        `This repository names no Egma platform, and it still holds identifiers that only the platform which issued them can resolve — ${held.join(", ")}. Egma will not send them anywhere, because the line that said which platform they came from is the one that is gone. Two ways on: put the platform: block back in egma/config.yaml, which is committed and so is in this repository's history, or delete the identifiers below and connect again on whichever platform you name next. Nothing was sent.`,
      ),
    );
    this.name = "UnboundPlatformIdentifiersError";
  }
}

/** The committed config could not safely take part in platform resolution. */
export class RepositoryPlatformConfigError extends Error {
  constructor(cause: unknown) {
    super(
      "Egma could not read this repository's complete egma folder, so it did not select a platform. Fix the repository contract and run this again. Egma did not fall back to its own platform.",
      { cause },
    );
    this.name = "RepositoryPlatformConfigError";
  }
}

/**
 * The committed folder config, or `null` when this repository has none.
 *
 * The whole config rather than only its binding, because resolution needs two
 * things out of this file and reading it twice would be two answers to one
 * question: which platform it names, and — when it names none — whether it is
 * still holding identifiers that belong to one.
 */
type CommittedRepository = {
  readonly config: FolderConfig;
  readonly suiteIds: readonly string[];
};

async function committedIn(repository: string): Promise<CommittedRepository | null> {
  try {
    const paths = folderPathsIn(repository);
    const config = await readConfig(paths.config);
    const complete = await readRepository(paths);
    return {
      config,
      suiteIds: complete.suites.map((suite) => suite.manifest.id),
    };
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
  const committed = await committedIn(choice.cwd);
  const binding = committed?.config.platform ?? null;
  const selected = selectPlatform({
    flag: choice.flag,
    binding: binding?.origin ?? null,
    fallback: defaultPlatformUrlIn(choice.env),
  });

  // Refused before anybody is asked anything: a bound repository is reached at
  // the address it recorded, and at no other.
  //
  // The binding cannot disagree with itself. An address that came *from* the
  // binding is the bound address by definition — the committed origin is read
  // in the one shape origins are compared in, so a trailing slash or an
  // upper-case host in the file is the same platform and not a different one.
  // Only `--url` above it can raise this, which is also the only way this
  // refusal can be about a move somebody is really making.
  if (binding !== null && selected.source !== "binding" && selected.url !== binding.origin) {
    throw new BoundPlatformAddressError(binding, selected.source, selected.url);
  }

  // And refused before anybody is asked anything for the other direction: a
  // folder that names no platform and is still holding one platform's
  // identifiers.
  //
  // Whichever of the two places named the address, because the question this
  // asks is about the folder and not about the address. Once the platform block
  // is gone, egma cannot tell the platform that issued these identifiers from
  // any other — that is the one fact the deleted line held — so there is no
  // address it can safely send them to, including one somebody typed. Refusing
  // only the address egma chose would also be the wrong half: somebody moving a
  // repository types `--url` mid-move, which is exactly when this is true.
  //
  // A folder with no identifiers at all is untouched, which is what keeps
  // `egma init`'s own output — a bare `platform:` line and three names —
  // working exactly as it did.
  if (binding === null && committed !== null) {
    const held = platformOwnedIds(committed.config, committed.suiteIds);
    if (held.length > 0) throw new UnboundPlatformIdentifiersError(held);
  }

  return { ...selected, binding, credentialsFile };
}

/**
 * Resolve platform access once, without asking the selected address anything.
 */
export async function resolvePlatformAccess(choice: {
  readonly env: NodeJS.ProcessEnv;
  /** `--url`, when one was given. */
  readonly flag: string | null;
  /** The agent repository whose binding is part of resolution. */
  readonly cwd: string;
}): Promise<PlatformAccess> {
  const selected = await choosePlatform(choice);
  return { url: selected.url, credentialsFile: selected.credentialsFile };
}
