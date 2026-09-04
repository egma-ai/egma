import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createClient,
  listAgents,
  type CreateTestData,
  type DeleteTestData,
} from "@egma/platform-api/client";
import { platformOperations } from "../src/contract/index.ts";
import { buildPlatformOpenApi } from "../src/openapi.ts";

function operationKeys(): readonly string[] {
  return Object.values(platformOperations)
    .map((operation) => `${operation.method} ${operation.path} ${operation.operationId}`)
    .sort();
}

function openApiKeys(): readonly string[] {
  const document = buildPlatformOpenApi();
  return Object.entries(document.paths)
    .flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, operation]) =>
          `${method.toUpperCase()} ${path} ${String(operation.operationId)}`,
      ),
    )
    .sort();
}

function visit(
  value: unknown,
  at: readonly string[],
  read: (value: Readonly<Record<string, unknown>>, at: readonly string[]) => void,
): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, [...at, String(index)], read));
    return;
  }
  const object = value as Readonly<Record<string, unknown>>;
  read(object, at);
  for (const [key, nested] of Object.entries(object)) {
    visit(nested, [...at, key], read);
  }
}

function pointerIn(document: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) =>
      typeof value === "object" && value !== null && part in value
        ? (value as Readonly<Record<string, unknown>>)[part]
        : undefined, document);
}

describe("the platform API operation registry", () => {
  it("contains one unique definition for each of the 72 current operations", () => {
    const operations = Object.values(platformOperations);
    expect(operations).toHaveLength(72);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(
      operations.length,
    );
    expect(new Set(operations.map((operation) => `${operation.method} ${operation.path}`)).size)
      .toBe(operations.length);
  });

  it("lets a LiveKit agent reserve one active worker key inside one project", () => {
    const guarded = platformOperations.createApiKey.request.body.oneOf[1];
    expect(guarded).toMatchObject({
      properties: {
        monitoringAgentId: {
          type: "string",
          minLength: 1,
          description: expect.stringContaining("server"),
        },
      },
      required: ["name", "projectId", "monitoringAgentId"],
    });
    expect(platformOperations.createApiKey.responses).toHaveProperty("409");
  });

  it("activates library definitions instead of creating project-owned copies", () => {
    expect(platformOperations).not.toHaveProperty("createGrader");
    expect(platformOperations).not.toHaveProperty("deleteGrader");
    expect(operationKeys()).not.toContain("POST /v1/graders createGrader");
    expect(operationKeys()).toContain(
      "POST /v1/grader-library/{graderDefinitionId}/use useGraderInProject",
    );
    expect(operationKeys()).toContain(
      "DELETE /v1/graders/{graderId} removeGrader",
    );
    expect(operationKeys()).not.toContain(
      "POST /v1/grader-library authorPredefinedGrader",
    );
    expect(
      platformOperations.createCustomGrader.request.body.properties,
    ).not.toHaveProperty("type");
    expect(
      platformOperations.createCustomGrader.request.body.properties,
    ).not.toHaveProperty("sourceCode");
  });

  it("gives every test its own mock tools and env, and keeps no project set", () => {
    const test = platformOperations.getTest.responses[200].schema;
    const version = platformOperations.getTestVersion.responses[200].schema;
    const changeSetTest =
      platformOperations.applyRepositoryChangeSet.request.body.properties.tests
        .items;

    for (const shape of [test, version, changeSetTest] as const) {
      expect(shape.properties).toHaveProperty("mockTools");
      expect(shape.properties).toHaveProperty("env");
      expect(shape.properties).not.toHaveProperty("overrideCount");
      expect(shape.required).toContain("mockTools");
      expect(shape.required).toContain("env");
    }

    expect(test.properties.mockTools.items).toEqual({
      oneOf: [
        {
          type: "object",
          properties: {
            tool: { type: "string" },
            answer: {},
            error: { not: {} },
          },
          required: ["tool", "answer"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            tool: { type: "string" },
            answer: { not: {} },
            error: { type: "string" },
          },
          required: ["tool", "error"],
          additionalProperties: false,
        },
      ],
    });
    expect(test.properties.env).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            retell_dynamic_variables: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            job_dispatch_metadata: {
              type: "object",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });

    for (const gone of [
      "listMockTools",
      "createMockTool",
      "updateMockTool",
      "deleteMockTool",
      "discoverMockTools",
    ] as const) {
      expect(platformOperations).not.toHaveProperty(gone);
    }
    expect(
      platformOperations.applyRepositoryChangeSet.request.body.properties,
    ).not.toHaveProperty("mockTools");
    expect(
      platformOperations.getConnection.responses[200].schema.properties
        .connection.properties,
    ).not.toHaveProperty("mockToolsEnabled");
    expect(
      platformOperations.getRun.responses[200].schema.properties,
    ).not.toHaveProperty("mockToolsEnabled");
    for (const field of ["mockToolCoverage", "mockTools"] as const) {
      expect(
        platformOperations.getSimulation.responses[200].schema.properties,
      ).not.toHaveProperty(field);
    }
  });

  it("requires the version and identity revision a Test deletion was based on", () => {
    expect(platformOperations.deleteTest.request.query).toMatchObject({
      properties: {
        projectId: { type: "string", minLength: 1 },
        expectedVersionId: { type: "string", minLength: 1 },
        expectedRevision: { type: "string", minLength: 1 },
      },
      required: ["expectedVersionId", "expectedRevision"],
    });
    expect(platformOperations.deleteTest.responses[409]).toEqual(
      platformOperations.updateTest.responses[409],
    );
  });

  it("lets a customer change one project grader's policy", () => {
    expect(platformOperations.updateGrader.request.body).toEqual({
      type: "object",
      properties: {
        scope:
          platformOperations.listGraders.responses[200].schema.properties.graders
            .items.properties.scope,
        settings: { type: "object", additionalProperties: true },
        passThreshold: { type: "number", minimum: 0, maximum: 1 },
      },
      minProperties: 1,
      additionalProperties: false,
    });
  });

  it("describes one project's policy without copying executable grader settings", () => {
    const grader = platformOperations.listGraders.responses[200].schema.properties
      .graders.items;

    expect(Object.keys(grader.properties).sort()).toEqual(
      [
        "createdAt",
        "description",
        "graderDefinitionId",
        "id",
        "modalities",
        "name",
        "owner",
        "passThreshold",
        "projectId",
        "removable",
        "scope",
        "scopeEditable",
        "settings",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(grader.properties.scope).toEqual({
      type: "object",
      properties: {
        simulations: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { type: "string", enum: ["all"] } },
                required: ["kind"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["test_suite"] },
                  id: { type: "string", minLength: 1 },
                },
                required: ["kind", "id"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["test"] },
                  id: { type: "string", minLength: 1 },
                },
                required: ["kind", "id"],
                additionalProperties: false,
              },
            ],
          },
        },
        production: {
          anyOf: [
            {
              type: "object",
              properties: {
                samplePercent: { type: "number", minimum: 1, maximum: 100 },
              },
              required: ["samplePercent"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
      required: ["simulations", "production"],
      additionalProperties: false,
    });
  });

  it("lists stable definitions with details and current-project use state", () => {
    const definition =
      platformOperations.listGraderLibrary.responses[200].schema.properties
        .graderLibraryEntries.items;

    expect(Object.keys(definition.properties).sort()).toEqual(
      [
        "createdAt",
        "currentDefinitionVersion",
        "definitionVersion",
        "description",
        "activeProjectGraderId",
        "gradingInstructions",
        "id",
        "modalities",
        "name",
        "owner",
        "requiredEvidence",
        "scopeEditable",
        "settingDefinitions",
        "type",
        "updatedAt",
      ].sort(),
    );
    expect(definition.properties).not.toHaveProperty("params");
    expect(definition.properties).not.toHaveProperty("outputDefinition");
    expect(definition.properties).not.toHaveProperty("prompt");
    expect(definition.properties.type.enum).toEqual(["llm_as_judge", "code"]);
    expect(definition.properties.settingDefinitions.items.properties.valueType)
      .toEqual({ type: "string", enum: ["integer"] });
    expect(
      platformOperations.getGraderLibraryEntry.request.query.properties,
    ).toEqual({
      projectId: { type: "string", minLength: 1 },
      definitionVersion: { type: "integer", minimum: 1 },
    });
  });

  it("generates exactly the same method, path, and operation ID set", () => {
    expect(openApiKeys()).toEqual(operationKeys());
  });

  it("keeps account, worker, OTLP, settings, and health protocols out", () => {
    const included = new Set(
      Object.values(platformOperations).map(
        (operation) => `${operation.method} ${operation.path}`,
      ),
    );

    expect([...included].every((operation) => operation.includes(" /v1/"))).toBe(
      true,
    );
    expect(included).not.toContain("POST /v1/claims");
    expect(included).not.toContain(
      "POST /v1/simulations/{simulationId}/heartbeats",
    );
    expect(included).not.toContain(
      "POST /v1/simulations/{simulationId}/reports",
    );
    expect(included).not.toContain("POST /v1/traces");
    expect([...included].some((operation) => operation.includes(" /api/"))).toBe(
      false,
    );
  });

  it("emits only resolvable local schema references", () => {
    const document = buildPlatformOpenApi();
    const missing: string[] = [];
    visit(document, [], (value, at) => {
      const reference = value.$ref;
      if (typeof reference === "string" && pointerIn(document, reference) === undefined) {
        missing.push(`${at.join(".")}: ${reference}`);
      }
    });
    expect(missing).toEqual([]);
  });

  it("uses lowerCamelCase for structural JSON and parameter names", () => {
    const document = buildPlatformOpenApi();
    const underscored = new Set<string>();
    visit(document.paths, [], (value) => {
      const properties = value.properties;
      if (typeof properties === "object" && properties !== null) {
        for (const name of Object.keys(properties)) {
          if (name.includes("_")) underscored.add(name);
        }
      }
      const name = value.name;
      if (typeof name === "string" && name.includes("_")) underscored.add(name);
    });

    /*
     * The two env keys are the platforms' own words — Retell calls them
     * `retell_dynamic_variables` and LiveKit calls its blob
     * `job_dispatch_metadata` — so a reader who knows either platform reads a
     * test's env without a translation table. They are the only underscored
     * names on the wire.
     */
    expect([...underscored].sort()).toEqual([
      "job_dispatch_metadata",
      "retell_dynamic_variables",
    ]);
  });

  it("uses one grade shape for simulation and production trace reads", () => {
    const simulation = platformOperations.getSimulation.responses[200].schema as {
      readonly properties: Readonly<Record<string, unknown>>;
    };
    const trace = platformOperations.getTrace.responses[200].schema as {
      readonly properties: Readonly<Record<string, unknown>>;
    };

    for (const field of ["grades", "gradeHistory", "combinedScore"] as const) {
      expect(simulation.properties[field]).toEqual(trace.properties[field]);
    }
    expect(simulation.properties.gradingState).toEqual({
      anyOf: [
        {
          type: "string",
          enum: ["not_requested", "pending", "running", "complete", "error"],
        },
        { type: "null" },
      ],
    });
    expect(trace.properties.gradingState).toEqual({
      type: "string",
      enum: ["not_requested", "pending", "running", "complete", "error"],
    });
    expect(simulation.properties.combinedScore).toEqual({
      anyOf: [
        { type: "number", minimum: 0, maximum: 1 },
        { type: "null" },
      ],
    });

    const grades = simulation.properties.grades as {
      readonly items: {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
    };
    expect(Object.keys(grades.items.properties).sort()).toEqual(
      [
        "details",
        "gradedAt",
        "graderDefinitionId",
        "graderDefinitionVersion",
        "graderName",
        "passThreshold",
        "projectGraderId",
        "result",
        "score",
      ].sort(),
    );
    expect(grades.items.required).toEqual([
      "projectGraderId",
      "graderDefinitionId",
      "graderDefinitionVersion",
      "graderName",
      "score",
      "details",
      "passThreshold",
      "result",
      "gradedAt",
    ]);
    expect(grades.items.properties.score).toEqual({
      anyOf: [
        { type: "number", minimum: 0, maximum: 1 },
        { type: "null" },
      ],
    });
    expect(grades.items.properties.result).toEqual({
      type: "string",
      enum: ["passed", "failed", "errored"],
    });
    expect(grades.items.properties.details).toEqual({
      type: "object",
      properties: {
        rationale: { type: "string" },
        assertions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              score: { type: "number", minimum: 0, maximum: 1 },
              rationale: { type: "string" },
              citedSpanIds: { type: "array", items: { type: "string" } },
              error: { type: "string" },
            },
            required: ["key"],
            additionalProperties: false,
          },
        },
        error: { type: "string" },
      },
      additionalProperties: true,
    });
  });

  it("freezes shared grader identity, version and threshold in a simulation plan", () => {
    const simulation = platformOperations.getSimulation.responses[200].schema;
    const gradingPlan = simulation.properties.gradingPlan.anyOf[0];
    const item = gradingPlan.properties.items.items;

    expect(Object.keys(item.properties)).toEqual([
      "projectGraderId",
      "graderDefinitionId",
      "graderDefinitionVersion",
      "graderName",
      "passThreshold",
    ]);
    expect(item.required).toEqual(Object.keys(item.properties));
  });

  it("keeps run reads about execution and grading progress, not quality", () => {
    const listRuns = platformOperations.listRuns;
    const run = listRuns.responses[200].schema.properties.runs.items;
    const runDetail = platformOperations.getRun.responses[200].schema;
    const simulation = platformOperations.listRunSimulations.responses[200].schema
      .properties.simulations.items;
    const simulationEvent = platformOperations.listRunEvents.responses[200].schema
      .properties.events.items.oneOf[1];

    expect(listRuns.request.query.properties).not.toHaveProperty("verdict");
    for (const field of ["verdict", "score", "verdictCounts"] as const) {
      expect(run.properties).not.toHaveProperty(field);
    }
    expect(runDetail.properties).not.toHaveProperty("counts");
    for (const field of ["grading", "verdict", "score", "counts"] as const) {
      expect(simulation.properties).not.toHaveProperty(field);
    }
    expect(simulation.properties.gradingState).toEqual({
      anyOf: [
        {
          type: "string",
          enum: ["not_requested", "pending", "running", "complete", "error"],
        },
        { type: "null" },
      ],
    });
    expect(simulation.properties.combinedScore).toEqual({
      anyOf: [
        { type: "number", minimum: 0, maximum: 1 },
        { type: "null" },
      ],
    });
    expect(simulation.properties.startedAt).toEqual({
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    });
    expect(simulation.properties.endedAt).toEqual({
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    });
    expect(simulationEvent.properties).not.toHaveProperty("verdict");
  });
});

describe("the generated platform client", () => {
  it("makes the expected Test Version and identity revision required for deletion", () => {
    expectTypeOf<DeleteTestData["query"]>().toEqualTypeOf<{
      projectId?: string;
      expectedVersionId: string;
      expectedRevision: string;
    }>();
  });

  it("makes a test mock tool's answer and error mutually exclusive", () => {
    type MockTool = NonNullable<CreateTestData["body"]["mockTools"]>[number];

    expectTypeOf<{ tool: string; answer: unknown; error: string }>()
      .not.toExtend<MockTool>();
    expectTypeOf<{ tool: string }>().not.toExtend<MockTool>();
    expectTypeOf<{ tool: string; answer: unknown }>().toExtend<MockTool>();
    expectTypeOf<{ tool: string; error: string }>().toExtend<MockTool>();
    expectTypeOf<MockTool>().not.toHaveProperty("delayMs");
  });

  it("uses a scalar API key only as a bearer credential", async () => {
    let sent: Request | undefined;
    const client = createClient({
      baseUrl: "https://platform.example",
      auth: "egma_sk_example",
      fetch: async (request) => {
        sent = request instanceof Request ? request : new Request(request);
        return new Response(JSON.stringify({ agents: [], nextPageToken: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await listAgents({}, { client });

    expect(sent?.headers.get("authorization")).toBe("Bearer egma_sk_example");
    expect(sent?.headers.get("cookie")).toBeNull();
  });
});
