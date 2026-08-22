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
  it("contains one unique definition for each of the 75 current operations", () => {
    const operations = Object.values(platformOperations);
    expect(operations).toHaveLength(75);
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(
      operations.length,
    );
    expect(new Set(operations.map((operation) => `${operation.method} ${operation.path}`)).size)
      .toBe(operations.length);
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
