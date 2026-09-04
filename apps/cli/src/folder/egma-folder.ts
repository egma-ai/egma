/**
 * The `egma/` folder in the developer's repository.
 *
 * ```
 * egma/
 *   config.yaml     one platform and project, with many agents and connections
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

import { FolderProblem, namesItsPlace } from "./problem.ts";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizePlatformOrigin } from "../platform/url.ts";
import { parseTestFile, serializeTestFile, type TestFile } from "./test-file.ts";
import {
  mappingAtKey,
  readYaml,
  sequenceAt,
  textAt,
  yamlScalar,
  type YamlMapping,
} from "./yaml.ts";
import {
  isPortableSuiteDirectory,
  isPortableTestFile,
  MAX_PORTABLE_COMPONENT_LENGTH,
} from "./portable-path.ts";

export const FOLDER_NAME = "egma";
export const CONFIG_FILE_NAME = "config.yaml";
export const TESTS_FOLDER_NAME = "tests";
export const SUITE_MANIFEST_FILE_NAME = "suite.yaml";
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

/** A platform-owned thing: a reviewable name and its stable identity. */
export type IdentifiedThing = {
  readonly name: string;
  readonly id: string;
};

/** One committed way Egma can reach an agent. */
export type FolderConnection = IdentifiedThing;

/** One agent in this project, and every committed way Egma can reach it. */
export type FolderAgent = IdentifiedThing & {
  /** Which provider runs this agent. */
  readonly platform: "retell" | "livekit";
  readonly connections: readonly FolderConnection[];
};

/** The non-secret URL of the Egma platform that owns this folder. */
export type PlatformBinding = {
  /** The platform's normalized web origin. */
  readonly origin: string;
};

/**
 * What the folder points at. The platform and project may be unset and the
 * agent list may be empty, which lets `egma init` run before registration.
 */
export type FolderConfig = {
  readonly format: typeof CONFIG_FORMAT;
  readonly platform: PlatformBinding | null;
  readonly project: IdentifiedThing | null;
  readonly agents: readonly FolderAgent[];
};

export const CONFIG_FORMAT = 4 as const;

export const EMPTY_CONFIG: FolderConfig = {
  format: CONFIG_FORMAT,
  platform: null,
  project: null,
  agents: [],
};

const ROOT_CONFIG_KEYS = ["format", "platform", "project", "agents"] as const;
const NAMED_KEYS = ["id", "name"] as const;
const CONNECTION_KEYS = NAMED_KEYS;
const AGENT_KEYS = [...NAMED_KEYS, "platform", "connections"] as const;

const CONFIG_HEADER = [
  "# What this folder points at on Egma.",
  "#",
  "# Committed on purpose: nothing in this folder is secret. Egma writes an id",
  "# beside each name once it has registered one.",
];

export function serializeConfig(config: FolderConfig): string {
  const lines = [...CONFIG_HEADER, `format: ${String(CONFIG_FORMAT)}`];
  if (config.platform == null) {
    lines.push("platform:");
  } else {
    lines.push("platform:");
    lines.push(`  origin: ${yamlScalar(config.platform.origin)}`);
  }
  if (config.project === null) {
    lines.push("project:");
  } else {
    lines.push("project:");
    lines.push(`  id: ${yamlScalar(config.project.id)}`);
    lines.push(`  name: ${yamlScalar(config.project.name)}`);
  }
  if (config.agents.length === 0) {
    lines.push("agents: []");
  } else {
    lines.push("agents:");
    for (const agent of config.agents) {
      lines.push(`  - id: ${yamlScalar(agent.id)}`);
      lines.push(`    name: ${yamlScalar(agent.name)}`);
      lines.push(`    platform: ${agent.platform}`);
      if (agent.connections.length === 0) {
        lines.push("    connections: []");
        continue;
      }
      lines.push("    connections:");
      for (const connection of agent.connections) {
        lines.push(`      - id: ${yamlScalar(connection.id)}`);
        lines.push(`        name: ${yamlScalar(connection.name)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function unsupportedKeys(
  mapping: YamlMapping,
  supported: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(mapping).filter((key) => !supported.includes(key));
  if (unknown.length > 0) {
    throw new FolderProblem(where, 
      `${where} has unsupported ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}.`,
    );
  }
}

function identifiedThing(
  mapping: YamlMapping,
  where: string,
  supported: readonly string[] = NAMED_KEYS,
): IdentifiedThing {
  unsupportedKeys(mapping, supported, where);
  const id = textAt(mapping, "id");
  const name = textAt(mapping, "name");
  if (id === null || name === null) {
    throw new FolderProblem(where, `${where} must contain a nonblank id and name.`);
  }
  if (id !== id.trim() || name !== name.trim()) {
    throw new FolderProblem(where, `${where} has outer whitespace in its id or name.`);
  }
  return { id, name };
}

function identifiedConnection(
  mapping: YamlMapping,
  where: string,
): FolderConnection {
  return identifiedThing(mapping, where, CONNECTION_KEYS);
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
  const writtenFormat = mapping["format"];
  if (writtenFormat !== CONFIG_FORMAT) {
    const said =
      typeof writtenFormat === "string" || typeof writtenFormat === "number"
        ? String(writtenFormat)
        : "none";
    throw new FolderProblem(where, 
      `${where} uses folder format ${said}. This Egma requires format ${String(CONFIG_FORMAT)} and has no legacy reader.`,
    );
  }
  unsupportedKeys(mapping, ROOT_CONFIG_KEYS, where);
  const missing = ROOT_CONFIG_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(mapping, key),
  );
  if (missing.length > 0) {
    throw new FolderProblem(where, 
      `${where} is missing required ${missing.length === 1 ? "key" : "keys"}: ${missing.join(", ")}.`,
    );
  }
  const platformMapping = mappingAtKey(mapping, "platform");
  const platformScalar = textAt(mapping, "platform");
  const platform =
    platformMapping === null
      ? (() => {
          if (platformScalar !== null) {
            throw new FolderProblem(where, 
              `${where} has a platform value without an origin. Repair the repository binding, then run egma pull.`,
            );
          }
          return null;
        })()
      : (() => {
          unsupportedKeys(platformMapping, ["origin"], `${where} platform`);
          const origin = textAt(platformMapping, "origin");
          if (origin === null) {
            throw new FolderProblem(where, 
              `${where} has a platform binding without an origin. Repair it, then run egma pull.`,
            );
          }
          return { origin: committedOrigin(origin) };
        })();

  const projectMapping = mappingAtKey(mapping, "project");
  if (projectMapping === null && textAt(mapping, "project") !== null) {
    throw new FolderProblem(where, `${where} has a project value without an id and name.`);
  }
  const project =
    projectMapping === null
      ? null
      : identifiedThing(projectMapping, `${where} project`);

  const agents: FolderAgent[] = [];
  const agentIds = new Set<string>();
  const connectionOwners = new Map<string, string>();
  for (const [index, entry] of sequenceAt(mapping, "agents").entries()) {
    if (typeof entry !== "object") {
      throw new FolderProblem(where, 
        `${where} agent ${String(index + 1)} must contain id, name, and connections.`,
      );
    }
    unsupportedKeys(entry, AGENT_KEYS, `${where} agent ${String(index + 1)}`);
    if (!Object.prototype.hasOwnProperty.call(entry, "connections")) {
      throw new FolderProblem(where, 
        `${where} agent ${String(index + 1)} is missing required key: connections.`,
      );
    }
    const agent = identifiedThing(
      { id: entry["id"] ?? null, name: entry["name"] ?? null },
      `${where} agent ${String(index + 1)}`,
    );
    const platform = textAt(entry, "platform");
    if (platform !== "retell" && platform !== "livekit") {
      throw new FolderProblem(where, 
        `${where} agent ${String(index + 1)} must contain platform retell or livekit.`,
      );
    }
    if (agentIds.has(agent.id)) {
      throw new FolderProblem(where, `${where} uses agent id ${agent.id} more than once.`);
    }
    agentIds.add(agent.id);

    const connections: FolderConnection[] = [];
    for (const [connectionIndex, connectionEntry] of sequenceAt(
      entry,
      "connections",
    ).entries()) {
      if (typeof connectionEntry !== "object") {
        throw new FolderProblem(where, 
          `${where} agent ${agent.id} connection ${String(connectionIndex + 1)} must contain id and name.`,
        );
      }
      const connection = identifiedConnection(
        connectionEntry,
        `${where} agent ${agent.id} connection ${String(connectionIndex + 1)}`,
      );
      const firstOwner = connectionOwners.get(connection.id);
      if (firstOwner !== undefined) {
        throw new FolderProblem(where, 
          `${where} uses connection id ${connection.id} under both agent ${firstOwner} and agent ${agent.id}.`,
        );
      }
      connectionOwners.set(connection.id, agent.id);
      connections.push(connection);
    }
    agents.push({ ...agent, platform, connections });
  }

  return {
    format: CONFIG_FORMAT,
    platform,
    project,
    agents,
  };
}

export async function readConfig(file: string): Promise<FolderConfig> {
  return parseConfig(await readFile(file, "utf8"), `${FOLDER_NAME}/${CONFIG_FILE_NAME}`);
}

export async function writeConfig(file: string, config: FolderConfig): Promise<void> {
  await writeFile(file, serializeConfig(config), "utf8");
}

/** Change the singleton binding fields while preserving the target catalog. */
async function updateConfig(
  file: string,
  changes: Partial<FolderConfig>,
): Promise<FolderConfig> {
  const held = await readConfig(file);
  const updated: FolderConfig = {
    format: CONFIG_FORMAT,
    platform: changes.platform === undefined ? held.platform : changes.platform,
    project: changes.project === undefined ? held.project : changes.project,
    agents: changes.agents === undefined ? held.agents : changes.agents,
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
    ...(config.project === null
      ? []
      : [`project ${config.project.id} in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`]),
    ...config.agents.flatMap((agent) => [
      `agent ${agent.id} in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
      ...agent.connections.map(
        (connection) =>
          `connection ${connection.id} under agent ${agent.id} in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
      ),
    ]),
    ...suiteIds.map((id) => `suite ${id} in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/${SUITE_MANIFEST_FILE_NAME}`),
  ];
}

/** The ordered, reviewable local repair for an intentional platform move. */
export const MOVE_TO_ANOTHER_PLATFORM: readonly string[] = [
  "To move this repository to another platform, clear these in this order and run egma again:",
  `  - replace every connections: block with connections: [] in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - replace the whole agents: block with agents: [] in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - replace the whole project: block with project: in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  `  - every id: line in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/${SUITE_MANIFEST_FILE_NAME}`,
  `  - the version: line at the top of every file in ${FOLDER_NAME}/${TESTS_FOLDER_NAME}/*/`,
  `  - last of all, replace the whole platform: block with platform: in ${FOLDER_NAME}/${CONFIG_FILE_NAME}`,
  "Clear the platform block last: it is what keeps every id above it on the platform that issued it, so until it is empty nothing can leave for another one.",
  "Keep your tests. Reconnect each agent and connection on the new platform; the runs you have already done stay on the platform that ran them, because a run's numbers only mean anything against the versions that platform minted.",
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
 * `tests/` directory to a branch merge comes back whole.
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
    throw new FolderProblem(where, 
      `${where} must contain exactly id and name${details === "" ? "" : ` (${details})`}.`,
    );
  }
  const id = textAt(mapping, "id");
  const writtenName = mapping["name"];
  const name = typeof writtenName === "string" ? writtenName : null;
  if (id === null || !SUITE_ID.test(id)) {
    throw new FolderProblem(where, 
      `${where} has an invalid suite id. Expected ste_ followed by 26 Crockford base32 characters.`,
    );
  }
  if (name === null) {
    throw new FolderProblem(where, `${where} has a non-string suite name.`);
  }
  if (name.trim() === "") {
    throw new FolderProblem(where, `${where} has a blank suite name.`);
  }
  if (name !== name.trim()) {
    throw new FolderProblem(where, `${where} has outer whitespace in its suite name.`);
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

/**
 * One issue line. A parser's own refusal already names its file, so it is
 * taken as written; anything else — the file system, a JSON parser — is given
 * the place the reporter was reading when it happened.
 */
function issueAt(place: string, problem: unknown): string {
  return namesItsPlace(problem) ? problem.message : `${place}: ${reasonOf(problem)}`;
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

  try {
    config = await readConfig(paths.config);
  } catch (problem) {
    issues.push(issueAt(`${FOLDER_NAME}/${CONFIG_FILE_NAME}`, problem));
  }

  let entries: Dirent[] = [];
  try {
    entries = await readdir(paths.tests, { withFileTypes: true });
  } catch (problem) {
    issues.push(issueAt(`${FOLDER_NAME}/${TESTS_FOLDER_NAME}`, problem));
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
      issues.push(issueAt(shown(entry.name, SUITE_MANIFEST_FILE_NAME), problem));
    }

    let children: Dirent[] = [];
    try {
      children = await readdir(suiteRoot, { withFileTypes: true });
    } catch (problem) {
      issues.push(issueAt(shown(entry.name), problem));
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
        issues.push(issueAt(shown(entry.name, child.name), problem));
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
  return { config, suites };
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
