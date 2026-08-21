/**
 * The `egma/` folder in the developer's repository.
 *
 * ```
 * egma/
 *   config.yaml     what this folder points at — names and ids
 *   mock-tools.md   what egma answers for the agent's tools with
 *   tests/          one direct directory per test suite
 *     release/
 *       suite.yaml  stable suite identity and current display name
 *       *.md        the tests in that suite
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

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MOCK_TOOLS_HEADING,
  MOCK_TOOLS_LINE,
  readMockTools,
  writeMockTools,
  type MockToolEntry,
} from "./mock-tools.ts";
import { normalizePlatformOrigin } from "../platform/url.ts";
import { parseTestFile, serializeTestFile, type TestFile } from "./test-file.ts";
import { mappingAtKey, readYaml, textAt, yamlScalar } from "./yaml.ts";
import {
  isPortableSuiteDirectory,
  isPortableTestFile,
  MAX_PORTABLE_COMPONENT_LENGTH,
} from "./portable-path.ts";

export const FOLDER_NAME = "egma";
export const CONFIG_FILE_NAME = "config.yaml";
export const MOCK_TOOLS_FILE_NAME = "mock-tools.md";
export const TESTS_FOLDER_NAME = "tests";
export const SUITE_MANIFEST_FILE_NAME = "suite.yaml";
/** Reserved for per-agent memory files. Nothing creates it. */
export const MEMORY_FOLDER_NAME = "memory";

/** Where each part of the folder is, once a repository root is known. */
export type FolderPaths = {
  readonly root: string;
  readonly config: string;
  /** The project's own mock tools. A test's overrides live in the test. */
  readonly mockTools: string;
  readonly tests: string;
};

export function folderPathsIn(repository: string): FolderPaths {
  const root = path.join(repository, FOLDER_NAME);
  return {
    root,
    config: path.join(root, CONFIG_FILE_NAME),
    mockTools: path.join(root, MOCK_TOOLS_FILE_NAME),
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

/** The non-secret URL of the Egma platform that owns this folder. */
export type PlatformBinding = {
  /** The platform's normalized web origin. */
  readonly origin: string;
};

/**
 * What the folder points at. Each may be unset — the folder can exist before
 * the thing it names does, which is what lets `egma init` run in a repository
 * that has not been connected to anything yet.
 */
export type FolderConfig = {
  readonly platform: PlatformBinding | null;
  readonly project: NamedThing | null;
  readonly agent: NamedThing | null;
  readonly connection: NamedThing | null;
};

export const EMPTY_CONFIG: FolderConfig = {
  platform: null,
  project: null,
  agent: null,
  connection: null,
};

/** The resource keys, in the order they are written and read. */
const CONFIG_KEYS = ["project", "agent", "connection"] as const;
const ROOT_CONFIG_KEYS = ["platform", ...CONFIG_KEYS] as const;

const CONFIG_HEADER = [
  "# What this folder points at on Egma.",
  "#",
  "# Committed on purpose: nothing in this folder is secret. Egma writes an id",
  "# beside each name once it has registered one.",
];

export function serializeConfig(config: FolderConfig): string {
  const lines = [...CONFIG_HEADER];
  if (config.platform == null) {
    lines.push("platform:");
  } else {
    lines.push("platform:");
    lines.push(`  origin: ${yamlScalar(config.platform.origin)}`);
  }
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

/**
 * The committed origin, in the one shape every origin is compared in.
 *
 * A person edits this file, and a person writes `https://egma.example/`, or
 * `https://EGMA.example`, or the default port spelled out, where egma would
 * have written `https://egma.example`. All of them name the same platform, so
 * all of them have to read back as the same platform — otherwise the binding
 * disagrees with itself, and a repository is refused for moving nowhere.
 *
 * An origin egma cannot make sense of is left exactly as it was written. It is
 * refused by name one step later, at the edge that takes addresses, and quietly
 * rewriting it here would hide which line in the file is the wrong one.
 */
function committedOrigin(written: string): string {
  try {
    return normalizePlatformOrigin(written);
  } catch {
    return written;
  }
}

export function parseConfig(document: string, where: string): FolderConfig {
  const mapping = readYaml(document, where);
  const unknown = Object.keys(mapping).filter(
    (key) => !(ROOT_CONFIG_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${where} has unsupported ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}.`,
    );
  }
  const platformMapping = mappingAtKey(mapping, "platform");
  const platformScalar = textAt(mapping, "platform");
  const platform =
    platformMapping === null
      ? (() => {
          if (platformScalar !== null) {
            throw new Error(
              `${where} has a platform value without an origin. Run the Egma wizard to repair the repository binding.`,
            );
          }
          return null;
        })()
      : (() => {
          const origin = textAt(platformMapping, "origin");
          if (origin === null) {
            throw new Error(
              `${where} has a platform binding without an origin. Run the Egma wizard to repair it.`,
            );
          }
          return { origin: committedOrigin(origin) };
        })();
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

  return {
    platform,
    project: read("project"),
    agent: read("agent"),
    connection: read("connection"),
  };
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
    platform: changes.platform === undefined ? held.platform : changes.platform,
    project: changes.project === undefined ? held.project : changes.project,
    agent: changes.agent === undefined ? held.agent : changes.agent,
    connection: changes.connection === undefined ? held.connection : changes.connection,
  };
  await writeConfig(file, updated);
  return updated;
}

/**
 * Which committed names carry an identifier only one platform can resolve.
 *
 * Config identities and suite manifest identities are issued by one platform.
 * An unbound repository that still carries any of them is a half-applied move
 * and must stop before a different platform is contacted.
 */
export function platformOwnedIds(
  config: FolderConfig,
  suiteIds: readonly string[] = [],
): readonly string[] {
  return [
    ...CONFIG_KEYS.filter((key) => {
      const named = config[key];
      return named !== null && named.id !== null && named.id !== "";
    }).map((key) => `${key} in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`),
    ...suiteIds.map((id) => `suite ${id} in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/${SUITE_MANIFEST_FILE_NAME}`),
  ];
}

/** The ordered, reviewable local repair for an intentional platform move. */
export const MOVE_TO_ANOTHER_PLATFORM: readonly string[] = [
  "To move this repository to another platform, delete these in this order and run egma again:",
  `  - the id: line under agent: in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - the id: line under connection: in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - the id: line under project: in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - every id: line in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/${SUITE_MANIFEST_FILE_NAME}`,
  `  - the version: line at the top of every file in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/`,
  `  - last of all, the whole platform: block in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  "Delete the platform block last: it is what keeps every id above it on the platform that issued it, so until it is gone nothing can leave for another one.",
  "Keep every name. Your tests move with you and are created again on the new platform; the runs you have already done stay on the platform that ran them, because a run's numbers only mean anything against the versions that platform minted.",
];

/**
 * A refusal with the whole move under it, one blank line apart.
 *
 * Every refusal that stands between a developer and another platform ends the
 * same way, because they are not different problems to the person who has one:
 * whichever of them fires, the next thing they need is the same list. One
 * function so that the list cannot drift into three versions of itself, and so
 * that the blank line before it is always there — it is what makes the block
 * below it a block rather than the tail of a paragraph.
 */
export function teachingTheMove(refusal: string): string {
  return [refusal, "", ...MOVE_TO_ANOTHER_PLATFORM].join("\n");
}

/**
 * Commit the selected platform before anything creates platform-owned resource
 * identifiers.
 *
 * A retry is byte-stable. A binding that is already here is never rewritten.
 * The origin is the address every clone of this repository will use, so a run
 * that quietly changed it would move other people's repository for them.
 */
export async function bindRepositoryPlatform(
  repository: string,
  binding: PlatformBinding,
): Promise<FolderConfig> {
  const paths = folderPathsIn(repository);
  let held: FolderConfig;
  try {
    held = await readConfig(paths.config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return (
      await createEgmaFolder({
        repository,
        config: { ...EMPTY_CONFIG, platform: binding },
      })
    ).config;
  }

  if (held.platform !== null) {
    if (held.platform.origin !== binding.origin) {
      throw new Error(
        `This repository records the Egma platform at ${held.platform.origin}, and this run selected ${binding.origin}. Egma will not move a committed platform address for you. Use ${held.platform.origin}, or edit egma/config.yaml on purpose.`,
      );
    }
    return held;
  }
  return updateConfig(paths.config, { platform: binding });
}

/**
 * What `egma/mock-tools.md` opens with, above the mock tools themselves.
 *
 * It is prose rather than a comment because it is markdown a person reads in a
 * pull request, and it says the three things nothing else in the folder would
 * teach: that an answer belongs here, that this one authored thing is not
 * versioned and so the last write wins, and that neither verb removes one.
 */
const MOCK_TOOLS_HEADER = [
  // Deliberately not the section's own heading: the section is found by that
  // heading, and a title saying the same words would be the one the reader
  // stopped at, leaving every mock tool below it unread.
  "# The mock tools this project answers with",
  "",
  "Each one answers for a tool of the voice agent while a simulation runs, so a",
  "test never reaches the real backend and can ask for the branch it needs. An",
  "answer may be a failure, and may hold Egma back a while so a mocked backend",
  "takes as long as the real one.",
  "",
  "Committed like everything else in this folder: an answer is your own data, and",
  "nothing here is secret.",
  "",
  "Egma writes this file from what it holds, and a mock tool is not versioned — so",
  "`egma pull` writes Egma's answer over what is here, and `egma push` writes what",
  "is here over Egma's. Whichever ran last, wins. A mock tool Egma has never heard",
  "of is left exactly as it is until you push it.",
  "",
  "Neither verb removes one: a block taken out of this file comes back on the next",
  "`egma pull`, exactly as deleting a test file does not delete the test.",
  "",
  "This prose is Egma's own. Either verb rewrites the whole file from what Egma",
  "holds, so a note added up here does not survive the next one.",
  "",
  "A test that needs a different answer writes it under the same heading in its own",
  "file. That override is the test's own content, and is versioned with the test.",
  "",
];

export function serializeMockToolsFile(
  entries: readonly MockToolEntry[],
): string {
  // The heading is written even with nothing under it, unlike a test's own
  // section: this file is the mock tools, and one with none has to say where
  // the first one goes.
  const written = writeMockTools(entries);
  const section = written.length === 0 ? [MOCK_TOOLS_HEADING] : written;
  return [...MOCK_TOOLS_HEADER, ...section, ""].join("\n");
}

/**
 * The mock tools one file says, whatever prose somebody wrote above them.
 *
 * The *first* heading opens the section here, where a test file takes its last
 * one. The difference is the shape of the two documents rather than two minds
 * about one rule: everything above the heading in this file is the prose egma
 * writes at the top — whose own title deliberately does not read as the section
 * heading — and everything below it is mock tools, one of which could perfectly
 * well be a tool somebody named `mock tools`.
 *
 * A file with no heading at all is read as holding none rather than refused: a
 * folder somebody emptied on purpose is still a folder egma can push.
 */
export function parseMockToolsFile(
  document: string,
  where: string,
): readonly MockToolEntry[] {
  const lines = document.split("\n");
  const at = lines.findIndex((line) => MOCK_TOOLS_LINE.test(line.trim()));
  return at === -1 ? [] : readMockTools(lines.slice(at + 1), where);
}

/**
 * The project's mock tools as they now stand on disk. A folder that has no such
 * file yet holds no mock tools, which is what a folder made before this file
 * existed says and what a folder somebody has not pulled into says too.
 */
export async function readMockToolsFile(
  file: string,
): Promise<readonly MockToolEntry[]> {
  let document: string;
  try {
    document = await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return parseMockToolsFile(document, `${FOLDER_NAME}/${MOCK_TOOLS_FILE_NAME}`);
}

/**
 * Write the project's mock tools, and say whether that changed anything. The
 * comparison is on the bytes, for the reason `writeTestFile` compares bytes.
 */
export async function writeMockToolsFile(
  file: string,
  entries: readonly MockToolEntry[],
): Promise<{ readonly changed: boolean }> {
  const document = serializeMockToolsFile(entries);
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
 * A file that already exists is never rewritten — it is somebody's committed
 * file, and the second developer to run this must not turn up in a diff having
 * changed it. Anything missing beside it is made, so a folder that lost its
 * `tests/` directory to a branch merge comes back whole, and a folder made
 * before mock tools existed grows the file the first time this runs again.
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
  // Empty, and here from the start: the folder is what teaches a developer and
  // a coding agent where a mock tool goes, and a file that is not there teaches
  // nobody. Never rewritten, so mock tools somebody authored survive a second
  // run of `egma init`.
  if (!(await exists(paths.mockTools))) {
    await writeMockToolsFile(paths.mockTools, []);
  }

  return { paths, created: !already, config: await readConfig(paths.config) };
}

/** The stable identity and mutable display name kept in one suite directory. */
export type SuiteManifest = {
  readonly id: string;
  readonly name: string;
};

const SUITE_ID = /^ste_[0-9A-HJKMNP-TV-Z]{26}$/u;
const SUITE_MANIFEST_KEYS = ["id", "name"] as const;

export function serializeSuiteManifest(manifest: SuiteManifest): string {
  return `id: ${yamlScalar(manifest.id)}\nname: ${yamlScalar(manifest.name)}\n`;
}

export function parseSuiteManifest(
  document: string,
  where: string,
): SuiteManifest {
  const mapping = readYaml(document, where);
  const keys = Object.keys(mapping);
  const unknown = keys.filter(
    (key) => !(SUITE_MANIFEST_KEYS as readonly string[]).includes(key),
  );
  const missing = SUITE_MANIFEST_KEYS.filter((key) => !keys.includes(key));
  if (unknown.length > 0 || missing.length > 0 || keys.length !== 2) {
    const details = [
      ...(missing.length === 0 ? [] : [`missing ${missing.join(", ")}`]),
      ...(unknown.length === 0 ? [] : [`unsupported ${unknown.join(", ")}`]),
    ].join("; ");
    throw new Error(
      `${where} must contain exactly id and name${details === "" ? "" : ` (${details})`}.`,
    );
  }
  const id = textAt(mapping, "id");
  const writtenName = mapping["name"];
  const name = typeof writtenName === "string" ? writtenName : null;
  if (id === null || !SUITE_ID.test(id)) {
    throw new Error(
      `${where} has an invalid suite id. Expected ste_ followed by 26 Crockford base32 characters.`,
    );
  }
  if (name === null) {
    throw new Error(`${where} has a non-string suite name.`);
  }
  if (name.trim() === "") {
    throw new Error(`${where} has a blank suite name.`);
  }
  if (name !== name.trim()) {
    throw new Error(`${where} has outer whitespace in its suite name.`);
  }
  return { id, name };
}

export async function writeSuiteManifest(
  file: string,
  manifest: SuiteManifest,
): Promise<{ readonly changed: boolean }> {
  const document = serializeSuiteManifest(manifest);
  let held: string | null = null;
  try {
    held = await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  if (held === document) return { changed: false };
  await writeFile(file, document, "utf8");
  return { changed: true };
}

/** One test file on disk: where it is, which suite owns it, and what it says. */
export type FolderTest = {
  /** Absolute. */
  readonly file: string;
  /** As `egma/tests/…` reads in a report, so output is the same everywhere. */
  readonly shown: string;
  readonly suiteId: string;
  readonly suiteDirectory: string;
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

/** One complete direct child of `egma/tests`. */
export type FolderSuite = {
  readonly directory: string;
  readonly root: string;
  readonly manifestFile: string;
  readonly manifest: SuiteManifest;
  readonly tests: readonly FolderTest[];
};

/** One complete validated repository value. */
export type RepositoryContents = {
  readonly config: FolderConfig;
  readonly mockTools: readonly MockToolEntry[];
  readonly suites: readonly FolderSuite[];
};

export class RepositoryValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(
      [
        "The Egma repository is invalid:",
        ...issues.map((issue) => `- ${issue}`),
        "No platform write was made.",
      ].join("\n"),
    );
    this.name = "RepositoryValidationError";
    this.issues = issues;
  }
}

function reasonOf(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

function shown(...parts: readonly string[]): string {
  return path.posix.join(FOLDER_NAME, TESTS_FOLDER_NAME, ...parts);
}

/**
 * Parse the repository as one value before a command takes any side effect.
 *
 * The directory name is never identity. Only `suite.yaml.id` joins this local
 * path to a platform suite, so renaming an existing directory changes no
 * product data and a pull never needs to move it back.
 */
export async function readRepository(paths: FolderPaths): Promise<RepositoryContents> {
  const issues: string[] = [];
  let config: FolderConfig = EMPTY_CONFIG;
  let mockTools: readonly MockToolEntry[] = [];

  try {
    config = await readConfig(paths.config);
  } catch (problem) {
    issues.push(`${FOLDER_NAME}/${CONFIG_FILE_NAME}: ${reasonOf(problem)}`);
  }
  try {
    mockTools = await readMockToolsFile(paths.mockTools);
  } catch (problem) {
    issues.push(`${FOLDER_NAME}/${MOCK_TOOLS_FILE_NAME}: ${reasonOf(problem)}`);
  }

  let entries: Dirent[] = [];
  try {
    entries = await readdir(paths.tests, { withFileTypes: true });
  } catch (problem) {
    issues.push(`${FOLDER_NAME}/${TESTS_FOLDER_NAME}: ${reasonOf(problem)}`);
  }

  const suites: FolderSuite[] = [];
  const suitePathByFold = new Map<string, string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const suiteRoot = path.join(paths.tests, entry.name);
    const foldedSuitePath = entry.name.normalize("NFKC").toLowerCase();
    const firstSuitePath = suitePathByFold.get(foldedSuitePath);
    if (firstSuitePath !== undefined) {
      issues.push(`${shown(entry.name)} collides with ${shown(firstSuitePath)} on a case-insensitive file system.`);
      continue;
    }
    suitePathByFold.set(foldedSuitePath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push(`${shown(entry.name)} must be a direct suite directory.`);
      continue;
    }
    if (!isPortableSuiteDirectory(entry.name)) {
      issues.push(`${shown(entry.name)} is not a portable suite directory. Use at most ${String(MAX_PORTABLE_COMPONENT_LENGTH)} lower-case letters, numbers, and hyphens, and do not use a Windows device name.`);
    }

    const manifestFile = path.join(suiteRoot, SUITE_MANIFEST_FILE_NAME);
    let manifest: SuiteManifest | null = null;
    try {
      manifest = parseSuiteManifest(
        await readFile(manifestFile, "utf8"),
        shown(entry.name, SUITE_MANIFEST_FILE_NAME),
      );
    } catch (problem) {
      issues.push(
        `${shown(entry.name, SUITE_MANIFEST_FILE_NAME)}: ${reasonOf(problem)}`,
      );
    }

    let children: Dirent[] = [];
    try {
      children = await readdir(suiteRoot, { withFileTypes: true });
    } catch (problem) {
      issues.push(`${shown(entry.name)}: ${reasonOf(problem)}`);
    }

    const tests: FolderTest[] = [];
    const testPathByFold = new Map<string, string>();
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (child.name === SUITE_MANIFEST_FILE_NAME && child.isFile()) continue;
      const foldedTestPath = child.name.normalize("NFKC").toLowerCase();
      const firstTestPath = testPathByFold.get(foldedTestPath);
      if (firstTestPath !== undefined) {
        issues.push(`${shown(entry.name, child.name)} collides with ${shown(entry.name, firstTestPath)} on a case-insensitive file system.`);
        continue;
      }
      testPathByFold.set(foldedTestPath, child.name);
      if (!child.isFile() || child.isSymbolicLink() || !child.name.endsWith(".md")) {
        issues.push(
          `${shown(entry.name, child.name)} is not a direct Markdown test or ${SUITE_MANIFEST_FILE_NAME}.`,
        );
        continue;
      }
      if (!isPortableTestFile(child.name)) {
        issues.push(`${shown(entry.name, child.name)} is not a portable test file. Use at most ${String(MAX_PORTABLE_COMPONENT_LENGTH)} lower-case letters, numbers, and hyphens including .md, and do not use a Windows device name.`);
        continue;
      }
      if (manifest === null) continue;
      const file = path.join(suiteRoot, child.name);
      try {
        const document = await readFile(file, "utf8");
        tests.push({
          file,
          shown: shown(entry.name, child.name),
          suiteId: manifest.id,
          suiteDirectory: entry.name,
          test: parseTestFile(document, shown(entry.name, child.name), child.name.replace(/\.md$/u, "")),
        });
      } catch (problem) {
        issues.push(`${shown(entry.name, child.name)}: ${reasonOf(problem)}`);
      }
    }

    if (manifest !== null) {
      suites.push({
        directory: entry.name,
        root: suiteRoot,
        manifestFile,
        manifest,
        tests,
      });
    }
  }

  const directoryBySuite = new Map<string, string>();
  for (const suite of suites) {
    const first = directoryBySuite.get(suite.manifest.id);
    if (first !== undefined) {
      issues.push(
        `suite id ${suite.manifest.id} is used by both ${shown(first)} and ${shown(suite.directory)}.`,
      );
    } else {
      directoryBySuite.set(suite.manifest.id, suite.directory);
    }
  }

  const fileByVersion = new Map<string, string>();
  for (const test of suites.flatMap((suite) => suite.tests)) {
    const version = test.test.version;
    if (version === null || version === "") continue;
    const first = fileByVersion.get(version);
    if (first !== undefined) {
      issues.push(`test version ${version} is used by both ${first} and ${test.shown}.`);
    } else {
      fileByVersion.set(version, test.shown);
    }
  }

  if (issues.length > 0) throw new RepositoryValidationError(issues);
  return { config, mockTools, suites };
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
