/**
 * `egma init`: make the folder this repository's tests live in.
 *
 * What it makes is a folder a team commits: a config file naming what the
 * folder points at, a file for the mock tools this project answers with, and a
 * directory for the tests. Nothing secret can land in any of them, so there is
 * no gitignore line to write.
 *
 * On its own it asks nothing, needs no key, and talks to nobody — a developer
 * with the network cable out gets the whole folder. Naming an address with
 * `--url` adds one thing to that: the selected platform URL, committed beside
 * the names. It is the only binding a repository can gain before sign-in.
 *
 * Running it twice is safe. A folder that is already here is recognised and
 * left as it is — the second developer to clone the repository runs the same
 * command as the first and changes nothing by it. The one exception is the
 * binding, which a folder committed before this repository was on any platform
 * can still gain.
 */

import {
  bindRepositoryPlatform,
  createEgmaFolder,
  MEMORY_FOLDER_NAME,
  type FolderConfig,
  type NamedThing,
  type PlatformBinding,
} from "../folder/egma-folder.ts";
import { FOLDER_EXIT, type FolderCommandOptions } from "./folder-verbs.ts";

export type InitCommandOptions = FolderCommandOptions & {
  /** What the folder points at, when the caller knows. */
  readonly names: {
    readonly agent: string | null;
    readonly connection: string | null;
  };
  /** The platform URL to commit, or `null` when the command named none. */
  readonly binding: PlatformBinding | null;
};

function named(name: string | null): NamedThing | null {
  return name === null || name.trim() === "" ? null : { name: name.trim(), id: null };
}

export async function runInitCommand(options: InitCommandOptions): Promise<number> {
  const config: FolderConfig = {
    platform: options.binding,
    project: null,
    agent: named(options.names.agent),
    connection: named(options.names.connection),
  };

  // Which egma this command talked to, first and in the shape every other verb
  // says it in — and only when it talked to one. `init` on its own reaches no
  // address at all, so it has none to print. What the folder *names* is a
  // different fact, and it is printed below beside everything else the folder
  // names, whether this run wrote it or found it.
  if (options.binding !== null) options.out(`url: ${options.binding.origin}`);

  const folder = await createEgmaFolder({ repository: options.cwd, config });

  // A folder that is already here keeps every byte it has, with one exception,
  // and the exception is why `--url` is worth typing on a second run. A folder
  // somebody committed before this repository was on any platform is how a
  // teammate ordinarily arrives, and recognising that folder and dropping the
  // flag would be the silent no-op this command used to be, moved one case
  // along.
  //
  // Through the same door `connect` binds through, so one function commits a
  // selected platform URL and there is one place to read to know what it means.
  // Nothing it can refuse is reachable from here: an address that disagrees
  // with a binding already in this folder was turned away before any of this
  // ran, and a binding that agrees is handed straight back unwritten.
  const held = folder.config;
  const committed =
    options.binding !== null && held.platform === null
      ? await bindRepositoryPlatform(options.cwd, options.binding)
      : held;
  const newlyBound = held.platform === null && committed.platform !== null;

  options.out(`folder: ${folder.paths.root}`);
  options.out(`config: ${folder.paths.config}`);
  options.out(`mock-tools: ${folder.paths.mockTools}`);
  options.out(`tests: ${folder.paths.tests}`);
  // Read from the file for the same reason the names under it are: what this
  // reports is what a teammate cloning the repository will get, not what this
  // one run happened to be handed.
  if (committed.platform !== null) options.out(`platform: ${committed.platform.origin}`);
  for (const key of ["project", "agent", "connection"] as const) {
    const thing = committed[key];
    if (thing !== null) options.out(`${key}: ${thing.name}${thing.id === null ? "" : ` ${thing.id}`}`);
  }
  options.out("committable: yes");
  options.out(`status: ${folder.created ? "created" : "already-there"}`);

  if (!folder.created) {
    // `already-there` on its own reads as a run that changed nothing, so the
    // one run that changes something says which thing it changed.
    options.out(
      newlyBound
        ? "note: the folder was already here, and gained the platform it names"
        : "note: the folder was already here, and nothing in it was changed",
    );
  }
  // Named so that nothing else claims it, and deliberately not made.
  options.out(`reserved: ${MEMORY_FOLDER_NAME}`);

  return FOLDER_EXIT.done;
}
