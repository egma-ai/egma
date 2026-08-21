/** Prepare, stage, and apply one complete non-destructive repository pull. */

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  RepositoryValidationError,
  readRepository,
  serializeMockToolsFile,
  serializeSuiteManifest,
  type FolderPaths,
  type FolderSuite,
} from "../folder/egma-folder.ts";
import {
  fileNameFor,
  serializeTestFile,
  TEST_FILE_FORMAT,
  type FilePersona,
  type TestFile,
} from "../folder/test-file.ts";
import {
  portableSuiteDirectory,
  withStablePathSuffix,
} from "../folder/portable-path.ts";
import { sameMockTools, type MockToolEntry } from "../folder/mock-tools.ts";
import type { Fetch } from "../platform/device-flow.ts";
import { listMockTools } from "../platform/mock-tools.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import { listTestSuites, type PlatformTestSuite } from "../platform/test-suites.ts";
import {
  getTestVersion,
  listTests,
  type PlatformContent,
  type PlatformTest,
} from "../platform/tests.ts";

export type PulledTest = {
  readonly name: string;
  readonly shown: string;
  readonly versionId: string;
  readonly state: "written" | "unchanged";
};

export type KeptDraft = {
  readonly name: string;
  readonly shown: string;
  readonly reason: string;
};

export type PulledSuite = {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly state: "written" | "unchanged";
};

export type PullReport = {
  readonly suites: readonly PulledSuite[];
  readonly tests: readonly PulledTest[];
  readonly kept: readonly KeptDraft[];
  readonly mockTools: readonly string[];
};

type StagedFileApplier = (
  staged: string,
  destination: string,
  index: number,
) => Promise<void>;

export type PullOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
  /** Failure injection at the real local-write boundary. */
  readonly applyStagedFile?: StagedFileApplier;
};

export function fileFromPlatform(test: PlatformTest): TestFile {
  return {
    format: TEST_FILE_FORMAT,
    name: test.name,
    description: test.description === "" ? null : test.description,
    personas: test.personas,
    version: test.versionId,
    identityRevision: test.revision,
    scenario: test.scenario,
    expectedBehaviors: test.expectedBehaviors,
    mockTools: test.mockTools,
  };
}

function samePersonas(
  first: readonly FilePersona[],
  second: readonly FilePersona[],
): boolean {
  return (
    first.length === second.length &&
    first.every((entry, index) => {
      const other = second[index];
      if (other === undefined) return false;
      return entry.id === "" || other.id === ""
        ? entry.name === other.name
        : entry.id === other.id;
    })
  );
}

function sameContent(file: TestFile, platform: PlatformContent): boolean {
  return (
    file.scenario === platform.scenario &&
    file.expectedBehaviors.length === platform.expectedBehaviors.length &&
    file.expectedBehaviors.every(
      (entry, index) => entry === platform.expectedBehaviors[index],
    ) &&
    samePersonas(file.personas, platform.personas) &&
    sameMockTools(file.mockTools, platform.mockTools)
  );
}

function cleanAgainst(file: TestFile, current: PlatformTest, base: PlatformContent): boolean {
  const identityMatches =
    file.identityRevision === current.revision &&
    file.name === current.name &&
    (file.description ?? "") === current.description;
  return identityMatches && sameContent(file, base);
}

function directoryFor(
  suite: PlatformTestSuite,
  used: Set<string>,
): string {
  const wanted = portableSuiteDirectory(suite.name);
  if (!used.has(wanted.toLowerCase())) {
    used.add(wanted.toLowerCase());
    return wanted;
  }
  const suffix = suite.id.slice(-8).toLowerCase();
  const withId = withStablePathSuffix(wanted, suffix);
  if (!used.has(withId.toLowerCase())) {
    used.add(withId.toLowerCase());
    return withId;
  }
  for (let number = 2; ; number += 1) {
    const candidate = withStablePathSuffix(
      wanted,
      `${suffix}-${String(number)}`,
    );
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

function freeFileName(name: string, testId: string, taken: Set<string>): string {
  const wanted = fileNameFor(name);
  if (!taken.has(wanted.toLowerCase())) {
    taken.add(wanted.toLowerCase());
    return wanted;
  }
  const stable = testId.slice(-8).toLowerCase();
  for (let attempt = 1; ; attempt += 1) {
    const candidate = withStablePathSuffix(
      wanted,
      attempt === 1 ? stable : `${stable}-${String(attempt + 1)}`,
      ".md",
    );
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

type PlannedFile = {
  readonly destination: string;
  readonly document: string;
};

async function sameBytes(file: string, document: string): Promise<boolean> {
  try {
    return (await readFile(file, "utf8")) === document;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/** Apply every byte or put every prior byte and path back. */
async function applyStaged(
  paths: FolderPaths,
  files: readonly PlannedFile[],
  newSuiteDirectories: readonly string[],
  apply: StagedFileApplier = (staged, destination) => copyFile(staged, destination),
): Promise<void> {
  if (files.length === 0) return;
  const stage = await mkdtemp(path.join(paths.root, ".pull-stage-"));
  const prior = new Map<string, Buffer | null>();
  const createdDirectories: string[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const staged = path.join(stage, String(index));
      await writeFile(staged, file.document, "utf8");
      try {
        prior.set(file.destination, await readFile(file.destination));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        prior.set(file.destination, null);
      }
    }

    for (const directory of newSuiteDirectories) {
      if (await pathExists(directory)) continue;
      await mkdir(directory);
      createdDirectories.push(directory);
    }

    for (const [index, file] of files.entries()) {
      await apply(path.join(stage, String(index)), file.destination, index);
    }
  } catch (cause) {
    for (const [destination, bytes] of [...prior.entries()].reverse()) {
      if (bytes === null) await rm(destination, { force: true }).catch(() => undefined);
      else await writeFile(destination, bytes).catch(() => undefined);
    }
    for (const directory of [...createdDirectories].reverse()) {
      await rmdir(directory).catch(() => undefined);
    }
    throw cause;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function pullRepository(options: PullOptions): Promise<PullReport> {
  const repository = await readRepository(options.paths);
  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    throw new RepositoryValidationError([
      "egma/config.yaml does not name a project. Run egma connect here first.",
    ]);
  }

  const remoteSuites = await listTestSuites(
    options.signedIn,
    projectId,
    options.fetchImpl,
  );
  // The public test list is suite-scoped. Walk one bounded page stream at a
  // time so a project with many suites never opens unbounded concurrent feeds.
  const remoteTests: PlatformTest[] = [];
  for (const suite of remoteSuites) {
    remoteTests.push(
      ...(await listTests(options.signedIn, {
        projectId,
        suiteId: suite.id,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })),
    );
  }
  const remoteMockTools = await listMockTools(options.signedIn, options.fetchImpl);

  const localSuiteById = new Map(
    repository.suites.map((suite) => [suite.manifest.id, suite] as const),
  );
  const remoteSuiteById = new Map(remoteSuites.map((suite) => [suite.id, suite] as const));
  const remoteTestById = new Map(remoteTests.map((test) => [test.id, test] as const));
  const remoteTestByVersion = new Map(
    remoteTests.map((test) => [test.versionId, test] as const),
  );
  const usedDirectories = new Set(repository.suites.map((suite) => suite.directory.toLowerCase()));
  const suiteLocations = new Map<string, { readonly directory: string; readonly root: string }>();
  const newSuiteDirectories: string[] = [];
  for (const suite of remoteSuites) {
    const local = localSuiteById.get(suite.id);
    const directory = local?.directory ?? directoryFor(suite, usedDirectories);
    const root = local?.root ?? path.join(options.paths.tests, directory);
    if (local === undefined) newSuiteDirectories.push(root);
    suiteLocations.set(suite.id, { directory, root });
  }

  const kept: KeptDraft[] = [];
  for (const suite of repository.suites) {
    if (!remoteSuiteById.has(suite.manifest.id)) {
      kept.push({
        name: suite.manifest.name,
        shown: `egma/tests/${suite.directory}/suite.yaml`,
        reason: `Suite ${suite.manifest.id} no longer exists on Egma. The local directory was kept and nothing was deleted.`,
      });
    }
  }

  const fileByTestId = new Map<string, FolderSuite["tests"][number]>();
  const representedTestIds = new Set<string>();
  for (const suite of repository.suites) {
    if (!remoteSuiteById.has(suite.manifest.id)) continue;
    for (const file of suite.tests) {
      if (file.test.version === null) {
        kept.push({
          name: file.test.name,
          shown: file.shown,
          reason: "This is an unpushed local test draft.",
        });
        continue;
      }
      const current = remoteTestByVersion.get(file.test.version);
      const version =
        current === undefined
          ? await getTestVersion(options.signedIn, file.test.version, options.fetchImpl)
          : null;
      const testId = current?.id ?? version?.testId ?? null;
      const owner = current?.suiteId ?? version?.suiteId ?? null;
      if (testId === null || owner === null) {
        kept.push({
          name: file.test.name,
          shown: file.shown,
          reason: "This test identity no longer exists on Egma. The local file was kept.",
        });
        continue;
      }
      if (owner !== suite.manifest.id) {
        throw new RepositoryValidationError([
          `${file.shown} belongs to suite ${owner} on Egma, not ${suite.manifest.id}. Tests cannot move between suites.`,
        ]);
      }
      const first = fileByTestId.get(testId);
      if (representedTestIds.has(testId)) {
        throw new RepositoryValidationError([
          `test ${testId} is represented more than once; one copy is ${first?.shown ?? file.shown}.`,
        ]);
      }
      representedTestIds.add(testId);
      const remote = remoteTestById.get(testId);
      if (remote === undefined) {
        kept.push({
          name: file.test.name,
          shown: file.shown,
          reason: "This test was deleted on Egma. The local file was kept.",
        });
        continue;
      }
      const base: PlatformContent = current ?? version ?? remote;
      if (!cleanAgainst(file.test, remote, base)) {
        kept.push({
          name: file.test.name,
          shown: file.shown,
          reason: "This file has local changes. Pull kept the draft instead of overwriting it.",
        });
        continue;
      }
      fileByTestId.set(testId, file);
    }
  }

  const planned: PlannedFile[] = [];
  const suiteReports: PulledSuite[] = [];
  for (const suite of remoteSuites) {
    const location = suiteLocations.get(suite.id)!;
    const destination = path.join(location.root, "suite.yaml");
    const document = serializeSuiteManifest({ id: suite.id, name: suite.name });
    const unchanged = await sameBytes(destination, document);
    if (!unchanged) planned.push({ destination, document });
    suiteReports.push({
      id: suite.id,
      name: suite.name,
      directory: location.directory,
      state: unchanged ? "unchanged" : "written",
    });
  }

  const testReports: PulledTest[] = [];
  const takenBySuite = new Map<string, Set<string>>();
  for (const suite of remoteSuites) {
    const local = localSuiteById.get(suite.id);
    takenBySuite.set(
      suite.id,
      new Set((local?.tests ?? []).map((file) => path.basename(file.file).toLowerCase())),
    );
  }
  for (const test of [...remoteTests].sort((a, b) => a.id.localeCompare(b.id))) {
    const existing = fileByTestId.get(test.id);
    if (representedTestIds.has(test.id) && existing === undefined) continue;
    const location = suiteLocations.get(test.suiteId);
    if (location === undefined) continue;
    const fileName =
      existing === undefined
        ? freeFileName(test.name, test.id, takenBySuite.get(test.suiteId)!)
        : path.basename(existing.file);
    const destination = existing?.file ?? path.join(location.root, fileName);
    const shown = existing?.shown ?? `egma/tests/${location.directory}/${fileName}`;
    const document = serializeTestFile(fileFromPlatform(test));
    const unchanged = await sameBytes(destination, document);
    if (!unchanged) planned.push({ destination, document });
    testReports.push({
      name: test.name,
      shown,
      versionId: test.versionId,
      state: unchanged ? "unchanged" : "written",
    });
  }

  const remoteToolNames = new Set(remoteMockTools.map((tool) => tool.entry.tool));
  const toolDrafts = repository.mockTools.filter((tool) => !remoteToolNames.has(tool.tool));
  const mockTools: readonly MockToolEntry[] = [
    ...remoteMockTools.map((tool) => tool.entry),
    ...toolDrafts,
  ].sort((a, b) => a.tool.localeCompare(b.tool));
  const mockDocument = serializeMockToolsFile(mockTools);
  if (!(await sameBytes(options.paths.mockTools, mockDocument))) {
    planned.push({ destination: options.paths.mockTools, document: mockDocument });
  }

  await applyStaged(
    options.paths,
    planned,
    newSuiteDirectories,
    options.applyStagedFile,
  );

  return {
    suites: suiteReports,
    tests: testReports,
    kept,
    mockTools: mockTools.map((tool) => tool.tool),
  };
}
