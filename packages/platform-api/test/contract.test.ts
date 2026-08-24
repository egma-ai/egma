import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createClient,
  listAgents,
  type CreateMockToolData,
  type UpdateMockToolData,
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
  it("contains one unique definition for each of the 78 current operations", () => {
    const operations = Object.values(platformOperations);
    expect(operations).toHaveLength(78);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(
      operations.length,
    );
    expect(new Set(operations.map((operation) => `${operation.method} ${operation.path}`)).size)
      .toBe(operations.length);
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

    expect([...underscored].sort()).toEqual([]);
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
    expect(simulationEvent.properties).not.toHaveProperty("verdict");
  });
});

describe("the generated platform client", () => {
  it("makes a mock-tool answer and error mutually exclusive", () => {
    type Both = { tool: string; answer: unknown; error: string };
    type CreateBody = CreateMockToolData["body"];
    type UpdateBody = NonNullable<UpdateMockToolData["body"]>;

    expectTypeOf<Both>().not.toExtend<CreateBody>();
    expectTypeOf<Both>().not.toExtend<UpdateBody>();
    expectTypeOf<{ tool: string; answer: unknown }>().toExtend<CreateBody>();
    expectTypeOf<{ tool?: string }>().toExtend<UpdateBody>();
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
