/**
 * The two environment lines a monitored LiveKit worker exports with, written
 * into the repository's own `.env` — by Egma's own code, and never by a coding
 * agent.
 *
 * The SDK's `monitor_livekit(ctx)` reads where Egma is and the project key to
 * reach it with out of the process it runs in. Somebody has to put them there,
 * and it is deterministic work with a live credential in it: exactly the kind
 * of thing that belongs in code a person can read once rather than in a model's
 * judgement each time. The coding-agent skill is told to name the two variables
 * and to touch no environment file at all.
 *
 * Three rules, and each is here because of what it prevents:
 *
 * - **Refuse when Git does not ignore the file.** A key in a committed file is
 *   a key in everybody's clone and in the history for ever. Git itself is
 *   asked, because a hand-rolled reading of `.gitignore` would disagree with it
 *   over negations, nested files and the developer's own global excludes — and
 *   the disagreement would surface as Egma writing a secret into a file Git was
 *   about to take. Cannot tell is treated as not ignored: the printed lines are
 *   a working answer, and a wrong guess here is not recoverable.
 * - **Idempotent.** A second run replaces the value in place rather than
 *   appending beside it, so the file never ends up with two answers to one
 *   question and a worker reading whichever the loader saw last.
 * - **Always print the lines.** The `.env` serves the machine the repository is
 *   checked out on. Wherever the worker actually runs — a container, a
 *   platform's dashboard, a CI secret store — the developer needs the same two
 *   lines to put there, and they are the deliverable whether the write happened
 *   or not.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MintedSecret } from "../platform/api-keys.ts";

/** The file the lines go in, and what the two of them are called. */
export const ENV_FILE_NAME = ".env";
export const ENV_URL_VARIABLE = "EGMA_URL";
export const ENV_KEY_VARIABLE = "EGMA_API_KEY";

/** What the developer is told before Egma writes a live credential down. */
export const ENV_CONSENT_LINE =
  `Egma will write ${ENV_URL_VARIABLE} and ${ENV_KEY_VARIABLE} into ` +
  `${ENV_FILE_NAME} so your worker can export. The key is minted for this ` +
  `project alone, and Egma refuses to write it unless Git ignores ` +
  `${ENV_FILE_NAME}.`;

/** What Egma is handed to write down. */
export type EnvValues = {
  /** Which Egma the worker exports to. */
  readonly url: string;
  /** The minted project key, asked for its value at the moment it is written. */
  readonly key: MintedSecret;
};

/**
 * The two lines, exactly as they go in the file and exactly as they are
 * printed for a deployment environment.
 *
 * One function, so the file and the screen can never say different things.
 */
export function envLines(values: EnvValues): readonly string[] {
  return [
    `${ENV_URL_VARIABLE}=${values.url}`,
    `${ENV_KEY_VARIABLE}=${values.key.reveal()}`,
  ];
}

/** The same two lines as a shell would export them, for a deployment. */
export function exportLines(values: EnvValues): readonly string[] {
  return envLines(values).map((line) => `export ${line}`);
}

export type EnvWrite =
  | {
      readonly kind: "written";
      /** The path, relative to the repository, that was changed. */
      readonly file: string;
      /** Whether the file already held one of the two and had it replaced. */
      readonly replaced: boolean;
    }
  /**
   * Nothing was written, and why — in words that say what to do instead.
   *
   * Never fatal on its own: the lines are printed either way, so a refusal here
   * costs the developer one copy and paste rather than the walk.
   */
  | { readonly kind: "refused"; readonly reason: string };

/** What Git says about one path: ignored, not ignored, or it would not say. */
export type IgnoreAnswer = "ignored" | "not-ignored" | "unknown";

/**
 * Whether Git ignores a path, asked of Git.
 *
 * `git check-ignore` answers 0 for ignored and 1 for not, and anything else —
 * no Git on this machine, a folder that is not a repository — is the answer
 * that Egma cannot tell. It is run with `--no-optional-locks` so that asking a
 * question never touches the developer's index.
 */
export async function gitIgnores(
  repository: string,
  file: string,
): Promise<IgnoreAnswer> {
  return new Promise<IgnoreAnswer>((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "check-ignore", "--quiet", "--", file],
      { cwd: repository },
      (error) => {
        if (error === null) {
          resolve("ignored");
          return;
        }
        const code = (error as { code?: unknown }).code;
        resolve(code === 1 ? "not-ignored" : "unknown");
      },
    );
  });
}

/** What a developer is told when Egma will not write the file. */
function refusalFor(answer: Exclude<IgnoreAnswer, "ignored">): string {
  if (answer === "not-ignored") {
    return (
      `Git does not ignore ${ENV_FILE_NAME} here, so Egma did not write the ` +
      `key into it — a key in a committed file is a key in every clone. Add ` +
      `${ENV_FILE_NAME} to .gitignore and run this again, or put the two lines ` +
      `below wherever this worker gets its environment.`
    );
  }
  return (
    `Egma could not ask Git whether ${ENV_FILE_NAME} is ignored here, so it ` +
    `did not write the key into it. Put the two lines below wherever this ` +
    `worker gets its environment.`
  );
}

/**
 * One variable's line in a file, in either form it is written in.
 *
 * `export NAME=` matters as much as `NAME=`: a `.env` that is sourced by a
 * shell rather than read by a loader is written that way, and rewriting one
 * form as the other would leave a file whose values stop reaching the process.
 */
function assignmentOf(variable: string): RegExp {
  return new RegExp(`^(\\s*)(export\\s+)?${variable}\\s*=`, "u");
}

/**
 * Put the two lines in the repository's `.env`, or say why not.
 *
 * The file is rewritten whole rather than appended to, because replacing a
 * value in place is the only shape that stays right on the second run — and a
 * file that ends without a newline is given one, so the first line Egma adds is
 * a line rather than the tail of somebody else's.
 */
export async function writeEnvFile(
  repository: string,
  values: EnvValues,
): Promise<EnvWrite> {
  const ignored = await gitIgnores(repository, ENV_FILE_NAME);
  if (ignored !== "ignored") {
    return { kind: "refused", reason: refusalFor(ignored) };
  }

  const file = path.join(repository, ENV_FILE_NAME);

  /*
   * Only an ordinary file, or no file, takes a live key. A symlink is the
   * developer pointing the name somewhere else, and following it would put the
   * key wherever that is — outside the repository the ignore check was asked
   * about. The link is not replaced either: it is theirs, and the printed lines
   * are the working answer.
   */
  try {
    const standing = await lstat(file);
    if (!standing.isFile()) {
      return {
        kind: "refused",
        reason:
          `${ENV_FILE_NAME} here is ${standing.isSymbolicLink() ? "a symbolic link" : "not an ordinary file"}, ` +
          "so Egma did not write the key into it. Put the two lines below " +
          "wherever this worker gets its environment.",
      };
    }
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") {
      return {
        kind: "refused",
        reason:
          `Egma could not look at ${ENV_FILE_NAME}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. ` +
          "Put the two lines below wherever this worker gets its environment.",
      };
    }
  }

  let held = "";
  try {
    held = await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as { code?: string }).code !== "ENOENT") {
      return {
        kind: "refused",
        reason:
          `Egma could not read ${ENV_FILE_NAME}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. ` +
          "Put the two lines below wherever this worker gets its environment.",
      };
    }
  }

  const wanted = envLines(values);
  const variables = [ENV_URL_VARIABLE, ENV_KEY_VARIABLE];
  const existing = held === "" ? [] : held.split("\n");
  const kept: string[] = [];
  let replaced = false;
  // A trailing newline splits into one empty last element. It is dropped here
  // and put back below, so a file that ended with one still does.
  const endedWithNewline = existing.at(-1) === "";
  if (endedWithNewline) existing.pop();

  for (const line of existing) {
    const at = variables.findIndex((variable) => assignmentOf(variable).test(line));
    if (at === -1) {
      kept.push(line);
      continue;
    }
    // In place, and in the form the line was already written in, so the
    // developer's own ordering and their own loader both survive a rotation.
    // A file that somehow holds two lines for one variable keeps two: they are
    // now the same answer, and deleting a line nobody asked Egma to delete is
    // worse than leaving a harmless repeat.
    const shape = assignmentOf(variables[at] as string).exec(line);
    kept.push(`${shape?.[1] ?? ""}${shape?.[2] ?? ""}${wanted[at] as string}`);
    replaced = true;
  }
  for (const [at, line] of wanted.entries()) {
    if (existing.some((held_) => assignmentOf(variables[at] as string).test(held_))) {
      continue;
    }
    kept.push(line);
  }

  /*
   * Written beside the file and renamed over it, never truncated in place: an
   * interruption leaves the developer's own `.env` exactly as it was, and the
   * swap is one motion. The temporary file is born private, and the rename
   * carries that with it — a live key was just written into this file, so it
   * lands readable by the developer alone whatever mode the old one had.
   */
  const staged = path.join(
    repository,
    `.${ENV_FILE_NAME}.egma-${randomBytes(6).toString("hex")}`,
  );
  try {
    await writeFile(staged, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(staged, file);
  } catch (cause) {
    await rm(staged, { force: true }).catch(() => undefined);
    return {
      kind: "refused",
      reason:
        `Egma could not write ${ENV_FILE_NAME}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Put the two lines below wherever this worker gets its environment.",
    };
  }

  return { kind: "written", file: ENV_FILE_NAME, replaced };
}
