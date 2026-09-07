/**
 * Store machine login keys by normalized platform origin in a private home file.
 * Repository bindings select targets; this file does not. Resolve the home path
 * through the test seam to avoid touching real credentials in tests.
 */

import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  EMPTY_CONFIG,
  folderPathsIn,
  parseSuiteManifest,
  platformOwnedIds,
  readConfig,
  SUITE_MANIFEST_FILE_NAME,
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
 * platform, and each network command prints that address before its result.
 */
export const DEFAULT_PLATFORM_URL = "https://app.egma.ai";

/** Test-only hosted-address override. Product platform selection uses --url. */
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
  /**
   * The server record behind a key minted by `egma login`.
   *
   * Older files do not have this. Its presence is the proof logout needs
   * before it may revoke anything remotely: a bare secret can authenticate a
   * request, but it does not identify the key row that request should revoke.
   */
  readonly login?: {
    readonly apiKeyId: string;
    readonly projectId: string;
  };
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

type CredentialEntries = ReadonlyMap<string, Credentials>;

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

/** Internal name for a credentials-file failure reported in terminal prose. */
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

  const entries = new Map<string, Credentials>();

  // The first shipped format held one pair. It is read so an upgrade does not
  // sign a developer out, and the next write moves it into the map.
  if (typeof held.url === "string" && typeof held.key === "string") {
    try {
      const origin = normalizePlatformOrigin(held.url);
      const key = held.key.trim();
      if (key !== "") entries.set(origin, { url: origin, key });
    } catch {
      // Not a usable legacy entry.
    }
  }

  if (typeof held.platforms === "object" && held.platforms !== null) {
    for (const [givenOrigin, value] of Object.entries(held.platforms)) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as Readonly<Record<string, unknown>>;
      // Version 2 names the secret for what it is. `key` is the version 1
      // spelling and stays readable so an upgrade never signs a machine out.
      const rawKey = record["api_key"] ?? record["key"];
      const key = typeof rawKey === "string" ? rawKey.trim() : "";
      if (key === "") continue;
      try {
        const origin = normalizePlatformOrigin(givenOrigin);
        const rawLogin = record["login"];
        if (typeof rawLogin === "object" && rawLogin !== null) {
          const login = rawLogin as Readonly<Record<string, unknown>>;
          const apiKeyId =
            typeof login["api_key_id"] === "string"
              ? login["api_key_id"].trim()
              : "";
          const projectId =
            typeof login["project_id"] === "string"
              ? login["project_id"].trim()
              : "";
          if (apiKeyId !== "" && projectId !== "") {
            entries.set(origin, {
              url: origin,
              key,
              login: { apiKeyId, projectId },
            });
            continue;
          }
        }
        entries.set(origin, { url: origin, key });
      } catch {
        // One bad hand-edited key must not hide every usable platform entry.
      }
    }
  }
  return entries;
}

/**
 * Return null only for ENOENT. Other read failures must stop the write,
 * otherwise merging with an assumed empty file would delete other platform keys.
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
  return entries.get(origin) ?? null;
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
 * Lock the read/merge/replace operation with atomic wx creation of a neighboring file.
 * Concurrent logins must not overwrite each other's keys. Reclaim old abandoned locks.
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

/** The version 2 bytes for every platform entry, in a stable order. */
function documentFor(entries: CredentialEntries): string {
  const platforms = Object.fromEntries(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([url, credentials]) => [
        url,
        {
          api_key: credentials.key,
          ...(credentials.login === undefined
            ? {}
            : {
                login: {
                  api_key_id: credentials.login.apiKeyId,
                  project_id: credentials.login.projectId,
                },
              }),
        },
      ]),
  );
  return `${JSON.stringify({ version: 2, platforms }, null, 2)}\n`;
}

/** Replace the credentials file without exposing a partial document. */
async function replaceCredentialsFile(
  file: string,
  folder: string,
  entries: CredentialEntries,
): Promise<void> {
  const fresh = path.join(
    folder,
    `.credentials-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(fresh, documentFor(entries), {
    encoding: "utf8",
    mode: FILE_MODE,
    flag: "wx",
  });
  try {
    // The umask can only narrow what a file is created with, never widen it,
    // so this is the one that makes 0600 true rather than 0600-or-less.
    await chmod(fresh, FILE_MODE);
    await rename(fresh, file);
  } catch (cause) {
    await rm(fresh, { force: true });
    throw cause;
  }
}

/**
 * Create an owner-only temporary file with wx, then atomically rename it over
 * the target. This replaces symlinks and old permissions without following them,
 * and readers never see a partial key file.
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
    entries.set(origin, { ...credentials, url: origin });
    await replaceCredentialsFile(file, folder, entries);
  });
}

export type RemovedCredentials =
  | { readonly kind: "removed"; readonly fileRemoved: boolean }
  | { readonly kind: "not-found" }
  | { readonly kind: "changed" };

function sameCredentials(left: Credentials, right: Credentials): boolean {
  return (
    left.url === right.url &&
    left.key === right.key &&
    left.login?.apiKeyId === right.login?.apiKeyId &&
    left.login?.projectId === right.login?.projectId
  );
}

/**
 * Remove exactly the entry a caller read, without touching another platform.
 *
 * The equality check matters when login and logout run together. A logout
 * that just revoked an old key must not remove a replacement login that landed
 * while the network request was in flight.
 */
export async function removeCredentials(
  file: string,
  expected: Credentials,
): Promise<RemovedCredentials> {
  // Do not create ~/.egma merely to say that no login was there. A first read
  // also separates that ordinary case from every real read failure.
  if (await bytesOf(file) === null) return { kind: "not-found" };

  const folder = path.dirname(file);
  return whileLocked(file, async () => {
    const existing = await bytesOf(file);
    if (existing === null) return { kind: "not-found" };

    const entries = new Map(entriesIn(existing, file));
    const origin = normalizePlatformOrigin(expected.url);
    const held = entries.get(origin);
    if (held === undefined) return { kind: "not-found" };
    if (!sameCredentials(held, { ...expected, url: origin })) {
      return { kind: "changed" };
    }

    entries.delete(origin);
    if (entries.size === 0) {
      // Remove the file, not its parent. ~/.egma may hold other machine-local
      // state, and an empty login must not delete any of it.
      await rm(file);
      return { kind: "removed", fileRemoved: true };
    }

    await replaceCredentialsFile(file, folder, entries);
    return { kind: "removed", fileRemoved: false };
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
 * Choose platform origin in order: --url, repository binding, built-in default.
 * Machine login state does not select a target. Validate explicit addresses and
 * retain the source so errors point to the setting the developer used.
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
 * Explain an explicit address that differs from the committed binding.
 * Distinguish changing the address of the same platform from moving to another.
 * Attach move instructions only for an actual override, never for binding selection itself.
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
 * Refuse stored resource IDs without a platform binding. Their issuing platform
 * is unknown even with --url, so restore the binding or remove the IDs before moving.
 */
export class UnboundPlatformIdentifiersError extends Error {
  constructor(held: readonly string[]) {
    super(
      teachingTheMove(
        `This repository names no Egma platform, and it still holds identifiers that only the platform which issued them can resolve — ${held.join(", ")}. Egma will not send them anywhere, because the line that said which platform they came from is the one that is gone. Two ways on: put the platform: block back in egma/config.yaml, which is committed and so is in this repository's history, or delete the identifiers below and run egma init for the platform you want. Nothing was sent.`,
      ),
    );
    this.name = "UnboundPlatformIdentifiersError";
  }
}

/** The committed config could not safely take part in platform resolution. */
export class RepositoryPlatformConfigError extends Error {
  constructor(cause: unknown) {
    const reason =
      cause instanceof Error
        ? cause.message
        : "The repository binding could not be read.";
    super(
      `Egma could not read the platform binding in egma/config.yaml or, for an unbound repository, the Suite manifests under egma/tests. ${reason} Fix that binding information and run this again. Egma did not fall back to its own platform.`,
      { cause },
    );
    this.name = "RepositoryPlatformConfigError";
  }
}

/**
 * The committed platform binding information, or `null` when this repository
 * has none.
 *
 * The whole config rather than only its platform block, because resolution
 * also needs the Project, Agent, and Connection ids used by the move guard.
 * In an unbound repository, Suite manifests are read for the same narrow
 * reason. Tests and Mock Tools do not take part in platform choice.
 */
type CommittedRepository = {
  readonly config: FolderConfig;
  readonly suiteIds: readonly string[];
};

/**
 * Read only the Suite identities needed to keep a repository on its platform.
 *
 * Platform choice is not repository validation. Tests and Mock Tools may be in
 * progress while a developer signs in, signs out, or works with an Agent. A
 * Suite manifest is the one exception because its id belongs to the platform
 * that issued it and must take part in the move guard.
 */
async function committedSuiteIds(testsFolder: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(testsFolder, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const suiteIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(testsFolder, entry.name, SUITE_MANIFEST_FILE_NAME);
    let document: string;
    try {
      document = await readFile(manifest, "utf8");
    } catch (cause) {
      // A directory with no manifest carries no platform-issued Suite id.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    suiteIds.push(
      parseSuiteManifest(
        document,
        path.join("egma", "tests", entry.name, SUITE_MANIFEST_FILE_NAME),
      ).id,
    );
  }
  return suiteIds;
}

async function committedIn(repository: string): Promise<CommittedRepository | null> {
  const paths = folderPathsIn(repository);
  try {
    const config = await readConfig(paths.config);
    return {
      config,
      // The binding already says who owns every committed id. Suite ids are
      // needed only when that binding is missing and the move guard has to
      // prove that the folder still belongs to some platform.
      suiteIds:
        config.platform === null ? await committedSuiteIds(paths.tests) : [],
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        const suiteIds = await committedSuiteIds(paths.tests);
        return suiteIds.length === 0
          ? null
          : { config: EMPTY_CONFIG, suiteIds };
      } catch (suiteCause) {
        throw new RepositoryPlatformConfigError(suiteCause);
      }
    }
    throw new RepositoryPlatformConfigError(cause);
  }
}

/** Which egma a command will use, before anybody there has been asked anything. */
export type ChosenPlatform = SelectedPlatform & {
  /** The platform committed in this repository, when there is one. */
  readonly binding: PlatformBinding | null;
  readonly credentialsFile: string;
};

/** Select and validate the target using local settings before any network request. */
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

  // Refuse resource IDs without a platform binding even when --url is explicit.
  // A new folder without IDs can still initialize normally.
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
