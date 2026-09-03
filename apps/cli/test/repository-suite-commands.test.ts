import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_CONFIG,
  createEgmaFolder,
  folderPathsIn,
  readRepository,
  serializeMockToolsFile,
  serializeSuiteManifest,
} from "../src/folder/egma-folder.ts";
import {
  isPortableSuiteDirectory,
  isPortableTestFile,
  MAX_PORTABLE_COMPONENT_LENGTH,
} from "../src/folder/portable-path.ts";
import { serializeTestFile } from "../src/folder/test-file.ts";
import { pullRepository } from "../src/sync/pull.ts";
import { pushTests } from "../src/sync/push.ts";
import { aTestFile, blocking } from "./support/test-file.ts";
import {
  startPlatform,
  type Platform,
  type SeededSuite,
} from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const URL = "https://egma.example";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";
const EMPTY_SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWES";
const THIRD_SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWET";
const TEST_ID = "tst_01K3XQ7M4E8YB2FVN0H9TZQWER";
const VERSION_ID = "tstv_01K3XQ7M4E8YB2FVN0H9TZQWER";
const REVISION = "rev_01K3XQ7M4E8YB2FVN0H9TZQWER";
let workspace: Workspace;

class JsonResponse extends Response {
  constructor(body?: string | null, init: ResponseInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    super(body, { ...init, headers });
  }
}

beforeEach(async () => {
  workspace = await makeWorkspace();
  await workspace.signIn(URL);
  await createEgmaFolder({
    repository: workspace.dir,
    config: {
      ...EMPTY_CONFIG,
      project: { id: PROJECT_ID, name: "Northside" },
      agents: [
        {
          id: "agt_one",
          name: "Receptionist",
          platform: "retell",
          connections: [{ id: "con_one", name: "Phone" }],
        },
      ],
    },
  });
});

afterEach(async () => workspace.remove());

async function suite(directory: string, id: string, name: string): Promise<string> {
  const root = path.join(folderPathsIn(workspace.dir).tests, directory);
  await mkdir(root);
  await writeFile(path.join(root, "suite.yaml"), serializeSuiteManifest({ id, name }));
  return root;
}

async function fixtureRepository(
  platform: Platform,
  project: SeededSuite,
  key: string,
): Promise<Workspace> {
  const repository = await makeWorkspace();
  platform.signedInWith(key);
  await repository.signIn(platform.url, key);
  await createEgmaFolder({
    repository: repository.dir,
    config: {
      ...EMPTY_CONFIG,
      platform: { origin: platform.url },
      project: { id: project.projectId, name: "Fixture project" },
    },
  });
  return repository;
}

async function pullFixture(
  platform: Platform,
  repository: Workspace,
  key: string,
): Promise<void> {
  await pullRepository({
    signedIn: { url: platform.url, key },
    paths: folderPathsIn(repository.dir),
  });
}

function testBody(input: {
  readonly suiteId?: string;
  readonly id?: string;
  readonly versionId?: string;
  readonly revision?: string;
  readonly name?: string;
} = {}): Record<string, unknown> {
  return {
    id: input.id ?? TEST_ID,
    projectId: PROJECT_ID,
    suiteId: input.suiteId ?? SUITE_ID,
    name: input.name ?? "Books a visit",
    description: "",
    scenario: "The caller asks for Tuesday.",
    expectedBehaviors: ["The agent books Tuesday."],
    personas: [],
    mockTools: [],
    versionId: input.versionId ?? VERSION_ID,
    version: 1,
    revision: input.revision ?? REVISION,
  };
}

describe("complete repository suite commands", () => {
  it("pushes all suites, tests, and Mock Tools in one atomic call", async () => {
    const release = await suite("release", SUITE_ID, "Release");
    await suite("empty", EMPTY_SUITE_ID, "Empty");
    await writeFile(
      path.join(release, "books-a-visit.md"),
      serializeTestFile(
        aTestFile({
          name: "Books a visit",
          scenario: "The caller asks for Tuesday.",
          expectedBehaviors: blocking("The agent books Tuesday."),
        }),
      ),
    );
    await writeFile(
      folderPathsIn(workspace.dir).mockTools,
      serializeMockToolsFile([{ tool: "calendar", says: { answer: { open: true } } }]),
    );

    const calls: { readonly url: string; readonly body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      const written = (body.tests as Record<string, unknown>[])[0]!;
      return new JsonResponse(
        JSON.stringify({
          tests: [{ clientRef: written.clientRef, test: testBody() }],
        }),
        { status: 200 },
      );
    };

    const report = await pushTests({
      signedIn: { url: URL, key: "key" },
      paths: folderPathsIn(workspace.dir),
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${URL}/v1/repository/change-set?projectId=${PROJECT_ID}`,
    );
    expect(calls[0]?.body.suites).toEqual([
      { id: EMPTY_SUITE_ID, name: "Empty" },
      { id: SUITE_ID, name: "Release" },
    ]);
    expect(calls[0]?.body.mockTools).toEqual([
      { tool: "calendar", answer: { open: true } },
    ]);
    expect(report.tests[0]).toMatchObject({ testId: TEST_ID, versionId: VERSION_ID });
    expect(await readFile(path.join(release, "books-a-visit.md"), "utf8")).toContain(
      `version: ${VERSION_ID}`,
    );
  });

  it("treats a local suite-directory rename as local only", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_directory-only-rename";
    const remoteSuite = platform.suites.add("Release");
    platform.tests.add({
      suiteId: remoteSuite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const repository = await fixtureRepository(platform, remoteSuite, key);
    try {
      await pullFixture(platform, repository, key);
      const before = await readRepository(folderPathsIn(repository.dir));
      const held = before.suites.find((entry) => entry.manifest.id === remoteSuite.id)!;
      await rename(held.root, path.join(folderPathsIn(repository.dir).tests, "local-gate"));
      const firstRecord = platform.records.length;

      await pushTests({
        signedIn: { url: platform.url, key },
        paths: folderPathsIn(repository.dir),
      });

      expect(platform.suites.suites).toEqual([
        expect.objectContaining({ id: remoteSuite.id, name: "Release" }),
      ]);
      expect(platform.tests.versionsOf("Books a visit")).toBe(1);
      expect(
        platform.records.slice(firstRecord).filter((record) =>
          record.path.startsWith("/v1/test-suites"),
        ),
      ).toEqual([]);
      const changeSet = platform.records.slice(firstRecord).find(
        (record) => record.method === "POST" && record.path === "/v1/repository/change-set",
      );
      expect(changeSet).toBeDefined();
      expect((await readRepository(folderPathsIn(repository.dir))).suites[0]?.directory).toBe(
        "local-gate",
      );
    } finally {
      await Promise.all([platform.close(), repository.remove()]);
    }
  });

  it("renames one existing product suite when its manifest name changes", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_manifest-rename";
    const remoteSuite = platform.suites.add("Release");
    const repository = await fixtureRepository(platform, remoteSuite, key);
    try {
      await pullFixture(platform, repository, key);
      const local = (await readRepository(folderPathsIn(repository.dir))).suites[0]!;
      await writeFile(
        local.manifestFile,
        serializeSuiteManifest({ id: remoteSuite.id, name: "Northside Ford" }),
      );

      await pushTests({
        signedIn: { url: platform.url, key },
        paths: folderPathsIn(repository.dir),
      });

      expect(platform.suites.suites).toEqual([
        expect.objectContaining({ id: remoteSuite.id, name: "Northside Ford" }),
      ]);
      expect(platform.suites.suites).toHaveLength(1);
    } finally {
      await Promise.all([platform.close(), repository.remove()]);
    }
  });

  it.each(["suite", "test"] as const)(
    "refuses a remote-only %s and does not infer its deletion",
    async (remoteOnly) => {
      const platform = await startPlatform();
      const key = `egma_sk_remote-only-${remoteOnly}`;
      const remoteSuite = platform.suites.add("Release");
      platform.tests.add({
        suiteId: remoteSuite.id,
        name: "Books a visit",
        scenario: "The caller asks for Tuesday.",
        expectedBehaviors: ["The agent books Tuesday."],
      });
      const repository = await fixtureRepository(platform, remoteSuite, key);
      try {
        await pullFixture(platform, repository, key);
        const local = (await readRepository(folderPathsIn(repository.dir))).suites[0]!;
        await writeFile(
          local.manifestFile,
          serializeSuiteManifest({ id: remoteSuite.id, name: "Must not land" }),
        );
        if (remoteOnly === "suite") {
          platform.suites.add("Browser only");
        } else {
          platform.tests.add({
            suiteId: remoteSuite.id,
            name: "Browser-only test",
            scenario: "The caller asks for a callback.",
            expectedBehaviors: ["The agent offers a callback."],
          });
        }

        await expect(
          pushTests({
            signedIn: { url: platform.url, key },
            paths: folderPathsIn(repository.dir),
          }),
        ).rejects.toThrow(
          remoteOnly === "suite"
            ? /does not include active test suite.*no server suite is deleted by inference/iu
            : /does not include active test.*no server test is deleted by inference/iu,
        );

        expect(platform.suites.byId(remoteSuite.id)?.name).toBe("Release");
        expect(platform.suites.suites).toHaveLength(remoteOnly === "suite" ? 2 : 1);
        expect(platform.tests.tests).toHaveLength(remoteOnly === "test" ? 2 : 1);
        expect(platform.tests.versionsOf("Books a visit")).toBe(1);
      } finally {
        await Promise.all([platform.close(), repository.remove()]);
      }
    },
  );

  it("keeps local suite and test identities when they were deleted remotely", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_remote-deleted-identities";
    const activeSuite = platform.suites.add("Active suite");
    const deletedSuite = platform.suites.add("Deleted suite");
    const deletedTest = platform.tests.add({
      suiteId: activeSuite.id,
      name: "Deleted test",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    platform.tests.add({
      suiteId: deletedSuite.id,
      name: "Test inside deleted suite",
      scenario: "The caller asks for Wednesday.",
      expectedBehaviors: ["The agent books Wednesday."],
    });
    const repository = await fixtureRepository(platform, activeSuite, key);
    try {
      await pullFixture(platform, repository, key);
      const before = await readRepository(folderPathsIn(repository.dir));
      const activeLocal = before.suites.find((entry) => entry.manifest.id === activeSuite.id)!;
      const deletedLocal = before.suites.find((entry) => entry.manifest.id === deletedSuite.id)!;
      const testFile = activeLocal.tests.find((entry) => entry.test.name === "Deleted test")!;
      const suiteManifest = deletedLocal.manifestFile;
      const suiteTestFile = deletedLocal.tests[0]!.file;
      const held = new Map([
        [testFile.file, await readFile(testFile.file, "utf8")],
        [suiteManifest, await readFile(suiteManifest, "utf8")],
        [suiteTestFile, await readFile(suiteTestFile, "utf8")],
      ]);
      const headers = { authorization: `Bearer ${key}` };
      expect(
        (await fetch(`${platform.url}/v1/tests/${deletedTest.id}`, {
          method: "DELETE",
          headers,
        })).status,
      ).toBe(204);
      expect(
        (await fetch(`${platform.url}/v1/test-suites/${deletedSuite.id}`, {
          method: "DELETE",
          headers,
        })).status,
      ).toBe(204);

      const report = await pullRepository({
        signedIn: { url: platform.url, key },
        paths: folderPathsIn(repository.dir),
      });

      for (const [file, bytes] of held) expect(await readFile(file, "utf8")).toBe(bytes);
      expect(report.kept).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shown: `egma/tests/${deletedLocal.directory}/suite.yaml`,
            reason: expect.stringContaining("no longer exists on Egma"),
          }),
          expect.objectContaining({
            shown: testFile.shown,
            reason: expect.stringMatching(/identity no longer exists|was deleted/iu),
          }),
        ]),
      );
    } finally {
      await Promise.all([platform.close(), repository.remove()]);
    }
  });

  it("refuses a tracked test moved under another suite and writes nothing", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_reparent-refusal";
    const firstSuite = platform.suites.add("First suite");
    const secondSuite = platform.suites.add("Second suite");
    platform.tests.add({
      suiteId: firstSuite.id,
      name: "Books a visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent books Tuesday."],
    });
    const repository = await fixtureRepository(platform, firstSuite, key);
    try {
      await pullFixture(platform, repository, key);
      const local = await readRepository(folderPathsIn(repository.dir));
      const from = local.suites.find((entry) => entry.manifest.id === firstSuite.id)!;
      const to = local.suites.find((entry) => entry.manifest.id === secondSuite.id)!;
      await rename(from.tests[0]!.file, path.join(to.root, path.basename(from.tests[0]!.file)));

      await expect(
        pushTests({
          signedIn: { url: platform.url, key },
          paths: folderPathsIn(repository.dir),
        }),
      ).rejects.toThrow(/test cannot move between suites/iu);

      expect(platform.tests.versionsOf("Books a visit")).toBe(1);
      expect(platform.suites.byId(firstSuite.id)?.name).toBe("First suite");
      expect(platform.suites.byId(secondSuite.id)?.name).toBe("Second suite");
    } finally {
      await Promise.all([platform.close(), repository.remove()]);
    }
  });

  it("rolls back every new path when a staged pull write fails", async () => {
    const paths = folderPathsIn(workspace.dir);
    const beforeMockTools = await readFile(paths.mockTools, "utf8");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${URL}/v1/test-suites?projectId=${PROJECT_ID}`) {
        return new JsonResponse(
          JSON.stringify({
            testSuites: [{ id: SUITE_ID, projectId: PROJECT_ID, name: "Release" }],
            nextPageToken: null,
          }),
        );
      }
      if (url.includes("/v1/tests?")) {
        return new JsonResponse(JSON.stringify({ tests: [testBody()], nextPageToken: null }));
      }
      if (url === `${URL}/v1/mock-tools`) {
        return new JsonResponse(JSON.stringify({ mockTools: [], nextPageToken: null }));
      }
      return new JsonResponse(JSON.stringify({ message: "unexpected" }), { status: 404 });
    };

    await expect(
      pullRepository({
        signedIn: { url: URL, key: "key" },
        paths,
        fetchImpl,
        applyStagedFile: async (staged, destination, index) => {
          if (index === 1) throw new Error("disk stopped");
          await copyFile(staged, destination);
        },
      }),
    ).rejects.toThrow("disk stopped");

    await expect(stat(path.join(paths.tests, "release"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths.mockTools, "utf8")).toEqual(beforeMockTools);
  });

  it("finds a free suite directory after both normal collision names are taken", async () => {
    const suffix = SUITE_ID.slice(-8).toLowerCase();
    await suite("release", EMPTY_SUITE_ID, "Local one");
    await suite(`release-${suffix}`, THIRD_SUITE_ID, "Local two");
    let testFeeds = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${URL}/v1/test-suites?projectId=${PROJECT_ID}`) {
        return new JsonResponse(
          JSON.stringify({
            testSuites: [{ id: SUITE_ID, projectId: PROJECT_ID, name: "Release" }],
            nextPageToken: null,
          }),
        );
      }
      if (url.startsWith(`${URL}/v1/tests?`)) {
        testFeeds += 1;
        return new JsonResponse(JSON.stringify({ tests: [], nextPageToken: null }));
      }
      if (url === `${URL}/v1/mock-tools`) {
        return new JsonResponse(JSON.stringify({ mockTools: [], nextPageToken: null }));
      }
      return new JsonResponse(JSON.stringify({ message: "unexpected" }), { status: 404 });
    };

    const report = await pullRepository({
      signedIn: { url: URL, key: "key" },
      paths: folderPathsIn(workspace.dir),
      fetchImpl,
    });

    const directory = `release-${suffix}-2`;
    expect(report.suites).toEqual([
      expect.objectContaining({ id: SUITE_ID, directory, state: "written" }),
    ]);
    expect(
      await readFile(path.join(folderPathsIn(workspace.dir).tests, directory, "suite.yaml"), "utf8"),
    ).toBe(serializeSuiteManifest({ id: SUITE_ID, name: "Release" }));
    expect(testFeeds).toBe(1);
  });

  it("pulls every suite through the suite-scoped HTTP test-list contract", async () => {
    const platform = await startPlatform();
    const repository = await makeWorkspace();
    const key = "egma_sk_multi-suite-pull";
    try {
      platform.signedInWith(key);
      const release = platform.suites.add("Release");
      const regression = platform.suites.add("Regression");
      platform.tests.add({
        suiteId: release.id,
        name: "Books a visit",
        scenario: "The caller asks for Tuesday.",
        expectedBehaviors: ["The agent books Tuesday."],
      });
      platform.tests.add({
        suiteId: regression.id,
        name: "Handles no slots",
        scenario: "No appointment is available.",
        expectedBehaviors: ["The agent offers a callback."],
      });
      await createEgmaFolder({
        repository: repository.dir,
        config: {
          ...EMPTY_CONFIG,
          platform: { origin: platform.url },
          project: { id: release.projectId, name: "Fixture project" },
        },
      });

      await pullRepository({
        signedIn: { url: platform.url, key },
        paths: folderPathsIn(repository.dir),
      });

      const pulled = await readRepository(folderPathsIn(repository.dir));
      expect(
        pulled.suites.map((entry) => [
          entry.manifest.id,
          entry.tests.map((test) => test.test.name),
        ]),
      ).toEqual([
        [regression.id, ["Handles no slots"]],
        [release.id, ["Books a visit"]],
      ]);
      expect(
        platform.records.filter(
          (record) => record.method === "GET" && record.path === "/v1/tests",
        ),
      ).toHaveLength(2);
    } finally {
      await platform.close();
      await repository.remove();
    }
  });

  it("pulls unlimited product names into bounded portable local paths", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_portable-long-names";
    const longSuiteName = `${"Northside dealership reception ".repeat(14)}suite`;
    const longTestName = `${"The caller asks for a service appointment ".repeat(9)}test`;
    const longSuite = platform.suites.add(longSuiteName);
    platform.tests.add({
      suiteId: longSuite.id,
      name: longTestName,
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent offers Tuesday."],
    });
    const reservedSuite = platform.suites.add("cOn");
    platform.tests.add({
      suiteId: reservedSuite.id,
      name: "pRn",
      scenario: "The caller asks for Wednesday.",
      expectedBehaviors: ["The agent offers Wednesday."],
    });
    const repository = await fixtureRepository(platform, longSuite, key);

    try {
      expect(longSuiteName.length).toBeGreaterThan(300);
      expect(longTestName.length).toBeGreaterThan(300);

      await pullFixture(platform, repository, key);
      const pulled = await readRepository(folderPathsIn(repository.dir));
      const longLocal = pulled.suites.find((entry) => entry.manifest.id === longSuite.id)!;
      const reservedLocal = pulled.suites.find(
        (entry) => entry.manifest.id === reservedSuite.id,
      )!;

      expect(longLocal.manifest.name).toBe(longSuiteName);
      expect(longLocal.tests[0]?.test.name).toBe(longTestName);
      expect(longLocal.directory.length).toBeLessThanOrEqual(
        MAX_PORTABLE_COMPONENT_LENGTH,
      );
      expect(path.basename(longLocal.tests[0]!.file).length).toBeLessThanOrEqual(
        MAX_PORTABLE_COMPONENT_LENGTH,
      );
      expect(isPortableSuiteDirectory(longLocal.directory)).toBe(true);
      expect(isPortableTestFile(path.basename(longLocal.tests[0]!.file))).toBe(true);
      expect(reservedLocal.directory).toBe("suite-con");
      expect(path.basename(reservedLocal.tests[0]!.file)).toBe("test-prn.md");
      expect(reservedLocal.manifest.name).toBe("cOn");
      expect(reservedLocal.tests[0]?.test.name).toBe("pRn");
    } finally {
      await platform.close();
      await repository.remove();
    }
  });

  it("keeps separator-normalized collision paths stable across pulls", async () => {
    const platform = await startPlatform();
    const key = "egma_sk_portable-collisions";
    const slashSuite = platform.suites.add("North/West");
    const backslashSuite = platform.suites.add("North\\West");
    platform.tests.add({
      suiteId: slashSuite.id,
      name: "Books/visit",
      scenario: "The caller asks for Tuesday.",
      expectedBehaviors: ["The agent offers Tuesday."],
    });
    platform.tests.add({
      suiteId: slashSuite.id,
      name: "Books\\visit",
      scenario: "The caller asks for Wednesday.",
      expectedBehaviors: ["The agent offers Wednesday."],
    });
    const repository = await fixtureRepository(platform, slashSuite, key);

    const localPaths = async (): Promise<readonly string[]> => {
      const pulled = await readRepository(folderPathsIn(repository.dir));
      return pulled.suites
        .flatMap((entry) => [
          entry.directory,
          ...entry.tests.map((test) => `${entry.directory}/${path.basename(test.file)}`),
        ])
        .sort();
    };

    try {
      await pullFixture(platform, repository, key);
      const first = await localPaths();
      expect(new Set(first).size).toBe(first.length);
      expect(first).toHaveLength(4);
      expect(first.every((entry) => !entry.includes("\\"))).toBe(true);

      await pullFixture(platform, repository, key);
      expect(await localPaths()).toEqual(first);
    } finally {
      await platform.close();
      await repository.remove();
    }
  });

  it("keeps a locally renamed pinned test instead of overwriting it on pull", async () => {
    const release = await suite("release", SUITE_ID, "Release");
    const file = path.join(release, "books-a-visit.md");
    const local = serializeTestFile(
      aTestFile({
        name: "Books a visit locally renamed",
        description: "Local description",
        scenario: "The caller asks for Tuesday.",
        expectedBehaviors: blocking("The agent books Tuesday."),
        version: VERSION_ID,
        identityRevision: REVISION,
      }),
    );
    await writeFile(file, local);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${URL}/v1/test-suites?projectId=${PROJECT_ID}`) {
        return new JsonResponse(
          JSON.stringify({
            testSuites: [{ id: SUITE_ID, projectId: PROJECT_ID, name: "Release" }],
            nextPageToken: null,
          }),
        );
      }
      if (url.startsWith(`${URL}/v1/tests?`)) {
        return new JsonResponse(JSON.stringify({ tests: [testBody()], nextPageToken: null }));
      }
      if (url === `${URL}/v1/mock-tools`) {
        return new JsonResponse(JSON.stringify({ mockTools: [], nextPageToken: null }));
      }
      return new JsonResponse(JSON.stringify({ message: "unexpected" }), { status: 404 });
    };

    const report = await pullRepository({
      signedIn: { url: URL, key: "key" },
      paths: folderPathsIn(workspace.dir),
      fetchImpl,
    });

    expect(await readFile(file, "utf8")).toBe(local);
    expect(report.kept).toEqual([
      expect.objectContaining({
        shown: "egma/tests/release/books-a-visit.md",
        reason: expect.stringContaining("local changes"),
      }),
    ]);
    expect(report.tests).toEqual([]);
  });

});
