import { defineOperation } from "../definition.ts";
import {
  dateTimeSchema,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const simulationParams = parameters({ simulationId: stringIdSchema }, [
  "simulationId",
]);

export const recordingOperations = {
  getSimulationRecording: defineOperation({
    operationId: "getSimulationRecording",
    method: "GET",
    path: "/v1/simulations/{simulationId}/recording",
    summary: "Get a simulation recording link",
    tag: "Recordings",
    security: "credentialed",
    request: {
      params: simulationParams,
      query: parameters({ projectId: stringIdSchema }),
    },
    responses: {
      200: {
        description: "A short-lived link to the recording.",
        schema: {
          type: "object",
          properties: {
            simulationId: stringIdSchema,
            url: { type: "string", format: "uri" },
            expiresAt: dateTimeSchema,
          },
          required: ["simulationId", "url", "expiresAt"],
          additionalProperties: false,
        },
      },
      400: refusalResponse,
      401: refusalResponse,
      403: refusalResponse,
      404: refusalResponse,
      422: refusalResponse,
      429: rateLimitResponse,
      503: refusalResponse,
    },
  }),
} as const;
