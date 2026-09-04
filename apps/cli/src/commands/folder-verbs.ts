/**
 * What `init`, `pull` and `push` need before they run.
 */

import { readConfig, folderPathsIn, type FolderPaths } from "../folder/egma-folder.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import type { Fetch } from "../platform/device-flow.ts";
import { notSignedInRefusal, signedInAt, type SignedIn } from "../platform/signed-in.ts";

export const FOLDER_EXIT = {
  /** It happened. */
  done: 0,
  /** There was nothing here to work with, or the command was not one. */
  nothing: 1,
  /** This machine holds no key for this egma. */
  notSignedIn: 1,
  /** egma did not answer, or answered and would not do it. */
  unreachable: 1,
  /** Refused: the platform has moved, and a pull is owed first. */
  moved: 1,
  /** egma turned a test away at its door. */
  turnedAway: 1,
  /** The platform write succeeded, but this attempt could not materialize it locally. */
  localWriteFailed: 1,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

/** What every one of these verbs is handed. */
export type FolderCommandOptions = {
  readonly access: PlatformAccess;
  /** The repository to work in, already resolved. */
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  /** The network boundary, replaced only by command-level tests. */
  readonly fetchImpl?: Fetch;
};

/** The folder and the key, or the number to exit with instead. */
export type Ready =
  | { readonly kind: "ready"; readonly paths: FolderPaths; readonly signedIn: SignedIn }
  | { readonly kind: "stop"; readonly code: number };

/**
 * Everything `pull` and `push` need before either can start: a folder to sync,
 * and a key for the egma being synced with.
 *
 * The folder is checked first. A developer in the wrong directory is told that
 * before they are told to sign in, because signing in would not have helped.
 */
export async function readyToSync(options: FolderCommandOptions): Promise<Ready> {
  const paths = folderPathsIn(options.cwd);

  try {
    await readConfig(paths.config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      options.fail(
        `There is no egma/config.yaml in ${options.cwd}. Run egma init here, or run this from the folder your repository is in.`,
      );
      return { kind: "stop", code: FOLDER_EXIT.nothing };
    }
    options.fail(
      cause instanceof Error
        ? cause.message
        : "Egma could not read egma/config.yaml. Fix the file and run this again.",
    );
    return { kind: "stop", code: FOLDER_EXIT.nothing };
  }

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.fail(notSignedInRefusal(options.access.url));
    return { kind: "stop", code: FOLDER_EXIT.notSignedIn };
  }

  return { kind: "ready", paths, signedIn };
}
