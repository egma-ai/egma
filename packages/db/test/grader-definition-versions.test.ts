import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getGrader,
  getGraderVersion,
  GRADER_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  seedGraderLibrary,
  useLibraryEntry,
  type AuthContext,
  type PredefinedGrader,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

describe("immutable grader definition versions", () => {
  let database: MigratedDatabase;
  const organizationId = newId("org");
  const projectId = newId("prj");
  const userId = newId("usr");
  const auth: AuthContext = {
    userId,
    organizationId,
    projectId,
    role: "admin",
    via: "session",
  };

  beforeAll(async () => {
    database = await createConnectedDatabase("grader_definition_versions");
    await seedOrganization(database, organizationId, [
      { id: projectId, slug: "default" },
    ]);
    await seedUser(database, userId, "grader-definitions@acme.example");
  });

  afterAll(async () => {
    await database.drop();
  });

  it("keeps old meaning pinned and promotes only compatible new definitions", async () => {
    const expected = catalogEntry(PREDEFINED_GRADERS.expectedBehaviors);
    const latency = catalogEntry(PREDEFINED_GRADERS.latency);
    const expectedCopy = await useLibraryEntry(auth, {
      libraryId: expected.id,
    });
    const latencyCopy = await useLibraryEntry(auth, {
      libraryId: latency.id,
      params: { metric: "turn_response_latency", bound: 2_000 },
    });

    expect(expectedCopy.definition.type).toBe("llm_as_judge");
    expect(expectedCopy.judgeModel).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(latencyCopy.definition.type).toBe("code");
    expect(latencyCopy.judgeModel).toBeNull();

    await expect(
      seedGraderLibrary([
        {
          ...expected,
          type: "code",
          prompt: null,
          outputDefinition: null,
        },
      ]),
    ).rejects.toThrow(/different execution kind needs a new Library identity/u);

    const incompatible: PredefinedGrader = {
      ...latency,
      params: [
        ...latency.params,
        {
          name: "window",
          label: "Window",
          kind: "number",
          means: "the extra required value this active copy does not contain",
        },
      ],
    };
    await expect(seedGraderLibrary([incompatible])).rejects.toThrow(
      /without an explicit config migration/u,
    );
    expect((await getGrader(auth, latencyCopy.id))?.versionId).toBe(
      latencyCopy.versionId,
    );

    const marker = "IMMUTABLE-PROMPT-REVISION-TWO";
    const improved: PredefinedGrader = {
      ...expected,
      prompt: `${expected.prompt ?? ""}\n${marker}`,
    };
    expect(await seedGraderLibrary([improved])).toEqual([
      { id: expected.id, name: expected.name, version: 2 },
    ]);

    const promoted = await getGrader(auth, expectedCopy.id);
    expect(promoted?.versionId).not.toBe(expectedCopy.versionId);
    expect(promoted?.definition).toMatchObject({
      libraryId: expected.id,
      libraryVersion: 2,
      prompt: improved.prompt,
    });
    expect(promoted?.config).toEqual(expectedCopy.config);
    expect(promoted?.judgeModel).toEqual(expectedCopy.judgeModel);

    const pinned = await getGraderVersion(auth, expectedCopy.versionId);
    expect(pinned?.definition).toMatchObject({
      libraryId: expected.id,
      libraryVersion: 1,
      prompt: expected.prompt,
    });

    const newCopy = await useLibraryEntry(auth, { libraryId: expected.id });
    expect(newCopy.definition.libraryVersion).toBe(2);
    expect(newCopy.definition.prompt).toBe(improved.prompt);
    expect(await seedGraderLibrary([improved])).toEqual([]);
    expect((await getGrader(auth, expectedCopy.id))?.versionId).toBe(
      promoted?.versionId,
    );

    await expect(
      database.sql(
        "update grader_library_version set prompt = 'mutated' where library_id = $1 and version = 1",
        [expected.id],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    await expect(
      database.sql(
        `update grader_version
            set config = '{"assertions":[{"changed":1}]}'::jsonb
          where id = $1`,
        [expectedCopy.versionId],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    await expect(
      database.sql("update grader_library set type = 'code' where id = $1", [
        expected.id,
      ]),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );

    await expect(
      database.sql(
        `insert into grader_version
           (id, grader_id, version, library_id, library_version, config, judge_model)
         values ($1, $2, 99, $3, 1, '{"assertions":[]}'::jsonb, null)`,
        [newId("grv"), expectedCopy.id, latency.id],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

function catalogEntry(id: string): PredefinedGrader {
  const entry = GRADER_LIBRARY_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`missing catalog entry ${id}`);
  return entry;
}
