/**
 * The key egma mints for this machine, and which egma it belongs to.
 *
 * One flat file in the developer's home folder, readable by nobody else. It
 * holds two facts, and they are kept together because they always travel
 * together: a key minted against one instance means nothing against another, so
 * remembering the key without remembering the address would leave a developer
 * re-typing the address on every command afterwards.
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

/**
 * An address in the one shape everything else compares against.
 *
 * A trailing slash and a stored address that differs from a typed one only by
 * that slash are the same instance, and treating them as two would mint a
 * second key for the same egma.
 */
export function tidyUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

/** What is on disk, or `null` when there is nothing usable there. */
export async function readCredentials(file: string): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  try {
    const held = JSON.parse(raw) as { url?: unknown; key?: unknown };
    const url = typeof held.url === "string" ? tidyUrl(held.url) : "";
    const key = typeof held.key === "string" ? held.key.trim() : "";
    if (url === "" || key === "") return null;
    return { url, key };
  } catch {
    // A file somebody edited by hand, or half a write. Either way there is
    // nothing to log in with, and saying so sends the developer through login
    // rather than through a parse error.
    return null;
  }
}

export type WriteOptions = {
  /** Where a folder egma could not lock down is said out loud. */
  readonly warn?: (line: string) => void;
};

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

  const document = `${JSON.stringify(
    { url: tidyUrl(credentials.url), key: credentials.key },
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
  /** What the last successful login wrote, so it is set once and not again. */
  readonly stored?: string | null;
};

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
 * Deliberate beats ambient beats remembered: a flag on the command, then the
 * environment, then what login already stored, then egma's own address. The
 * order is what makes "set it once" true — after a first login against a
 * self-hosted instance, every later command finds it without being told again.
 *
 * An address a person typed is checked here, at the edge that takes it, and a
 * bad one is refused by name rather than carried into the flow — because the
 * next thing that happens to it is that a browser is started on it. What login
 * stored is only ever an address that already passed this, so a file somebody
 * edited by hand is stepped over rather than made into a refusal on every
 * command afterwards.
 */
export function resolvePlatformUrl(choice: PlatformChoice): string {
  const named: readonly [string, string | null | undefined][] = [
    ["--url", choice.flag],
    ["EGMA_URL", choice.env],
  ];
  for (const [where, candidate] of named) {
    const tidy = typeof candidate === "string" ? tidyUrl(candidate) : "";
    if (tidy === "") continue;
    if (!isWebAddress(tidy)) throw new UnusableUrlError(where, tidy);
    return tidy;
  }

  const stored = typeof choice.stored === "string" ? tidyUrl(choice.stored) : "";
  if (stored !== "" && isWebAddress(stored)) return stored;
  return DEFAULT_PLATFORM_URL;
}

/** Which egma a run signs in to, and where the key it gets is kept. */
export type PlatformAccess = {
  readonly url: string;
  readonly credentialsFile: string;
};

/**
 * Resolved once, in one place, so the wizard and every verb read the same
 * answer from the same three places in the same order. Two copies of this would
 * be two answers to "which egma is this", and the one that is wrong would be
 * the one that wrote the key.
 */
export async function resolvePlatformAccess(choice: {
  readonly env: NodeJS.ProcessEnv;
  /** `--url`, when one was given. */
  readonly flag: string | null;
}): Promise<PlatformAccess> {
  const credentialsFile = credentialsFileIn(choice.env);
  const stored = await readCredentials(credentialsFile);
  return {
    url: resolvePlatformUrl({
      flag: choice.flag,
      env: choice.env.EGMA_URL,
      stored: stored?.url ?? null,
    }),
    credentialsFile,
  };
}
