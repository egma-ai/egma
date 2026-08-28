/**
 * Accept a file path reported by the coding agent without reviewing its contents.
 *
 * The wizard may pass the path to a local process, so it must be a real regular
 * file inside the repository. What the file says and how the coding agent
 * changed it remain the coding agent's responsibility.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { isFenced } from "../acp/fence.ts";

export type RepositoryFileClaim =
  | { readonly kind: "accepted"; readonly file: string }
  | { readonly kind: "refused"; readonly reason: string };

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Follow a reported path only when it stays inside the repository. */
export async function acceptRepositoryFileClaim(
  repository: string,
  claimed: string,
  label: string,
): Promise<RepositoryFileClaim> {
  const shown = claimed.trim();
  if (shown === "") {
    return { kind: "refused", reason: `The coding agent did not report ${label}.` };
  }
  if (isFenced(shown)) {
    return {
      kind: "refused",
      reason: `${shown} is an environment file, so Egma did not use it as ${label}.`,
    };
  }

  let root: string;
  try {
    root = await realpath(repository);
  } catch {
    return {
      kind: "refused",
      reason: `Egma could not open the repository before using ${label}.`,
    };
  }

  const candidate = path.resolve(repository, shown);
  if (!isInside(path.resolve(repository), candidate)) {
    return {
      kind: "refused",
      reason: `${shown} is outside this repository, so Egma did not use it as ${label}.`,
    };
  }

  try {
    if (!(await stat(candidate)).isFile()) {
      return {
        kind: "refused",
        reason: `${shown} is not a regular file, so Egma did not use it as ${label}.`,
      };
    }
    const canonical = await realpath(candidate);
    if (isFenced(canonical)) {
      return {
        kind: "refused",
        reason: `${shown} points to an environment file, so Egma did not use it as ${label}.`,
      };
    }
    if (!isInside(root, canonical)) {
      return {
        kind: "refused",
        reason: `${shown} points outside this repository, so Egma did not use it as ${label}.`,
      };
    }
    return { kind: "accepted", file: path.relative(root, canonical) };
  } catch {
    return {
      kind: "refused",
      reason: `${shown} is not a readable file inside this repository, so Egma did not use it as ${label}.`,
    };
  }
}
