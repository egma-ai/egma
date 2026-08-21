import {
  isOperationBodyRequired,
  platformOperations,
  refusalSchema,
  type JsonSchema,
  type ParameterSchema,
  type PlatformOperation,
  type PlatformOperationMap,
} from "./contract/index.ts";

type OpenApiParameter = {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: JsonSchema;
};

type OpenApiOperation = Readonly<Record<string, unknown>>;
type OpenApiPath = Partial<Record<Lowercase<PlatformOperation["method"]>, OpenApiOperation>>;
type ComponentSchemas = Record<string, JsonSchema>;

function openApiSchema(
  schema: JsonSchema,
  components: ComponentSchemas,
): JsonSchema {
  if (typeof schema === "boolean") return schema;
  if (schema === refusalSchema) {
    return { $ref: "#/components/schemas/Refusal" };
  }

  const definitions = schema.$defs;
  if (
    definitions !== undefined &&
    typeof definitions === "object" &&
    definitions !== null &&
    !Array.isArray(definitions)
  ) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (
        typeof definition !== "boolean" &&
        (typeof definition !== "object" || definition === null)
      ) {
        continue;
      }
      const rendered = openApiSchema(definition as JsonSchema, components);
      const existing = components[name];
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(rendered)
      ) {
        throw new Error(`conflicting platform schema definition: ${name}`);
      }
      components[name] = rendered;
    }
  }

  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (key === "$defs") return [];
      if (
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/$defs/")
      ) {
        return [[key, `#/components/schemas/${value.slice("#/$defs/".length)}`]];
      }
      if (Array.isArray(value)) {
        return [[
          key,
          value.map((entry) =>
            typeof entry === "object" && entry !== null
              ? openApiSchema(entry as JsonSchema, components)
              : entry,
          ),
        ]];
      }
      if (typeof value === "object" && value !== null) {
        return [[key, openApiSchema(value as JsonSchema, components)]];
      }
      return [[key, value]];
    }),
  );
}

function parametersFrom(
  location: "path" | "query",
  schema: ParameterSchema | undefined,
  components: ComponentSchemas,
): readonly OpenApiParameter[] {
  if (schema === undefined) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, value]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: openApiSchema(value, components),
  }));
}

function responseObject(
  response: PlatformOperation["responses"][number],
  components: ComponentSchemas,
) {
  return {
    description: response.description,
    ...(response.headers === undefined ? {} : { headers: response.headers }),
    ...(response.schema === undefined
      ? {}
      : {
          content: {
            "application/json": {
              schema: openApiSchema(response.schema, components),
            },
          },
        }),
  };
}

function operationObject(
  operation: PlatformOperation,
  components: ComponentSchemas,
): OpenApiOperation {
  const request = operation.request;
  const routeParameters = [
    ...parametersFrom("path", request?.params, components),
    ...parametersFrom("query", request?.query, components),
  ];
  const responses = Object.fromEntries(
    Object.entries(operation.responses).map(([status, response]) => [
      status,
      responseObject(response, components),
    ]),
  );

  return {
    operationId: operation.operationId,
    summary: operation.summary,
    ...(operation.description === undefined
      ? {}
      : { description: operation.description }),
    tags: [operation.tag],
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
    ...(routeParameters.length === 0 ? {} : { parameters: routeParameters }),
    ...(request?.body === undefined
      ? {}
      : {
          requestBody: {
            required: isOperationBodyRequired(request),
            content: {
              "application/json": {
                schema: openApiSchema(request.body, components),
              },
            },
          },
        }),
    responses,
  };
}

export function buildPlatformOpenApi(
  operations: PlatformOperationMap = platformOperations,
) {
  const paths: Record<string, OpenApiPath> = {};
  const componentSchemas: ComponentSchemas = {
    Refusal: refusalSchema,
  };
  for (const operation of Object.values(operations)) {
    const method = operation.method.toLowerCase() as Lowercase<
      PlatformOperation["method"]
    >;
    const path = (paths[operation.path] ??= {});
    if (path[method] !== undefined) {
      throw new Error(`duplicate platform operation: ${operation.method} ${operation.path}`);
    }
    path[method] = operationObject(operation, componentSchemas);
  }

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Egma Platform API",
      version: "1.0.0",
      description:
        "The customer-facing HTTP interface used by Egma's web app, CLI, and outside clients.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An Egma API key.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "egma.session_token",
          description:
            "The browser session cookie issued by Egma. HTTPS deployments add the standard __Secure- prefix.",
        },
      },
      schemas: componentSchemas,
    },
  } as const;
}

export const platformOpenApi = buildPlatformOpenApi();
