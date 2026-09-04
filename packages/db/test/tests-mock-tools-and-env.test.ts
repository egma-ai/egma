import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
  listTestVersions,
  LARGEST_JOB_DISPATCH_METADATA_BYTES,
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  RESERVED_ENV_VARIABLE_PREFIX,
  serializedJobDispatchMetadata,
  type TestEnv,
  type TestMockTool,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  rescheduling,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * The world a test carries: the tools it answers for itself, and the env it
 * asks the lane for.
 *
 * Both are versioned test content — a change to either mints a version exactly
 * as a changed behavior does — and both are stored in columns of their own
 * beside the content rather than inside it, so the claim gate can ask whether a
 * run mocks anything without reading a single answer.
 *
 * **Every refusal here is authored-time.** The person who can fix a reserved
 * variable name or an oversize answer is the one writing the test, and the
 * alternative is a simulation discovering it halfway through a conversation
 * where nobody who could act on it is reading.
 */

let database: MigratedDatabase;
/** The caller every authored fixture names, because a test says who calls. */
let rita: string;

const MOCK_TOOLS: readonly TestMockTool[] = [
  { tool: "get_availability", answer: { slots: [] } },
  { tool: "book", error: "calendar down" },
];

const ENV: TestEnv = {
  retell_dynamic_variables: { caller_name: "Margaret" },
  job_dispatch_metadata: { tenant: "acme" },
};

/** One authored test with a world, for the file's ordinary case. */
function withWorld(overrides: Record<string, unknown> = {}) {
  return {
    ...rescheduling,
    personaIds: [rita],
    mockTools: MOCK_TOOLS,
    env: ENV,
    ...overrides,
  };
}

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("tests_mock_tools_and_env"));
});

afterAll(async () => {
  await database.drop();
});

describe("a test that carries its own world", () => {
  it("takes both on a create and hands both back at every grain it is read at", async () => {
    const created = await createTest(actingAsAcme(), withWorld());

    const fetched = await getTest(actingAsAcme(), created.id);
    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    const page = await listTests(actingAsAcme(), acme.suite, { limit: 200 });
    const listed = page?.items.find((item) => item.id === created.id);
    const history = await listTestVersions(actingAsAcme(), created.id);

    for (const read of [created, fetched, frozen, listed, history?.items[0]]) {
      expect(read?.mockTools).toEqual(MOCK_TOOLS);
      expect(read?.env).toEqual(ENV);
    }
  });

  it("stores each in a column of its own, and neither inside the content", async () => {
    const created = await createTest(actingAsAcme(), withWorld());

    const { rows } = await database.sql<{
      keys: string[];
      mock_tools: unknown;
      env: unknown;
    }>(
      `select array(select jsonb_object_keys(content) order by 1) as keys,
              mock_tools, env
         from test_version where id = $1`,
      [created.versionId],
    );

    expect(rows[0]?.keys).toEqual(["expectedBehaviors", "scenario"]);
    expect(rows[0]?.mock_tools).toEqual(MOCK_TOOLS);
    expect(rows[0]?.env).toEqual(ENV);
  });

  /**
   * Null rather than an empty list and an empty object, because the claim gate
   * asks `mock_tools is not null` and never reads a value. Two spellings of
   * "this test mocks nothing" would make that question a lie for one of them.
   */
  it("stores nothing at all for a test that asks for neither", async () => {
    const created = await createTest(actingAsAcme(), {
      ...rescheduling,
      personaIds: [rita],
    });

    const { rows } = await database.sql<{ mock_tools: unknown; env: unknown }>(
      "select mock_tools, env from test_version where id = $1",
      [created.versionId],
    );
    expect(rows[0]).toEqual({ mock_tools: null, env: null });

    // And a read says the same thing in the shapes a caller works in.
    expect(created.mockTools).toEqual([]);
    expect(created.env).toBeNull();
  });

  it("normalizes an empty env, and an env whose halves are empty, to none", async () => {
    for (const env of [{}, { retell_dynamic_variables: {} }, {
      retell_dynamic_variables: {},
      job_dispatch_metadata: {},
    }]) {
      const created = await createTest(
        actingAsAcme(),
        withWorld({ env, mockTools: [] }),
      );
      expect(created.env).toBeNull();
    }
  });
});

describe("editing the world a test carries", () => {
  it("mints one version when the mock tools change, with the env unchanged", async () => {
    const created = await createTest(actingAsAcme(), withWorld());

    const edited = await editTest(actingAsAcme(), created.id, {
      mockTools: [{ tool: "get_availability", answer: { slots: ["14:00"] } }],
      expectedVersionId: created.versionId,
    });

    expect(edited?.version).toBe(created.version + 1);
    expect(edited?.versionId).not.toBe(created.versionId);
    expect(edited?.mockTools).toEqual([
      { tool: "get_availability", answer: { slots: ["14:00"] } },
    ]);
    // Carried forward untouched, which is what "what an edit leaves out, it
    // keeps" has to mean for a field stored in a column of its own.
    expect(edited?.env).toEqual(ENV);
    expect(edited?.expectedBehaviors).toEqual(rescheduling.expectedBehaviors);

    // The version left behind still says what it said, because a run that
    // pinned it has to stay readable.
    const before = await getTestVersion(actingAsAcme(), created.versionId);
    expect(before?.mockTools).toEqual(MOCK_TOOLS);
  });

  it("mints one version when the env changes, with the mock tools unchanged", async () => {
    const created = await createTest(actingAsAcme(), withWorld());

    const edited = await editTest(actingAsAcme(), created.id, {
      env: { retell_dynamic_variables: { caller_name: "Ada" } },
      expectedVersionId: created.versionId,
    });

    expect(edited?.version).toBe(created.version + 1);
    expect(edited?.env).toEqual({
      retell_dynamic_variables: { caller_name: "Ada" },
    });
    expect(edited?.mockTools).toEqual(MOCK_TOOLS);
  });

  /**
   * `[]` and `null` are the two ways of saying "no longer": mocking nothing and
   * asking for nothing are states a test can be in, and are the states most
   * tests are in. Leaving a field out keeps it, which the two cases above show.
   */
  it("clears the mock tools with an empty list and the env with null", async () => {
    const created = await createTest(actingAsAcme(), withWorld());

    const cleared = await editTest(actingAsAcme(), created.id, {
      mockTools: [],
      env: null,
      expectedVersionId: created.versionId,
    });

    expect(cleared?.mockTools).toEqual([]);
    expect(cleared?.env).toBeNull();

    const { rows } = await database.sql<{ mock_tools: unknown; env: unknown }>(
      "select mock_tools, env from test_version where id = $1",
      [cleared?.versionId],
    );
    expect(rows[0]).toEqual({ mock_tools: null, env: null });
  });

  /**
   * The stored value came back through jsonb, which re-orders an object's keys
   * as it pleases. Comparing what was written against what was read as written
   * would call every re-send a change and mint a version for typing the same
   * thing twice.
   */
  it("mints nothing when the same world is sent again in another key order", async () => {
    const created = await createTest(
      actingAsAcme(),
      withWorld({
        mockTools: [
          { tool: "get_availability", answer: { open: true, slots: [] } },
        ],
        env: { job_dispatch_metadata: { tenant: "acme", tier: 2 } },
      }),
    );

    const again = await editTest(actingAsAcme(), created.id, {
      mockTools: [
        { tool: "get_availability", answer: { slots: [], open: true } },
      ],
      env: { job_dispatch_metadata: { tier: 2, tenant: "acme" } },
      expectedVersionId: created.versionId,
    });

    expect(again?.versionId).toBe(created.versionId);
    expect(again?.version).toBe(created.version);
  });
});

describe("what a test's world is refused for", () => {
  /** Every refusal below leaves the tables exactly as it found them. */
  async function refuses(
    input: Record<string, unknown>,
    reason: RegExp,
  ): Promise<void> {
    const before = await rowCounts();
    await expect(createTest(actingAsAcme(), withWorld(input))).rejects.toThrow(
      reason,
    );
    expect(await rowCounts()).toEqual(before);
  }

  it("refuses a variable Egma keeps for itself, naming the prefix", async () => {
    await refuses(
      {
        env: {
          retell_dynamic_variables: {
            [`${RESERVED_ENV_VARIABLE_PREFIX}run_id`]: "run_1",
          },
        },
      },
      /egma_/u,
    );
  });

  it("refuses an env key nothing in Egma carries, naming it", async () => {
    await refuses({ env: { livekit_room_metadata: { tenant: "acme" } } }, /livekit_room_metadata/u);
  });

  it("refuses a variable whose value is not text", async () => {
    await refuses(
      { env: { retell_dynamic_variables: { caller_age: 41 } } },
      /retell_dynamic_variables\.caller_age/u,
    );
  });

  it("refuses dispatch metadata that is not an object", async () => {
    for (const metadata of [[1, 2, 3], "acme", 7, true]) {
      await refuses(
        { env: { job_dispatch_metadata: metadata } },
        /job_dispatch_metadata is a JSON object/u,
      );
    }
  });

  /**
   * Measured on the UTF-8 bytes of the very string egma hands LiveKit, so what
   * is admitted here is always a value the dispatch can carry. A refusal at the
   * dispatch instead would be a room already opened and every simulation on it
   * failing for a reason the record cannot act on.
   */
  it("refuses dispatch metadata larger than the dispatch carries, and says the size", async () => {
    const roomy = { tenant: "a".repeat(LARGEST_JOB_DISPATCH_METADATA_BYTES) };
    await refuses(
      { env: { job_dispatch_metadata: roomy } },
      /job_dispatch_metadata is \d+ bytes once serialized/u,
    );

    // Bytes rather than characters: this one is under the ceiling in
    // characters and over it in bytes, and a length check would let it
    // through to the dispatch.
    const multibyte = { tenant: "€".repeat(200_000) };
    expect(JSON.stringify(multibyte).length).toBeLessThan(
      LARGEST_JOB_DISPATCH_METADATA_BYTES,
    );
    expect(
      Buffer.byteLength(serializedJobDispatchMetadata(multibyte), "utf8"),
    ).toBeGreaterThan(LARGEST_JOB_DISPATCH_METADATA_BYTES);
    await refuses(
      { env: { job_dispatch_metadata: multibyte } },
      /job_dispatch_metadata is \d+ bytes once serialized/u,
    );
  });

  it("refuses one tool answered for twice", async () => {
    await refuses(
      {
        mockTools: [
          { tool: "book", answer: { ok: true } },
          { tool: "book", error: "calendar down" },
        ],
      },
      /answers for "book" twice/u,
    );
  });

  it("refuses an entry that answers two ways, and one that answers none", async () => {
    await refuses(
      { mockTools: [{ tool: "book", answer: { ok: true }, error: "down" }] },
      /both answer and error/u,
    );
    await refuses({ mockTools: [{ tool: "book" }] }, /sent neither/u);
  });

  it("refuses a blank tool name", async () => {
    await refuses({ mockTools: [{ tool: "   ", answer: 1 }] }, /this one is blank/u);
  });

  /**
   * The cap is the exchange's, counted against the tagged message the wire
   * carries — `{"answer":…}` — because that is what the simulator measures and
   * a cap measured two ways is two caps.
   */
  it("refuses an answer larger than the exchange carries, and says the size", async () => {
    const document = "a".repeat(LARGEST_MOCK_TOOL_ANSWER_BYTES);
    await refuses(
      { mockTools: [{ tool: "book", answer: document }] },
      /answer is \d+ bytes once serialized and tagged/u,
    );
    await refuses(
      { mockTools: [{ tool: "book", error: document }] },
      /error is \d+ bytes once serialized and tagged/u,
    );
  });

  /** An edit is refused on exactly the grounds a create is. */
  it("refuses the same things on an edit, and writes nothing", async () => {
    const created = await createTest(actingAsAcme(), withWorld());
    const before = await rowCounts();

    await expect(
      editTest(actingAsAcme(), created.id, {
        env: { retell_dynamic_variables: { egma_run_id: "run_1" } },
        expectedVersionId: created.versionId,
      }),
    ).rejects.toThrow(/egma_/u);

    expect(await rowCounts()).toEqual(before);
    const unchanged = await getTest(actingAsAcme(), created.id);
    expect(unchanged?.versionId).toBe(created.versionId);
    expect(unchanged?.env).toEqual(ENV);
  });
});
