/** A JSON Schema value accepted by Fastify and OpenAPI 3.1. */
export type JsonSchema = boolean | Readonly<Record<string, unknown>>;

/** An object schema used for path and query parameters. */
export type ParameterSchema = JsonSchema & {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type PlatformSecurity = "credentialed";

export type OperationRequest = {
  readonly params?: ParameterSchema;
  readonly query?: ParameterSchema;
  readonly body?: JsonSchema;
  readonly bodyRequired?: boolean;
};

/** Use one body-required rule for OpenAPI and every server adapter. */
export function isOperationBodyRequired(
  request: OperationRequest | undefined,
): boolean {
  if (request?.bodyRequired !== undefined) return request.bodyRequired;

  const body = request?.body;
  if (typeof body !== "object" || body === null) return false;

  return Array.isArray(body.required) && body.required.length > 0;
}

export type OperationResponse = {
  readonly description: string;
  readonly schema?: JsonSchema;
  readonly headers?: Readonly<Record<string, JsonSchema>>;
};

/**
 * One executable platform operation.
 *
 * The path uses OpenAPI parameter syntax (`{agentId}`). The Fastify adapter is
 * responsible for converting it to its own `:agentId` syntax.
 */
export type PlatformOperation = {
  readonly operationId: string;
  readonly method: HttpMethod;
  readonly path: `/v1/${string}`;
  readonly summary: string;
  readonly description?: string;
  readonly tag: string;
  readonly security: PlatformSecurity;
  readonly request?: OperationRequest;
  readonly responses: Readonly<
    Record<number, OperationResponse> & { readonly default?: OperationResponse }
  >;
};

export function defineOperation<const Operation extends PlatformOperation>(
  operation: Operation,
): Operation {
  return operation;
}

export type PlatformOperationMap = Readonly<Record<string, PlatformOperation>>;
