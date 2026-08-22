import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  applyRepositoryChangeSet,
  archiveConnection,
  cancelRun,
  connectClickHouse,
  createTest,
  createTestSuite,
  deleteTest,
  deleteTestSuite,
  disconnectClickHouse,
  editTest,
  getRun,
  getSimulationExecutionEvidence,
  getTest,
  getTestSuite,
  IdempotencyConflictError,
  listRunEvents,
  listRunHistory,
  listSimulations,
  listTests,
  NotPermittedError,
  readRunFold,
  RECOMMENDED_PERSONA_MODELS,
  renameTestSuite,
  RunWriteRefusedError,
  startRun,
  TestMovedOnError,
  type NewRun,
  type Test,
} from "@egma/db";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import {
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  seedTestFactory,
  type SeededWorld,
} from "./support/test-factory.ts";
import { seedGraderCopies } from "./support/tenancy.ts";

let world: SeededWorld;
let database: MigratedDatabase;
let store: MigratedTraceStore;
let connectionId: string;

const authored = {
  scenario: "The caller needs to move an appointment to next week.",
  expectedBehaviors: ["confirms the new time before finishing"],
} as const;

async function testIn(
  suiteId: string,
  name: string,
  personaIds: readonly string[] = [world.rita],
): Promise<Test> {
  return createTest(actingAsAcme(), {
    suiteId,
    name,
    ...authored,
    personaIds,
  });
}

function runInput(suiteId: string, extra: Partial<NewRun> = {}): NewRun {
  return {
    suiteId,
    agentId: world.frontDesk,
    connectionId,
    idempotencyKey: newId("run"),
    ...extra,
  };
}

beforeAll(async () => {
  world = await seedTestFactory("test_suites");
  database = world.database;
  store = await createMigratedTraceStore("test_suites");
  connectClickHouse({ clickhouseUrl: store.url, maxOpenConnections: 2 });
  await seedGraderCopies();

  const connection = await addConnection(
    actingAsAcme(),
    world.frontDesk,
    {
      name: "Suite test chat",
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "suite_test_agent" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  );
  if (connection === undefined) throw new Error("suite test connection was not created");
  connectionId = connection.id;
});

afterAll(async () => {
  await disconnectClickHouse();
  await store.drop();
  await database.drop();
});

describe("suite identity and membership", () => {
  it("keeps suite and test writes inside their project and organization", async () => {
    await expect(
      createTestSuite(actingAsAcme("viewer"), { name: "Viewer write" }),
    ).rejects.toThrow(NotPermittedError);

    const suite = await createTestSuite(actingAsAcme(), { name: "Private suite" });
    const created = await testIn(suite.id, "Private test");
    expect((await getTestSuite(actingAsAcme("viewer"), suite.id))?.id).toBe(suite.id);
    expect((await getTest(actingAsAcme("viewer"), created.id))?.id).toBe(created.id);
    expect(await getTestSuite(actingAsGlobex(), suite.id)).toBeUndefined();
    expect(await getTest(actingAsGlobex(), created.id)).toBeUndefined();
    await expect(
      createTest(actingAsGlobex(), {
        suiteId: suite.id,
        name: "Cross-tenant test",
        ...authored,
      }),
    ).rejects.toThrow(/no active test suite/u);

    await deleteTestSuite(actingAsAcme(), suite.id);
  });

  it("refuses a hand-authored suite identity and rolls back earlier writes", async () => {
    const outbound = { ...actingAsAcme(), projectId: acme.outbound };
    await expect(
      applyRepositoryChangeSet(outbound, {
        suites: [
          { id: acme.outboundSuite, name: "A rename that must roll back" },
          { id: newId("ste"), name: "Hand authored" },
        ],
        tests: [],
        mockTools: [],
      }),
    ).rejects.toThrow(/create the suite first/u);
    expect((await getTestSuite(outbound, acme.outboundSuite))?.name).toBe(
      "Outbound",
    );
  });

  it("requires both repository pins and writes nothing when one is missing", async () => {
    const created = await applyRepositoryChangeSet(actingAsAcme(), {
      suites: [{ id: acme.suite, name: "Regression" }],
      tests: [{
        clientRef: "egma/tests/regression/repository-pin.md",
        suiteId: acme.suite,
        name: "Repository pin",
        ...authored,
        personaIds: [world.rita],
      }],
      mockTools: [],
    });
    const written = created.tests[0]?.test;
    if (written === undefined) throw new Error("repository test was not created");

    await expect(
      applyRepositoryChangeSet(actingAsAcme(), {
        suites: [{ id: acme.suite, name: "Must roll back" }],
        tests: [{
          clientRef: "egma/tests/regression/repository-pin.md",
          suiteId: acme.suite,
          name: "Must not land",
          ...authored,
          personaIds: [world.rita],
          expectedVersionId: written.versionId,
        }],
        mockTools: [],
      }),
    ).rejects.toThrow(/both expected_version_id and expected_revision/u);

    expect((await getTestSuite(actingAsAcme(), acme.suite))?.name).toBe("Regression");
    expect((await getTest(actingAsAcme(), written.id))?.name).toBe("Repository pin");
  });

  it("serializes a repository push with an ordinary suite rename without deadlock", async () => {
    const outbound = { ...actingAsAcme(), projectId: acme.outbound };
    const blocker = await openSingleConnection(database.url);
    await blocker.sql("begin");
    await blocker.sql(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`egma-repository:${acme.outbound}`],
    );
    try {
      const push = applyRepositoryChangeSet(outbound, {
        suites: [{ id: acme.outboundSuite, name: "Repository rename" }],
        tests: [],
        mockTools: [],
      });
      const browser = renameTestSuite(outbound, acme.outboundSuite, {
        name: "Browser rename",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await blocker.sql("commit");

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.all([push, browser]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("repository push and suite rename deadlocked")),
            5_000,
          );
        }),
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
      expect(settled[0].tests).toEqual([]);
      expect(settled[1]?.id).toBe(acme.outboundSuite);
      expect(["Repository rename", "Browser rename"]).toContain(
        (await getTestSuite(outbound, acme.outboundSuite))?.name,
      );
    } finally {
      await blocker.sql("rollback").catch(() => undefined);
      await blocker.close();
    }
  });

  it("allows duplicate names and refuses blank names", async () => {
    const first = await createTestSuite(actingAsAcme(), { name: "Regression" });
    const second = await createTestSuite(actingAsAcme(), { name: "Regression" });

    expect(first.id).not.toBe(second.id);
    expect(first.name).toBe("Regression");
    expect(second.name).toBe("Regression");
    await expect(
      createTestSuite(actingAsAcme(), { name: "   " }),
    ).rejects.toThrow(/needs a name/u);
  });

  it("keeps an empty suite and returns an empty page", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Empty" });
    expect(await getTestSuite(actingAsAcme(), suite.id)).toMatchObject({
      id: suite.id,
      name: "Empty",
    });
    expect(await listTests(actingAsAcme(), suite.id)).toEqual({
      items: [],
      nextCursor: undefined,
    });
  });

  it("pages tests within one suite and never crosses into its sibling", async () => {
    const firstSuite = await createTestSuite(actingAsAcme(), { name: "First" });
    const secondSuite = await createTestSuite(actingAsAcme(), { name: "Second" });
    await testIn(firstSuite.id, "First one");
    await testIn(firstSuite.id, "First two");
    await testIn(secondSuite.id, "Second one");

    const firstPage = await listTests(actingAsAcme(), firstSuite.id, { limit: 1 });
    expect(firstPage?.items).toHaveLength(1);
    expect(firstPage?.items[0]?.suiteId).toBe(firstSuite.id);
    expect(firstPage?.nextCursor).toBeDefined();
    const firstCursor = firstPage?.nextCursor;
    if (firstCursor === undefined) throw new Error("the first page has no cursor");
    const secondPage = await listTests(actingAsAcme(), firstSuite.id, {
      limit: 1,
      cursor: firstCursor,
    });
    expect(secondPage?.items).toHaveLength(1);
    expect(secondPage?.items[0]?.suiteId).toBe(firstSuite.id);
    expect(secondPage?.nextCursor).toBeUndefined();

    const siblingPage = await listTests(actingAsAcme(), secondSuite.id, { limit: 1 });
    expect(siblingPage?.items).toHaveLength(1);
    expect(siblingPage?.items[0]?.suiteId).toBe(secondSuite.id);
  });

  it("blocks raw reparenting at the database trigger", async () => {
    const source = await createTestSuite(actingAsAcme(), { name: "Source" });
    const destination = await createTestSuite(actingAsAcme(), { name: "Destination" });
    const created = await testIn(source.id, "Cannot move");

    await expect(
      database.sql("update test set suite_id = $1 where id = $2", [
        destination.id,
        created.id,
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    expect((await getTest(actingAsAcme(), created.id))?.suiteId).toBe(source.id);
  });
});

describe("permanent deletion", () => {
  it("deleting a suite tombstones every contained test in one operation", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Delete together" });
    const first = await testIn(suite.id, "First contained test");
    const second = await testIn(suite.id, "Second contained test");

    expect(await deleteTestSuite(actingAsAcme(), suite.id)).toMatchObject({ id: suite.id });
    expect(await getTestSuite(actingAsAcme(), suite.id)).toBeUndefined();
    expect(await getTest(actingAsAcme(), first.id)).toBeUndefined();
    expect(await getTest(actingAsAcme(), second.id)).toBeUndefined();

    const { rows } = await database.sql<{ deleted: boolean }>(
      `select deleted_at is not null as deleted from test
       where id in ($1, $2) order by id`,
      [first.id, second.id],
    );
    expect(rows).toEqual([{ deleted: true }, { deleted: true }]);
  });

  it("deleting one test leaves its suite active", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Keep container" });
    const created = await testIn(suite.id, "Delete only me");

    expect(await deleteTest(actingAsAcme(), created.id)).toBe(true);
    expect(await getTestSuite(actingAsAcme(), suite.id)).toMatchObject({ id: suite.id });
    expect(await listTests(actingAsAcme(), suite.id)).toEqual({
      items: [],
      nextCursor: undefined,
    });
  });
});

describe("complete-suite runs", () => {
  it("replays one network idempotency key and refuses a changed request", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Idempotent run" });
    await testIn(suite.id, "Run once");
    const input = runInput(suite.id, { idempotencyKey: "network-attempt-1" });

    const first = await startRun(actingAsAcme(), input);
    const replay = await startRun(actingAsAcme(), input);
    expect(replay.id).toBe(first.id);
    const { rows } = await database.sql<{ count: string }>(
      "select count(*)::text as count from run where id = $1",
      [first.id],
    );
    expect(rows).toEqual([{ count: "1" }]);
    await expect(
      startRun(actingAsAcme(), { ...input, name: "Different request" }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("requires the current version for content edits and refuses stale writes", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Edit guards" });
    const created = await testIn(suite.id, "Guarded test");
    await expect(
      editTest(actingAsAcme(), created.id, { scenario: "Unpinned change" }),
    ).rejects.toThrow(/needs expected_version_id/u);
    await expect(
      editTest(actingAsAcme(), created.id, {
        name: "Malformed revision",
        expectedRevision: "not-a-revision",
      }),
    ).rejects.toThrow(/not a revision id/u);

    const edited = await editTest(actingAsAcme(), created.id, {
      scenario: "Pinned current change",
      expectedVersionId: created.versionId,
    });
    expect(edited?.versionId).not.toBe(created.versionId);
    await expect(
      editTest(actingAsAcme(), created.id, {
        scenario: "Stale change",
        expectedVersionId: created.versionId,
      }),
    ).rejects.toThrow(TestMovedOnError);
  });

  it("pins every current version and refuses empty or stale expectations", async () => {
    const empty = await createTestSuite(actingAsAcme(), { name: "Nothing to run" });
    await expect(startRun(actingAsAcme(), runInput(empty.id))).rejects.toThrow(
      RunWriteRefusedError,
    );

    const suite = await createTestSuite(actingAsAcme(), { name: "Full suite" });
    // Names deliberately disagree with identity order. Planning is stable by
    // test ID, never by display name or by the caller's expected-set order.
    const first = await testIn(suite.id, "Zulu current test");
    const second = await testIn(suite.id, "Alpha current test");
    const third = await testIn(suite.id, "Middle current test");
    const expected = [
      { testId: third.id, versionId: third.versionId },
      { testId: first.id, versionId: first.versionId },
      { testId: second.id, versionId: second.versionId },
    ];

    const started = await startRun(
      actingAsAcme(),
      runInput(suite.id, { name: "Release candidate", expectedTestVersions: expected }),
    );
    expect(started.name).toBe("Release candidate");
    expect(started.expectedSimulationCount).toBe(3);
    const simulations = await listSimulations(actingAsAcme(), started.id, { limit: 10 });
    const versionByTest = new Map(expected.map((one) => [one.testId, one.versionId]));
    const stableTestIds = [first.id, second.id, third.id].sort((left, right) =>
      left.localeCompare(right));
    expect(simulations?.items.map((one) => [
      one.position,
      one.testId,
      one.testVersionId,
    ])).toEqual(stableTestIds.map((testId, index) => [
      index + 1,
      testId,
      versionByTest.get(testId),
    ]));

    const edited = await editTest(actingAsAcme(), first.id, {
      scenario: "The caller now needs to move two appointments.",
      expectedVersionId: first.versionId,
    });
    expect(edited?.versionId).not.toBe(first.versionId);
    await expect(
      startRun(
        actingAsAcme(),
        runInput(suite.id, { expectedTestVersions: expected }),
      ),
    ).rejects.toThrow(RunWriteRefusedError);
    await expect(
      startRun(
        actingAsAcme(),
        runInput(suite.id, {
          expectedTestVersions: [
            { testId: first.id, versionId: edited?.versionId ?? "" },
            { testId: first.id, versionId: edited?.versionId ?? "" },
          ],
        }),
      ),
    ).rejects.toThrow(RunWriteRefusedError);
  });

  it("refuses an expected set after suite membership changes", async () => {
    const suite = await createTestSuite(actingAsAcme(), {
      name: "Membership precondition",
    });
    const first = await testIn(suite.id, "Known first test");
    const second = await testIn(suite.id, "Known second test");
    const expected = [
      { testId: first.id, versionId: first.versionId },
      { testId: second.id, versionId: second.versionId },
    ];

    // The repository read its complete set, then another author added a test.
    // Starting the shortened set must refuse the whole run with zero writes.
    await testIn(suite.id, "Added after the read");
    await expect(
      startRun(
        actingAsAcme(),
        runInput(suite.id, { expectedTestVersions: expected }),
      ),
    ).rejects.toThrow(RunWriteRefusedError);
    const { rows } = await database.sql<{ count: string }>(
      "select count(*)::text as count from run where suite_id = $1",
      [suite.id],
    );
    expect(rows).toEqual([{ count: "0" }]);
  });

  it("reads the suite's current name and deleted marker on old runs", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Before rename" });
    await testIn(suite.id, "History test");
    const started = await startRun(actingAsAcme(), runInput(suite.id));

    await renameTestSuite(actingAsAcme(), suite.id, { name: "After rename" });
    expect(await getRun(actingAsAcme(), started.id)).toMatchObject({
      suiteName: "After rename",
      suiteDeleted: false,
    });

    await deleteTestSuite(actingAsAcme(), suite.id);
    expect(await getRun(actingAsAcme(), started.id)).toMatchObject({
      suiteName: "After rename",
      suiteDeleted: true,
    });
  });
});

async function seedManyPersonas(count: number): Promise<readonly string[]> {
  const connection = await openSingleConnection(database.url);
  const ids = Array.from({ length: count }, () => ({
    persona: newId("prs"),
    version: newId("prsv"),
    revision: newId("rev"),
  }));
  try {
    await connection.sql("begin");
    await connection.sql(
      `insert into persona
         (id, organization_id, project_id, name, current_version_id, revision)
       select seeded.persona_id, $1, $2,
         'Paged caller ' || seeded.ordinality,
         seeded.version_id, seeded.revision
       from unnest($3::text[], $4::text[], $5::text[])
         with ordinality as seeded(persona_id, version_id, revision, ordinality)`,
      [
        actingAsAcme().organizationId,
        actingAsAcme().projectId,
        ids.map((row) => row.persona),
        ids.map((row) => row.version),
        ids.map((row) => row.revision),
      ],
    );
    await connection.sql(
      `insert into persona_version (id, persona_id, version, traits, models)
       select seeded.version_id, seeded.persona_id, 1, $1::jsonb, $2::jsonb
       from unnest($3::text[], $4::text[])
         as seeded(version_id, persona_id)`,
      [
        JSON.stringify({ personality: "Patient", language: "en-US" }),
        JSON.stringify(RECOMMENDED_PERSONA_MODELS),
        ids.map((row) => row.version),
        ids.map((row) => row.persona),
      ],
    );
    await connection.sql("commit");
  } catch (error) {
    await connection.sql("rollback").catch(() => undefined);
    throw error;
  } finally {
    await connection.close();
  }
  return ids.map((row) => row.persona);
}

async function seedManyTests(
  suiteId: string,
  count: number,
): Promise<readonly { testId: string; versionId: string }[]> {
  const connection = await openSingleConnection(database.url);
  const ids = Array.from({ length: count }, () => ({
    testId: newId("tst"),
    versionId: newId("tstv"),
    revision: newId("rev"),
  }));
  try {
    await connection.sql("begin");
    await connection.sql(
      `insert into test
         (id, organization_id, project_id, suite_id, name,
          current_version_id, revision)
       select seeded.test_id, $1, $2, $3,
         'Paged test ' || seeded.ordinality,
         seeded.version_id, seeded.revision
       from unnest($4::text[], $5::text[], $6::text[])
         with ordinality as seeded(test_id, version_id, revision, ordinality)`,
      [
        actingAsAcme().organizationId,
        actingAsAcme().projectId,
        suiteId,
        ids.map((row) => row.testId),
        ids.map((row) => row.versionId),
        ids.map((row) => row.revision),
      ],
    );
    await connection.sql(
      `insert into test_version (id, test_id, version, content)
       select seeded.version_id, seeded.test_id, 1, $1::jsonb
       from unnest($2::text[], $3::text[]) as seeded(version_id, test_id)`,
      [
        JSON.stringify({
          scenario: authored.scenario,
          expectedBehaviors: authored.expectedBehaviors,
          mockOverrides: [],
        }),
        ids.map((row) => row.versionId),
        ids.map((row) => row.testId),
      ],
    );
    await connection.sql(
      `insert into test_persona (test_version_id, persona_id, position)
       select seeded.version_id, $1, 1
       from unnest($2::text[]) as seeded(version_id)`,
      [world.rita, ids.map((row) => row.versionId)],
    );
    await connection.sql("commit");
  } catch (error) {
    await connection.sql("rollback").catch(() => undefined);
    throw error;
  } finally {
    await connection.close();
  }
  return ids;
}

describe("unlimited execution with bounded reads", () => {
  it("starts more than 200 simulations and pages them without expanding the run header", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Large suite" });
    const callers = await seedManyPersonas(505);
    await testIn(suite.id, "Large audience", callers);

    const started = await startRun(actingAsAcme(), runInput(suite.id));
    expect(started.expectedSimulationCount).toBe(505);

    const first = await listSimulations(actingAsAcme(), started.id, { limit: 200 });
    expect(first?.items).toHaveLength(200);
    expect(first?.nextCursor).toMatch(/^sim_/u);
    const evidence = await getSimulationExecutionEvidence(
      actingAsAcme(),
      first?.items[0]?.id ?? "",
    );
    expect(evidence?.testVersion).not.toHaveProperty("personas");
    expect(evidence?.testVersion.scenario).toBe(authored.scenario);
    const second = await listSimulations(actingAsAcme(), started.id, {
      limit: 200,
      cursor: first?.nextCursor,
    });
    expect(second?.items).toHaveLength(200);
    expect(second?.nextCursor).toMatch(/^sim_/u);
    const third = await listSimulations(actingAsAcme(), started.id, {
      limit: 200,
      cursor: second?.nextCursor,
    });
    expect(third?.items).toHaveLength(105);
    expect(third?.nextCursor).toBeUndefined();

    const detail = await readRunFold(actingAsAcme(), started.id);
    expect(detail?.fold.simulations.queued).toBe(505);
    const history = await listRunHistory(actingAsAcme(), { limit: 1 });
    expect(history.items[0]?.run.id).toBe(started.id);
    expect(history.items[0]?.fold.simulations.queued).toBe(505);

    const canceled = await cancelRun(actingAsAcme(), started.id);
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.canceledCount).toBe(505);
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from run_event where run_id = $1",
      [started.id],
    );
    // 505 bounded simulation-cancel events, followed by one run event.
    expect(Number(rows[0]?.count)).toBe(506);

    const firstEvents = await listRunEvents(actingAsAcme(), started.id, {
      after: 0,
    });
    expect(firstEvents?.events).toHaveLength(200);
    expect(firstEvents?.done).toBe(false);
    const middleEvents = await listRunEvents(actingAsAcme(), started.id, {
      after: firstEvents?.next,
    });
    expect(middleEvents?.events).toHaveLength(200);
    expect(middleEvents?.done).toBe(false);
    const lastEvents = await listRunEvents(actingAsAcme(), started.id, {
      after: middleEvents?.next,
    });
    expect(lastEvents?.events).toHaveLength(106);
    expect(lastEvents?.done).toBe(true);
    expect(lastEvents?.next).toBe(506);
  });

  it("pages more than one internal test batch while freezing the exact suite", async () => {
    const suite = await createTestSuite(actingAsAcme(), { name: "Many tests" });
    const tests = await seedManyTests(suite.id, 505);
    const started = await startRun(
      actingAsAcme(),
      runInput(suite.id, {
        expectedTestVersions: tests.map((one) => ({
          testId: one.testId,
          versionId: one.versionId,
        })),
      }),
    );
    expect(started.expectedSimulationCount).toBe(505);

    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = await listSimulations(actingAsAcme(), started.id, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page).toBeDefined();
      seen += page?.items.length ?? 0;
      cursor = page?.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toBe(505);
  });

  it("archives a connection by settling a large suite in bounded batches", async () => {
    const dedicated = await addConnection(actingAsAcme(), world.frontDesk, {
      name: "Large archive target",
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "suite_archive_target" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    if (dedicated === undefined) throw new Error("archive target was not created");
    const suite = await createTestSuite(actingAsAcme(), { name: "Archive batch" });
    await seedManyTests(suite.id, 505);
    const started = await startRun(
      actingAsAcme(),
      runInput(suite.id, { connectionId: dedicated.id }),
    );

    const archived = await archiveConnection(
      actingAsAcme(),
      world.frontDesk,
      dedicated.id,
      { expectedRevision: dedicated.revision },
    );
    expect(archived?.canceledRunCount).toBe(1);
    expect((await getRun(actingAsAcme(), started.id))?.canceledCount).toBe(505);
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from run_event where run_id = $1",
      [started.id],
    );
    expect(Number(rows[0]?.count)).toBe(506);
  });
});
