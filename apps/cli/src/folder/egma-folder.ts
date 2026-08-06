/**
 * The `egma/` folder in the developer's repository.
 *
 * ```
 * egma/
 *   config.yaml     what this folder points at — names and ids
 *   tests/          one markdown file per test
 * ```
 *
 * Everything in it is committed. Nothing secret ever lands here — the key this
 * machine signs in with lives in the developer's home folder and the vendor's
 * key lives sealed on the platform — so there are no gitignore carve-outs to
 * write and none to forget. That is the whole reason tests are files: a test
 * nobody can review in a pull request is a test nobody reviews.
 *
 * `egma/memory/` is the reserved home for per-agent memory files. It is named
 * here so that nothing else claims the name, and it is deliberately not created.
 *
 * Making the folder is safe to repeat. A folder that is already here is
 * recognised and left exactly as it is: a second developer cloning the
 * repository runs the same command as the first and loses nothing by it.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseTestFile, serializeTestFile, type TestFile } from "./test-file.ts";
import { mappingAtKey, readYaml, textAt, yamlScalar } from "./yaml.ts";

export const FOLDER_NAME = "egma";
export const CONFIG_FILE_NAME = "config.yaml";
export const TESTS_FOLDER_NAME = "tests";
/** Reserved for per-agent memory files. Nothing creates it. */
export const MEMORY_FOLDER_NAME = "memory";

/** Where each part of the folder is, once a repository root is known. */
export type FolderPaths = {
  readonly root: string;
  readonly config: string;
  readonly tests: string;
};

export function folderPathsIn(repository: string): FolderPaths {
  const root = path.join(repository, FOLDER_NAME);
  return {
    root,
    config: path.join(root, CONFIG_FILE_NAME),
    tests: path.join(root, TESTS_FOLDER_NAME),
  };
}

/**
 * One thing the folder points at: what a person calls it, and what egma calls
 * it. Both, because the name is what a developer reads in a pull request and
 * the id is what survives the name being changed.
 */
export type NamedThing = {
  readonly name: string;
  /** Written once egma has registered it; `null` until then. */
  readonly id: string | null;
};

/**
 * What the folder points at. Each may be unset — the folder can exist before
 * the thing it names does, which is what lets `egma init` run in a repository
 * that has not been connected to anything yet.
 */
export type FolderConfig = {
  readonly agent: NamedThing | null;
  readonly connection: NamedThing | null;
  readonly suite: NamedThing | null;
};

export const EMPTY_CONFIG: FolderConfig = { agent: null, connection: null, suite: null };

/** The three keys, in the order they are written and read. */
const CONFIG_KEYS = ["agent", "connection", "suite"] as const;

const CONFIG_HEADER = [
  "# What this folder points at on egma.",
  "#",
  "# Committed on purpose: nothing in this folder is secret. egma writes an id",
  "# beside each name once it has registered one.",
];

export function serializeConfig(config: FolderConfig): string {
  const lines = [...CONFIG_HEADER];
  for (const key of CONFIG_KEYS) {
    const named = config[key];
    if (named === null) {
      lines.push(`${key}:`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(`  name: ${yamlScalar(named.name)}`);
    if (named.id !== null && named.id !== "") {
      lines.push(`  id: ${yamlScalar(named.id)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseConfig(document: string, where: string): FolderConfig {
  const mapping = readYaml(document, where);
  const read = (key: (typeof CONFIG_KEYS)[number]): NamedThing | null => {
    const under = mappingAtKey(mapping, key);
    if (under === null) {
      // A key written as `agent: receptionist` says the name and no id, which
      // is what somebody types by hand before egma has registered anything.
      const bare = textAt(mapping, key);
      return bare === null ? null : { name: bare, id: null };
    }
    const name = textAt(under, "name");
    return name === null ? null : { name, id: textAt(under, "id") };
  };

  return { agent: read("agent"), connection: read("connection"), suite: read("suite") };
}

export async function readConfig(file: string): Promise<FolderConfig> {
  return parseConfig(await readFile(file, "utf8"), path.basename(file));
}

export async function writeConfig(file: string, config: FolderConfig): Promise<void> {
  await writeFile(file, serializeConfig(config), "utf8");
}

/**
 * Change what the folder points at, keeping everything the change does not
 * mention. This is the door the wizard writes an id through once it has
 * registered an agent or a connection.
 */
export async function updateConfig(
  file: string,
  changes: Partial<FolderConfig>,
): Promise<FolderConfig> {
  const held = await readConfig(file);
  const updated: FolderConfig = {
    agent: changes.agent === undefined ? held.agent : changes.agent,
    connection: changes.connection === undefined ? held.connection : changes.connection,
    suite: changes.suite === undefined ? held.suite : changes.suite,
  };
  await writeConfig(file, updated);
  return updated;
}

export type CreateFolderOptions = {
  /** The repository the folder goes in. */
  readonly repository: string;
  /** What it should point at, for a folder being made for the first time. */
  readonly config?: FolderConfig;
};

export type CreatedFolder = {
  readonly paths: FolderPaths;
  /** False when a folder was already here and was left as it was. */
  readonly created: boolean;
  /** What the folder points at, as it now stands on disk. */
  readonly config: FolderConfig;
};

async function exists(where: string): Promise<boolean> {
  try {
    await stat(where);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make the folder, or recognise the one that is here.
 *
 * A config file that already exists is never rewritten — it is somebody's
 * committed file, and the second developer to run this must not turn up in a
 * diff having changed it. Anything missing beside it is made, so a folder that
 * lost its `tests/` directory to a branch merge comes back whole.
 */
export async function createEgmaFolder(
  options: CreateFolderOptions,
): Promise<CreatedFolder> {
  const paths = folderPathsIn(options.repository);
  const already = await exists(paths.config);

  await mkdir(paths.tests, { recursive: true });
  if (!already) {
    await writeConfig(paths.config, options.config ?? EMPTY_CONFIG);
  }

  return { paths, created: !already, config: await readConfig(paths.config) };
}

/** One test file on disk: where it is, and what it says. */
export type FolderTest = {
  /** Absolute. */
  readonly file: string;
  /** As `egma/tests/…` reads in a report, so output is the same everywhere. */
  readonly shown: string;
  readonly test: TestFile;
};

/**
 * A file in `egma/tests/` that egma could not turn into a test, and why.
 *
 * The folder is written by people and by coding agents, and both of them write
 * a broken file sometimes: frontmatter with a list that never closes its
 * bracket is the ordinary one. One such file used to end whatever was reading
 * the folder, which meant one bad file out of twelve threw away the eleven good
 * ones. So it is carried instead of thrown, and every reader says what it will
 * do about it — because a file egma cannot read is still the developer's file
 * and still has to be named.
 */
export type UnreadableTest = {
  /** Absolute. */
  readonly file: string;
  /** As `egma/tests/…` reads in a report. */
  readonly shown: string;
  /** In the reader's own words, which say where in the file the problem is. */
  readonly reason: string;
};

/** What is in the folder: the tests, and the files that are not one. */
export type FolderContents = {
  readonly found: readonly FolderTest[];
  readonly unreadable: readonly UnreadableTest[];
};

/**
 * Everything in the folder, in file-name order so that two runs of the same
 * command report the same thing in the same order.
 *
 * Nothing here throws on one file. A folder is read at the end of a long run —
 * after a coding agent has spent two minutes writing into it — and an exception
 * at that moment loses every good file along with the bad one.
 */
export async function readFolder(paths: FolderPaths): Promise<FolderContents> {
  let names: string[];
  try {
    names = await readdir(paths.tests);
  } catch {
    return { found: [], unreadable: [] };
  }

  const found: FolderTest[] = [];
  const unreadable: UnreadableTest[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const file = path.join(paths.tests, name);
    const shown = `${FOLDER_NAME}/${TESTS_FOLDER_NAME}/${name}`;
    try {
      const document = await readFile(file, "utf8");
      found.push({
        file,
        shown,
        test: parseTestFile(document, name, name.replace(/\.md$/u, "")),
      });
    } catch (problem) {
      unreadable.push({
        file,
        shown,
        reason: problem instanceof Error ? problem.message : String(problem),
      });
    }
  }
  return { found, unreadable };
}

/**
 * Every test file in the folder. The files that are not a test are left out,
 * and a caller that has to name them reads the folder itself.
 */
export async function readFolderTests(paths: FolderPaths): Promise<readonly FolderTest[]> {
  return (await readFolder(paths)).found;
}

/**
 * Write one test file, and say whether that changed anything.
 *
 * The comparison is on the bytes, not on the values, because the promise being
 * kept is about the file: a `pull` straight after a `push` must leave the
 * working tree untouched, and a write that produced identical bytes would still
 * move the modification time and still look like work to whoever is watching.
 */
export async function writeTestFile(
  file: string,
  test: TestFile,
): Promise<{ readonly changed: boolean }> {
  const document = serializeTestFile(test);
  let held: string | null = null;
  try {
    held = await readFile(file, "utf8");
  } catch {
    held = null;
  }
  if (held === document) return { changed: false };

  await writeFile(file, document, "utf8");
  return { changed: true };
}
