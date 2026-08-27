import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../src/client.ts";
import {
  archiveProjectGrader,
  createCustomLlmGrader,
  editProjectGrader,
  getExecutableGraderDefinition,
  getProjectGrader,
  listProjectGraders,
  useGraderInProject,
} from "../src/access/graders.ts";
import {
  getGraderDefinitionVersion,
  getGraderLibraryEntry,
  listGraderLibrary,
  reconcileGraderCatalog,
} from "../src/access/grader-library.ts";
import { createProject } from "../src/access/projects.ts";
import { provisionOrganization } from "../src/access/provisioning.ts";
import {
  GRADER_DEFINITION_CATALOG,
  MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
} from "../src/grader-library/catalog.ts";
import type { AuthContext } from "../src/access/context.ts";
import {
  createConnectedDatabase,
  openSingleConnection,
  type MigratedDatabase,
} from "./support/database.ts";

describe("shared definitions and project grader policy", () => {
  let database: MigratedDatabase;
  const ownerId = newId("usr");
  let auth: AuthContext;
  let expectedProjectGraderId: string;

  beforeAll(async () => {
    database = await createConnectedDatabase("project_graders");
    await database.sql(
      `insert into "user" (id, email) values ($1, 'owner@example.test')`,
      [ownerId],
    );
    const created = await provisionOrganization({
      ownerUserId: ownerId,
      organizationName: "Acme",
      organizationSlug: "acme",
      projectName: "Main",
      projectSlug: "main",
    });
    auth = {
      userId: ownerId,
      organizationId: created.organizationId,
      projectId: created.projectId,
      role: "admin",
      via: "session",
    };
    const { rows } = await database.sql<{ id: string }>(
      `select id from project_grader where project_id = $1`,
      [created.projectId],
    );
    expectedProjectGraderId = rows[0]?.id ?? "";
  });

  afterAll(async () => database.drop());

  it("creates exactly one fixed-scope Expected behaviors row with the project", async () => {
    const grader = await getProjectGrader(auth, expectedProjectGraderId);
    expect(grader).toMatchObject({
      scopeEditable: false,
      scope: {
        simulations: [{ kind: "all" }],
        production: null,
      },
      passThreshold: 1,
      currentDefinitionVersion: 1,
    });
  });

  it("lets a customer change the pass threshold but not Expected behaviors scope or presence", async () => {
    const edited = await editProjectGrader(auth, expectedProjectGraderId, {
      passThreshold: 0.8,
    });
    expect(edited?.passThreshold).toBe(0.8);

    await expect(
      editProjectGrader(auth, expectedProjectGraderId, {
        scope: { simulations: [], production: null },
      }),
    ).rejects.toThrow("managed by Egma");
    await expect(
      archiveProjectGrader(auth, expectedProjectGraderId),
    ).rejects.toThrow("cannot be removed");
  });

  it("offers Response latency inactive, then validates, edits, and removes its project policy", async () => {
    const library = await listGraderLibrary(auth);
    expect(library.map(({ id }) => id)).toEqual(expect.arrayContaining([
      PREDEFINED_GRADERS.expectedBehaviors,
      PREDEFINED_GRADERS.responseLatency,
    ]));
    const responseLatency = await getGraderLibraryEntry(
      auth,
      PREDEFINED_GRADERS.responseLatency,
    );
    expect(responseLatency).toMatchObject({
      name: "Response latency",
      owner: "egma",
      type: "code",
      scopeEditable: true,
      activeProjectGraderId: null,
      parameterContract: [{
        key: MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
        defaultValue: 3_000,
        minimum: 1,
        maximum: null,
      }],
    });

    await expect(useGraderInProject(auth, responseLatency?.id ?? "missing", {
      scope: { simulations: [{ kind: "all" }], production: null },
      parameterValues: {},
      passThreshold: 1,
    })).rejects.toThrow(`need values for ${MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER}`);

    const active = await useGraderInProject(
      auth,
      PREDEFINED_GRADERS.responseLatency,
      {
        scope: { simulations: [{ kind: "all" }], production: null },
        parameterValues: {
          [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_500,
        },
        passThreshold: 1,
      },
    );
    expect(active).toMatchObject({
      type: "code",
      owner: "egma",
      parameterValues: {
        [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_500,
      },
      passThreshold: 1,
    });
    await expect(useGraderInProject(
      auth,
      PREDEFINED_GRADERS.responseLatency,
      {
        scope: { simulations: [], production: null },
        parameterValues: {
          [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 3_000,
        },
        passThreshold: 1,
      },
    )).rejects.toThrow("already active");

    const edited = await editProjectGrader(auth, active?.id ?? "missing", {
      scope: { simulations: [], production: null },
      parameterValues: {
        [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_000,
      },
      passThreshold: 0.8,
    });
    expect(edited).toMatchObject({
      scope: { simulations: [], production: null },
      parameterValues: {
        [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_000,
      },
      passThreshold: 0.8,
    });
    await expect(archiveProjectGrader(auth, active?.id ?? "missing"))
      .resolves.toBe(true);
    await expect(getGraderLibraryEntry(
      auth,
      PREDEFINED_GRADERS.responseLatency,
    )).resolves.toMatchObject({ activeProjectGraderId: null });
  });

  it("creates one organization LLM definition and lets another project use it", async () => {
    const second = await createProject(auth, { name: "Second" });
    const secondAuth: AuthContext = { ...auth, projectId: second.id };
    expect(await listProjectGraders(secondAuth)).toHaveLength(1);

    const created = await createCustomLlmGrader(auth, {
      name: "Policy compliance",
      description: "Grades one policy instruction.",
      gradingInstructions: "The agent must state the cancellation policy.",
      modalities: ["chat", "voice"],
      scope: { simulations: [{ kind: "all" }], production: null },
      passThreshold: 1,
    });
    expect(created.definition).toMatchObject({
      owner: "organization",
      type: "llm_as_judge",
      gradingInstructions: "The agent must state the cancellation policy.",
      parameterContract: [],
      activeProjectGraderId: created.projectGrader.id,
    });
    expect(created.projectGrader).toMatchObject({
      owner: "organization",
      type: "llm_as_judge",
      parameterValues: {},
    });

    await expect(getGraderLibraryEntry(secondAuth, created.definition.id))
      .resolves.toMatchObject({
        owner: "organization",
        activeProjectGraderId: null,
      });
    const secondUse = await useGraderInProject(
      secondAuth,
      created.definition.id,
      {
        scope: { simulations: [], production: { sample_percent: 100 } },
        parameterValues: {},
        passThreshold: 0.9,
      },
    );
    expect(secondUse).toMatchObject({
      projectId: second.id,
      graderDefinitionId: created.definition.id,
      passThreshold: 0.9,
    });

    const otherOwnerId = newId("usr");
    await database.sql(
      `insert into "user" (id, email) values ($1, 'other@example.test')`,
      [otherOwnerId],
    );
    const other = await provisionOrganization({
      ownerUserId: otherOwnerId,
      organizationName: "Other",
      organizationSlug: "other-graders",
      projectName: "Main",
      projectSlug: "main",
    });
    const otherAuth: AuthContext = {
      userId: otherOwnerId,
      organizationId: other.organizationId,
      projectId: other.projectId,
      role: "admin",
      via: "session",
    };
    await expect(getGraderLibraryEntry(otherAuth, created.definition.id))
      .resolves.toBeUndefined();
    await expect(useGraderInProject(otherAuth, created.definition.id, {
      scope: { simulations: [], production: null },
      parameterValues: {},
      passThreshold: 1,
    })).resolves.toBeUndefined();
  });

  it("allows reads but refuses viewer project-grader writes", async () => {
    const viewer: AuthContext = { ...auth, role: "viewer" };
    await expect(listGraderLibrary(viewer)).resolves.toEqual(expect.any(Array));
    await expect(useGraderInProject(
      viewer,
      PREDEFINED_GRADERS.responseLatency,
      {
        scope: { simulations: [], production: null },
        parameterValues: {
          [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 3_000,
        },
        passThreshold: 1,
      },
    )).rejects.toThrow("may not author_definitions");
  });

  it("updates one shared definition version without copying it into projects", async () => {
    const entry = GRADER_DEFINITION_CATALOG[0];
    if (entry === undefined || entry.prompt === null) {
      throw new Error("the Expected behaviors catalog fixture is missing");
    }
    const changed = [{ ...entry, prompt: `${entry.prompt}\nOne catalog update.` }];

    expect((await reconcileGraderCatalog(changed)).definitions).toEqual([
      { id: entry.id, name: entry.name, version: 2 },
    ]);
    expect((await reconcileGraderCatalog(changed)).definitions).toEqual([]);

    const versions = await database.sql<{ version: number; prompt: string }>(
      `select version, prompt
         from grader_definition_version
        where definition_id = $1
        order by version`,
      [entry.id],
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2]);
    expect(versions.rows[0]?.prompt).toBe(entry.prompt);
    await expect(getGraderDefinitionVersion(auth, entry.id, 1)).resolves
      .toMatchObject({
        definitionId: entry.id,
        definitionVersion: 1,
        prompt: entry.prompt,
      });
    await expect(getGraderDefinitionVersion(auth, entry.id, 2)).resolves
      .toMatchObject({
        definitionId: entry.id,
        definitionVersion: 2,
        prompt: changed[0]?.prompt,
      });

    const rows = await database.sql<{ count: string }>(
      `select count(*) as count
         from project_grader
        where project_id = $1
          and grader_definition_id = $2
          and archived_at is null`,
      [auth.projectId, entry.id],
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
    expect((await getProjectGrader(auth, expectedProjectGraderId))?.currentDefinitionVersion).toBe(2);
  });

  it("validates editable scope IDs against the same active project", async () => {
    const definitionId = newId("grl");
    const projectGraderId = newId("grd");
    const suiteId = newId("ste");
    const testId = newId("tst");
    const testVersionId = newId("tstv");
    const otherProjectId = newId("prj");
    const otherSuiteId = newId("ste");
    const otherTestId = newId("tst");
    const otherTestVersionId = newId("tstv");

    const connection = await openSingleConnection(database.url);
    await connection.sql("begin");
    try {
      await connection.sql(
        `insert into grader_definition
           (id, organization_id, name, scope_editable, current_definition_version)
         values ($1, $2, 'Fixture', true, 1)`,
        [definitionId, auth.organizationId],
      );
      await connection.sql(
        `insert into grader_definition_version
           (definition_id, version, type, prompt, parameter_contract,
            output_contract, modalities, judge_model)
         values ($1, 1, 'llm_as_judge', 'Grade it', '[]'::jsonb, '{}'::jsonb,
                 '["chat"]'::jsonb,
                 '{"provider":"openai","model":"gpt-5"}'::jsonb)`,
        [definitionId],
      );
      await connection.sql(
        `insert into project_grader
           (id, organization_id, project_id, grader_definition_id, scope,
            parameter_values, pass_threshold)
         values ($1, $2, $3, $4,
                 '{"simulations":[],"production":null}'::jsonb,
                 '{}'::jsonb, 0.5)`,
        [projectGraderId, auth.organizationId, auth.projectId, definitionId],
      );
      await connection.sql(
        `insert into test_suite (id, organization_id, project_id, name)
         values ($1, $2, $3, 'Core')`,
        [suiteId, auth.organizationId, auth.projectId],
      );
      await connection.sql(
        `insert into test (id, organization_id, project_id, suite_id, name, current_version_id, revision)
         values ($1, $2, $3, $4, 'Refund', $5, $6)`,
        [testId, auth.organizationId, auth.projectId, suiteId, testVersionId, newId("rev")],
      );
      await connection.sql(
        `insert into test_version (id, test_id, version, content)
         values ($1, $2, 1, '{}'::jsonb)`,
        [testVersionId, testId],
      );
      await connection.sql(
        `insert into project (id, organization_id, name, slug, revision)
         values ($1, $2, 'Other', 'other', $3)`,
        [otherProjectId, auth.organizationId, newId("rev")],
      );
      await connection.sql(
        `insert into test_suite (id, organization_id, project_id, name)
         values ($1, $2, $3, 'Other')`,
        [otherSuiteId, auth.organizationId, otherProjectId],
      );
      await connection.sql(
        `insert into test (id, organization_id, project_id, suite_id, name, current_version_id, revision)
         values ($1, $2, $3, $4, 'Other', $5, $6)`,
        [otherTestId, auth.organizationId, otherProjectId, otherSuiteId, otherTestVersionId, newId("rev")],
      );
      await connection.sql(
        `insert into test_version (id, test_id, version, content)
         values ($1, $2, 1, '{}'::jsonb)`,
        [otherTestVersionId, otherTestId],
      );
      await connection.sql("commit");
    } catch (cause) {
      await connection.sql("rollback");
      throw cause;
    } finally {
      await connection.close();
    }

    expect(
      await getExecutableGraderDefinition(
        auth,
        db(),
        definitionId,
        1,
      ),
    ).toMatchObject({ definitionId, definitionVersion: 1 });

    const valid = await editProjectGrader(auth, projectGraderId, {
      scope: {
        simulations: [
          { kind: "test_suite", id: suiteId },
          { kind: "test", id: testId },
        ],
        production: { sample_percent: 25 },
      },
    });
    expect(valid?.scope.simulations).toHaveLength(2);

    await expect(
      editProjectGrader(auth, projectGraderId, {
        scope: {
          simulations: [{ kind: "test", id: otherTestId }],
          production: null,
        },
      }),
    ).rejects.toThrow("not active in this project");
  });
});
