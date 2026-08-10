/**
 * The keys egma mints for this machine, one per egma it has signed in to.
 *
 * One flat file in the developer's home folder, readable by nobody else. It
 * holds a list rather than a single key, because a developer uses Egma Cloud
 * and a self-hosted egma from the same machine and a key minted against one
 * means nothing against the other. Each entry is keyed by the platform's
 * normalized origin, so signing in to one platform never replaces the key for
 * another — and so a command can ask for the key belonging to the egma it is
 * about to talk to rather than for "the key".
 *
 * **What is stored here never decides which egma a command talks to.** That is
 * the repository's business (see `binding.ts`) or the developer's, said in
 * `--url` or `EGMA_URL`. A machine-wide "last signed in to" would quietly aim
 * one repository's identifiers at another repository's platform, which is the
 * failure ADR-0008 exists to remove.
 *
 * The folder is resolved rather than assumed. That is what lets a test and a
 * check against a real instance each run a whole login without ever reading or
 * writing the credentials of the person running them.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isWebAddress } from "./address.ts";

/** The egma a command talks to when nothing says otherwise. */
export const DEFAULT_PLATFORM_URL = "https://app.egma.ai";

/** Owner only, on the file and on the folder that holds it. */
const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;

export type Credentials = {
  /** The egma that minted this key, as a normalized origin. */
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

/**
 * An address in the one shape everything else compares against.
 *
 * Two addresses are the same platform when this makes them the same string, and
 * that decides three things at once: which stored key a command uses, whether a
 * repository's binding matches the address in hand, and whether a second login
 * replaces a key or adds one. So the differences that are not differences are
 * taken out here — a trailing slash, the case of the scheme and the host, and a
 * port that is the scheme's own. A path is kept, because an egma served under
 * one is a different egma from the one served at the root beside it.
 */
export function normalizePlatformOrigin(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Not an address at all. It is handed back as it was written, so whoever
    // takes it next refuses it by name rather than refusing something else.
    return trimmed;
  }

  const port =
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "https:" && parsed.port === "443")
      ? ""
      : parsed.port;
  const authority = `${parsed.hostname.toLowerCase()}${port === "" ? "" : `:${port}`}`;
  const under = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.protocol.toLowerCase()}//${authority}${under}`;
}

/** Every platform this machine holds a key for, in the order they were added. */
export async function readAllCredentials(file: string): Promise<readonly Credentials[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }

  let held: unknown;
  try {
    held = JSON.parse(raw);
  } catch {
    // A file somebody edited by hand, or half a write. Either way there is
    // nothing to log in with, and saying so sends the developer through login
    // rather than through a parse error.
    return [];
  }

  const document = held as { platforms?: unknown; url?: unknown; key?: unknown };
  // The shape before there could be two: one key, one address, at the top
  // level. It is read as the one entry it is, so a developer who signed in
  // before this file grew a list stays signed in.
  const entries = Array.isArray(document.platforms)
    ? document.platforms
    : [{ url: document.url, key: document.key }];

  const found: Credentials[] = [];
  for (const entry of entries) {
    const one = entry as { url?: unknown; key?: unknown };
    const url = typeof one.url === "string" ? normalizePlatformOrigin(one.url) : "";
    const key = typeof one.key === "string" ? one.key.trim() : "";
    if (url === "" || key === "") continue;
    if (found.some((already) => already.url === url)) continue;
    found.push({ url, key });
  }
  return found;
}

/** The key for one egma, or `null` when this machine holds none for it. */
export async function readCredentialsFor(
  file: string,
  url: string,
): Promise<Credentials | null> {
  const wanted = normalizePlatformOrigin(url);
  return (await readAllCredentials(file)).find((held) => held.url === wanted) ?? null;
}

export type WriteOptions = {
  /** Where a folder egma could not lock down is said out loud. */
  readonly warn?: (line: string) => void;
};

/**
 * Keep a key, beside the keys for every other egma this machine knows.
 *
 * An entry for the same platform is replaced — a second login against one egma
 * has one answer — and every other entry is carried through untouched, which is
 * the whole promise: signing in here does not sign anybody out there.
 *
 * The file is written fresh beside the target and renamed over it, which is the
 * only way to be sure of the mode it lands with. `writeFile` with a mode applies
 * that mode when it *creates* a file and never afterwards, so writing straight
 * at the target would put the keys inside whatever was already there, keeping
 * whatever that was readable by — and if the target is a symlink it would put
 * them wherever the link points. A rename replaces the name itself, symlink and
 * all, and it either happened or it did not, so no reader ever sees half a file.
 *
 * The new file is created with `wx`, so it is this run's file or nothing.
 */
export async function rememberCredentials(
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

  const url = normalizePlatformOrigin(credentials.url);
  const kept = (await readAllCredentials(file)).filter((held) => held.url !== url);
  const document = `${JSON.stringify(
    { platforms: [...kept, { url, key: credentials.key }] },
    null,
    2,
  )}\n`;

  const fresh = path.join(folder, `.credentials-${process.pid}-${randomBytes(6).toString("hex")}`);
  await writeFile(fresh, document, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  try {
    // The umask can only narrow what a file is created with, never widen it, so
    // this is the one that makes 0600 true rather than 0600-or-less.
    await chmod(fresh, FILE_MODE);
    await rename(fresh, file);
  } catch (cause) {
    await rm(fresh, { force: true });
    throw cause;
  }
}

export type PlatformChoice = {
  /** `--url`, which beats everything because it is the most deliberate. */
  readonly flag?: string | null;
  /** `EGMA_URL`, which is how a self-hoster sets it for a whole shell. */
  readonly env?: string | undefined;
  /** The origin this repository is bound to, when it is bound to one. */
  readonly binding?: string | null;
};

/** Which of the four places decided which egma this command talks to. */
export type PlatformSource = "flag" | "environment" | "binding" | "cloud";

/** What a developer is told when the address they named is not one. */
export class UnusableUrlError extends Error {
  constructor(where: string, given: string) {
    super(
      `${where} is ${given}, and egma cannot talk to that. Give a whole address that starts with http:// or https://.`,
    );
    this.name = "UnusableUrlError";
  }
}

/**
 * Which egma this command talks to.
 *
 * Deliberate beats ambient beats committed: a flag on the command, then the
 * environment, then the platform this repository is bound to, then Egma Cloud
 * for a repository that is bound to nothing. **What this machine signed in to
 * last is not in the list**, and that is the decision rather than an omission —
 * a machine-wide target would let the last login in one repository redirect the
 * next command in another, which is how identifiers cross platforms (ADR-0008).
 *
 * An address a person typed is checked here, at the edge that takes it, and a
 * bad one is refused by name rather than carried into the flow — because the
 * next thing that happens to it is that a browser is started on it. A binding
 * is only ever written from an address that already passed this, so a config
 * file somebody edited by hand is stepped over rather than made into a refusal
 * on every command afterwards.
 */
export function resolvePlatformUrl(choice: PlatformChoice): {
  readonly url: string;
  readonly source: PlatformSource;
} {
  const named: readonly [string, PlatformSource, string | null | undefined][] = [
    ["--url", "flag", choice.flag],
    ["EGMA_URL", "environment", choice.env],
  ];
  for (const [where, source, candidate] of named) {
    const tidy = typeof candidate === "string" ? normalizePlatformOrigin(candidate) : "";
    if (tidy === "") continue;
    if (!isWebAddress(tidy)) throw new UnusableUrlError(where, tidy);
    return { url: tidy, source };
  }

  const bound = typeof choice.binding === "string" ? normalizePlatformOrigin(choice.binding) : "";
  if (bound !== "" && isWebAddress(bound)) return { url: bound, source: "binding" };
  return { url: DEFAULT_PLATFORM_URL, source: "cloud" };
}
