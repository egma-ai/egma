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

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

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

/**
 * Write the key, owner-readable and no wider.
 *
 * The mode is set after the write as well as during it, because the mode a
 * file is created with is narrowed by the process umask but never widened by
 * it — and a file that already existed keeps whatever mode it had.
 */
export async function writeCredentials(
  file: string,
  credentials: Credentials,
): Promise<void> {
  const folder = path.dirname(file);
  await mkdir(folder, { recursive: true, mode: FOLDER_MODE });
  await chmod(folder, FOLDER_MODE).catch(() => undefined);

  const document = `${JSON.stringify(
    { url: tidyUrl(credentials.url), key: credentials.key },
    null,
    2,
  )}\n`;
  await writeFile(file, document, { encoding: "utf8", mode: FILE_MODE });
  await chmod(file, FILE_MODE);
}

export type PlatformChoice = {
  /** `--url`, which beats everything because it is the most deliberate. */
  readonly flag?: string | null;
  /** `EGMA_URL`, which is how a self-hoster sets it for a whole shell. */
  readonly env?: string | undefined;
  /** What the last successful login wrote, so it is set once and not again. */
  readonly stored?: string | null;
};

/**
 * Which egma this command talks to.
 *
 * Deliberate beats ambient beats remembered: a flag on the command, then the
 * environment, then what login already stored, then egma's own address. The
 * order is what makes "set it once" true — after a first login against a
 * self-hosted instance, every later command finds it without being told again.
 */
export function resolvePlatformUrl(choice: PlatformChoice): string {
  for (const candidate of [choice.flag, choice.env, choice.stored]) {
    const tidy = typeof candidate === "string" ? tidyUrl(candidate) : "";
    if (tidy !== "") return tidy;
  }
  return DEFAULT_PLATFORM_URL;
}
