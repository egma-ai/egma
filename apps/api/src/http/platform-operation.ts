import type {
  JsonSchema,
  ParameterSchema,
  PlatformOperation,
} from "@egma/platform-api/contract";
import type {
  FastifyInstance,
  FastifySchema,
  RouteHandlerMethod,
} from "fastify";

/** Convert an OpenAPI path template to Fastify's route syntax. */
export function fastifyPath(path: PlatformOperation["path"]): string {
  return path
    // find-my-way reads one colon as a parameter marker. Two mean one literal
    // colon, which keeps custom actions such as `agents:discover` static.
    .replaceAll(":", "::")
    // Convert OpenAPI parameters after escaping literals, so the parameter
    // marker introduced here remains one colon.
    .replaceAll(/\{([^}]+)\}/g, ":$1");
}

function responseSchemas(
  operation: PlatformOperation,
): Readonly<Record<string, JsonSchema>> {
  return Object.fromEntries(
    Object.entries(operation.responses).flatMap(([status, response]) =>
      response.schema === undefined ? [] : [[status, response.schema]],
    ),
  );
}

/**
 * Fastify sees query-string values before a route applies its existing parser.
 * Accept their text form here so the handler keeps the current range, enum,
 * and refusal behavior. OpenAPI still publishes the semantic value type.
 */
function fastifyQuerySchema(query: ParameterSchema): ParameterSchema {
  return {
    type: "object",
    additionalProperties: true,
    properties: Object.fromEntries(
      Object.entries(query.properties).map(([name, schema]) => [
        name,
        { anyOf: [schema, { type: "string" }] },
      ]),
    ),
    // Existing handlers own required-query checks and their actionable refusal
    // messages, just as they own request-body validation below. OpenAPI keeps
    // the required list from the unmodified operation schema.
  };
}

export function fastifySchema(operation: PlatformOperation): FastifySchema {
  const responses = responseSchemas(operation);
  return {
    ...(operation.request?.params === undefined
      ? {}
      : { params: operation.request.params }),
    ...(operation.request?.query === undefined
      ? {}
      : { querystring: fastifyQuerySchema(operation.request.query) }),
    // Current handlers own request-body validation and its actionable refusal
    // text. The contract still drives OpenAPI and client types; response
    // schemas are enforced here. Moving body validation into Fastify is a
    // separate behavior change and cannot be hidden inside this route cutover.
    ...(Object.keys(responses).length === 0 ? {} : { response: responses }),
  };
}

/** Bind one handler to the operation that also drives OpenAPI and the client. */
export function registerPlatformOperation(
  app: FastifyInstance,
  operation: PlatformOperation,
  handler: RouteHandlerMethod,
): void {
  app.route({
    method: operation.method,
    url: fastifyPath(operation.path),
    schema: fastifySchema(operation),
    handler,
  });
}
