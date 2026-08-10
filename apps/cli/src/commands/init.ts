/**
 * `egma init`: make the folder this repository's tests live in.
 *
 * It asks nothing and it needs no key, because nothing here talks to egma. What
 * it makes is a folder a team commits: a config file naming what the folder
 * points at, a file for the mock tools this project answers with, and a
 * directory for the tests. Nothing secret can land in any of them, so there is
 * no gitignore line to write.
 *
 * Running it twice is safe. A folder that is already here is recognised and
 * left as it is — the second developer to clone the repository runs the same
 * command as the first and changes nothing by it.
 */

import {
  createEgmaFolder,
  MEMORY_FOLDER_NAME,
  type FolderConfig,
  type NamedThing,
} from "../folder/egma-folder.ts";
import { FOLDER_EXIT, type FolderCommandOptions } from "./folder-verbs.ts";

export type InitCommandOptions = FolderCommandOptions & {
  /** What the folder points at, when the caller knows. */
  readonly names: {
    readonly agent: string | null;
    readonly connection: string | null;
    readonly suite: string | null;
  };
};

function named(name: string | null): NamedThing | null {
  return name === null || name.trim() === "" ? null : { name: name.trim(), id: null };
}

export async function runInitCommand(options: InitCommandOptions): Promise<number> {
  const config: FolderConfig = {
    // Nothing here talks to egma, so nothing here knows which egma this
    // repository will belong to. The first command that reaches a platform
    // writes that in.
    platform: null,
    agent: named(options.names.agent),
    connection: named(options.names.connection),
    suite: named(options.names.suite),
  };

  const folder = await createEgmaFolder({ repository: options.cwd, config });

  options.out(`folder: ${folder.paths.root}`);
  options.out(`config: ${folder.paths.config}`);
  options.out(`mock-tools: ${folder.paths.mockTools}`);
  options.out(`tests: ${folder.paths.tests}`);
  for (const key of ["agent", "connection", "suite"] as const) {
    const thing = folder.config[key];
    if (thing !== null) options.out(`${key}: ${thing.name}${thing.id === null ? "" : ` ${thing.id}`}`);
  }
  options.out("committable: yes");
  options.out(`status: ${folder.created ? "created" : "already-there"}`);

  if (!folder.created) {
    options.out(`note: the folder was already here, and nothing in it was changed`);
  }
  // Named so that nothing else claims it, and deliberately not made.
  options.out(`reserved: ${MEMORY_FOLDER_NAME}`);

  return FOLDER_EXIT.done;
}
