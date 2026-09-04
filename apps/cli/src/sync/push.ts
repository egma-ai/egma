/** Build and apply one complete, atomic repository change set. */

import { sameEnv } from "../folder/env.ts";
import { sameMockTools } from "../folder/mock-tools.ts";
import type {
  FileBehavior,
  FilePersona,
  TestFile,
} from "../folder/test-file.ts";
import {
  readRepository,
  writeTestFile,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import type { Fetch } from "../platform/device-flow.ts";
import {
  applyRepositoryChangeSet,
  type RepositoryChangeSet,
} from "../platform/repository.ts";
import type { SignedIn } from "../platform/signed-in.ts";
import type {
  PlatformTest,
  TestInput,
} from "../platform/tests.ts";
import { fileFromPlatform } from "./pull.ts";

export const NO_BEHAVIORS_REASON =
  "no expected behaviors, so it could never fail. Add one, then run egma push.";

export type ConflictReason = "repository-conflict";

export type PushConflict = {
  readonly name: string;
  readonly shown: string;
  readonly reason: ConflictReason;
  readonly said: string | null;
};

export type PushedTest = {
  readonly testId: string;
  readonly name: string;
  readonly shown: string;
  readonly versionId: string;
  readonly state: "created" | "updated" | "unchanged";
};

export function landed(tests: readonly PushedTest[]): readonly PushedTest[] {
  return tests.filter((test) => test.state !== "unchanged");
}

export type TurnedAway = {
  readonly name: string;
  readonly shown: string;
  readonly file: string;
  readonly reason: string;
  readonly refusedBy: "egma" | "platform";
};

export type PushReport = {
  readonly conflicts: readonly PushConflict[];
  readonly uploadedNothing: boolean;
  readonly tests: readonly PushedTest[];
  readonly turnedAway: readonly TurnedAway[];
  readonly suites: number;
};

export type PushOptions = {
  readonly signedIn: SignedIn;
  readonly paths: FolderPaths;
  readonly fetchImpl?: Fetch;
  readonly signal?: AbortSignal;
  /** Failure injection at the local pin-write boundary. */
  readonly writeTestFile?: typeof writeTestFile;
};

/** The platform committed the whole change set, but local version pins did not. */
export class PushMaterializationError extends Error {
  public readonly tests: readonly PushedTest[];
  public readonly file: string;
  public readonly shown: string;

  public constructor(
    tests: readonly PushedTest[],
    file: string,
    shown: string,
    cause: unknown,
  ) {
    super("Egma applied the repository, but its returned Test pins were not all written locally.", {
      cause,
    });
    this.name = "PushMaterializationError";
    this.tests = tests;
    this.file = file;
    this.shown = shown;
  }
}

function inputFrom(test: TestFile): TestInput {
  return {
    name: test.name,
    description: test.description ?? "",
    scenario: test.scenario,
    expectedBehaviors: [...test.expectedBehaviors],
    personas: test.personas,
    mockTools: test.mockTools,
    env: test.env,
  };
}

function sameBehaviors(
  a: readonly FileBehavior[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function samePersonas(
  a: readonly FilePersona[],
  b: readonly FilePersona[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      if (other === undefined) return false;
      return entry.id === "" || other.id === ""
        ? entry.name === other.name
        : entry.id === other.id;
    })
  );
}

export function sameAsPlatform(file: TestFile, test: PlatformTest): boolean {
  return (
    file.name === test.name &&
    (file.description ?? "") === test.description &&
    file.scenario === test.scenario &&
    sameBehaviors(file.expectedBehaviors, test.expectedBehaviors) &&
    samePersonas(file.personas, test.personas) &&
    sameMockTools(file.mockTools, test.mockTools) &&
    sameEnv(file.env, test.env)
  );
}

export async function pushTests(options: PushOptions): Promise<PushReport> {
  const repository = await readRepository(options.paths);
  const projectId = repository.config.project?.id ?? "";
  if (projectId === "") {
    throw new Error(
      "This repository does not name its Egma Project. Run egma init again.",
    );
  }

  const files = repository.suites.flatMap((suite) => suite.tests);
  const turnedAway: TurnedAway[] = files
    .filter((file) => file.test.expectedBehaviors.length === 0)
    .map((file) => ({
      name: file.test.name,
      shown: file.shown,
      file: file.file,
      reason: NO_BEHAVIORS_REASON,
      refusedBy: "egma" as const,
    }));
  if (turnedAway.length > 0) {
    return {
      conflicts: [],
      uploadedNothing: true,
      tests: [],
      turnedAway,
      suites: repository.suites.length,
    };
  }

  const changeSet: RepositoryChangeSet = {
    projectId,
    suites: repository.suites.map((suite) => suite.manifest),
    tests: files.map((file) => ({
      clientRef: file.shown,
      suiteId: file.suiteId,
      input: inputFrom(file.test),
      expectedVersionId: file.test.version,
      expectedRevision: file.test.identityRevision,
    })),
  };

  const answer = await applyRepositoryChangeSet(
    options.signedIn,
    changeSet,
    options.fetchImpl,
    options.signal,
  );
  const fileByRef = new Map(files.map((file) => [file.shown, file] as const));
  const pushed: PushedTest[] = [];
  for (const applied of answer.tests) {
    const file = fileByRef.get(applied.clientRef);
    if (file === undefined) {
      throw new Error(
        `Egma answered for ${applied.clientRef}, which was not in this repository. Run egma pull to recover the applied change set.`,
      );
    }
    const before = file.test.version;
    const state =
      before === null
        ? "created"
        : before === applied.test.versionId && sameAsPlatform(file.test, applied.test)
          ? "unchanged"
          : "updated";
    pushed.push({
      testId: applied.test.id,
      name: applied.test.name,
      shown: applied.clientRef,
      versionId: applied.test.versionId,
      state,
    });
  }

  const write = options.writeTestFile ?? writeTestFile;
  // Keep the full receipt even when the first local write fails. The platform
  // applied the complete change set atomically.
  for (const applied of answer.tests) {
    const file = fileByRef.get(applied.clientRef)!;
    try {
      await write(file.file, fileFromPlatform(applied.test));
    } catch (cause) {
      throw new PushMaterializationError(pushed, file.file, file.shown, cause);
    }
  }

  return {
    conflicts: [],
    uploadedNothing: false,
    tests: pushed,
    turnedAway: [],
    suites: repository.suites.length,
  };
}
