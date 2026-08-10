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
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { folderPathsIn, readConfig, type PlatformBinding } from "../folder/egma-folder.ts";
import {
  normalizePlatformOrigin,
  readPlatformIdentity,
  type PlatformIdentity,
} from "./identity.ts";
import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";

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

type CredentialEntries = ReadonlyMap<string, string>;

function entriesIn(raw: string): CredentialEntries {
  try {
    const held = JSON.parse(raw) as {
      url?: unknown;
      key?: unknown;
      platforms?: unknown;
    };

    const entries = new Map<string, string>();

    // The first shipped format held one pair. It is read so an upgrade does
    // not sign a developer out, and the next write moves it into the map.
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
  } catch {
    return new Map();
  }
}

/** What is on disk for one platform, or `null` when none is usable there. */
export async function readCredentials(
  file: string,
  platformUrl: string,
): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  const entries = entriesIn(raw);
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

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // The first login has nothing to merge.
  }
  const entries = new Map(entriesIn(existing));
  const origin = normalizePlatformOrigin(credentials.url);
  entries.set(origin, credentials.key);

  const platforms = Object.fromEntries(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([url, key]) => [url, { key }]),
  );
  const document = `${JSON.stringify({ version: 1, platforms }, null, 2)}\n`;

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
  /** The platform committed in this agent repository. */
  readonly binding?: string | null;
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

/**
 * Which egma this command talks to.
 *
 * Deliberate beats ambient beats committed: a flag on the command, then the
 * environment, then the repository binding, then Egma Cloud for an unbound
 * repository. A machine-level login never chooses a repository target.
 *
 * An address a person typed is checked here, at the edge that takes it, and a
 * bad one is refused by name rather than carried into the flow.
 */
export function resolvePlatformUrl(choice: PlatformChoice): string {
  const named: readonly [string, string | null | undefined][] = [
    ["--url", choice.flag],
    ["EGMA_URL", choice.env],
    ["the repository platform binding", choice.binding],
  ];
  for (const [where, candidate] of named) {
    const tidy = typeof candidate === "string" ? candidate.trim() : "";
    if (tidy === "") continue;
    try {
      return normalizePlatformOrigin(tidy);
    } catch {
      // The rejected value can itself contain a supplied password. Name only
      // the source, never the value.
      throw new UnusableUrlError(where);
    }
  }
  return DEFAULT_PLATFORM_URL;
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

/** A selected instance is not the platform committed in this repository. */
export class PlatformBindingMismatchError extends Error {
  constructor(binding: PlatformBinding, selected: PlatformIdentity) {
    super(
      `This repository is bound to Egma platform ${binding.instance} at ${binding.origin}, but the selected address identifies platform ${selected.instanceId} at ${selected.origin}. Remove --url or EGMA_URL to use the bound platform. Rebinding is not supported yet. No repository identifiers were sent.`,
    );
    this.name = "PlatformBindingMismatchError";
  }
}

/** The bound platform did not answer, and Cloud was deliberately not tried. */
export class BoundPlatformUnavailableError extends Error {
  constructor(binding: PlatformBinding, selected: string, cause: unknown) {
    super(
      `This repository is bound to Egma platform ${binding.instance} at ${binding.origin}, and Egma at ${selected} did not answer. Start the bound platform and run this again. Egma Cloud was not used, and no repository identifiers were sent.`,
      { cause },
    );
    this.name = "BoundPlatformUnavailableError";
  }
}

/** The committed config could not safely take part in platform resolution. */
export class RepositoryPlatformConfigError extends Error {
  constructor(cause: unknown) {
    super(
      "Egma could not read this repository's egma/config.yaml, so it did not select a platform. Fix that file and run this again. Egma Cloud was not used.",
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
  /** The agent repository whose binding is part of resolution. */
  readonly cwd: string;
  readonly fetchImpl?: Fetch;
}): Promise<VerifiedPlatformAccess> {
  const credentialsFile = credentialsFileIn(choice.env);
  const binding = await bindingIn(choice.cwd);
  const selected = resolvePlatformUrl({
    flag: choice.flag,
    env: choice.env.EGMA_URL,
    binding: binding?.origin ?? null,
  });

  let identity: PlatformIdentity;
  try {
    identity = await readPlatformIdentity(selected, choice.fetchImpl);
  } catch (cause) {
    if (binding !== null && cause instanceof PlatformUnreachableError) {
      throw new BoundPlatformUnavailableError(binding, selected, cause);
    }
    throw cause;
  }

  if (binding !== null && binding.instance !== identity.instanceId) {
    throw new PlatformBindingMismatchError(binding, identity);
  }

  return {
    url: identity.origin,
    instanceId: identity.instanceId,
    credentialsFile,
  };
}
