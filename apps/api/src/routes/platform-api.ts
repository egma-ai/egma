import type { Fetch as RetellFetch } from "@egma/retell";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { EmailSender } from "../auth/email.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { Config } from "../config.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import type { RetellReach } from "../retell/api.ts";
import { agentRoutes } from "./agents.ts";
import { apiKeyRoutes } from "./api-keys.ts";
import { graderLibraryRoutes } from "./grader-library.ts";
import { graderRoutes } from "./graders.ts";
import { memberRoutes } from "./members.ts";
import { mockToolRoutes } from "./mock-tools.ts";
import { monitoringRoutes } from "./monitoring.ts";
import { organizationRoutes } from "./organization.ts";
import { personaRoutes } from "./personas.ts";
import { projectRoutes } from "./projects.ts";
import { recordingRoutes } from "./recordings.ts";
import { repositoryRoutes } from "./repository.ts";
import { runRoutes } from "./runs.ts";
import { simulationRoutes } from "./simulations.ts";
import { testSuiteRoutes } from "./test-suites.ts";
import { testRoutes } from "./tests.ts";
import { traceReadRoutes } from "./trace-reads.ts";

export type PlatformApiRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  readonly emailSender: EmailSender;
  readonly baseUrl: string;
  readonly carrierRoute: Config["carrierRoute"];
  readonly blob: Config["blob"];
  readonly retellFetch?: RetellFetch | undefined;
  readonly retellReach?: RetellReach | undefined;
};

type ValidationIssue = {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
  readonly params?: unknown;
};

function requestPart(issue: ValidationIssue): string {
  return issue.instancePath === undefined || issue.instancePath === ""
    ? "the request"
    : `the request field ${issue.instancePath}`;
}

function validationMessage(request: FastifyRequest, issues: readonly ValidationIssue[]): string {
  const issue = issues[0];
  if (issue === undefined) {
    return `${request.method} ${request.routeOptions.url} has an invalid request.`;
  }
  return `${requestPart(issue)} ${issue.message ?? "is invalid"}.`;
}

/**
 * The one customer-facing platform API boundary.
 *
 * Every group below is included in the explicit platform contract. Account
 * flows, simulator work, OTLP, and health are registered
 * beside this plugin in the server and cannot enter the OpenAPI document by
 * sharing a path prefix.
 */
export async function platformApiRoutes(
  app: FastifyInstance,
  options: PlatformApiRoutesOptions,
): Promise<void> {
  app.setErrorHandler(async (error, request, reply) => {
    const issues = (error as { validation?: readonly ValidationIssue[] }).validation;
    if (issues !== undefined) {
      return reply.code(400).send({
        error: "invalid_request",
        message: validationMessage(request, issues),
        details: { issues },
      });
    }
    throw error;
  });

  const credentialed = {
    provider: options.provider,
    rateLimit: options.rateLimit,
  } as const;

  void app.register(apiKeyRoutes, credentialed);
  void app.register(agentRoutes, {
    ...credentialed,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
  });
  void app.register(monitoringRoutes, {
    ...credentialed,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
    ...(options.retellReach === undefined
      ? {}
      : { retellReach: options.retellReach }),
  });
  void app.register(memberRoutes, {
    ...credentialed,
    emailSender: options.emailSender,
    baseUrl: options.baseUrl,
  });
  void app.register(organizationRoutes, credentialed);
  void app.register(projectRoutes, credentialed);
  void app.register(personaRoutes, credentialed);
  void app.register(testSuiteRoutes, credentialed);
  void app.register(testRoutes, credentialed);
  void app.register(repositoryRoutes, credentialed);
  void app.register(graderLibraryRoutes, credentialed);
  void app.register(graderRoutes, credentialed);
  void app.register(mockToolRoutes, credentialed);
  void app.register(runRoutes, {
    ...credentialed,
    baseUrl: options.baseUrl,
    carrierRoute: options.carrierRoute,
    // The one Retell seam the run start needs, for everything it reads or
    // writes at creation: the version-pinning run-start read both Retell lanes
    // do, and the mocked-world build a web-call connection with the switch on
    // does after it. Same test seam the two provider groups above take.
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
  });
  void app.register(simulationRoutes, credentialed);
  void app.register(recordingRoutes, { ...credentialed, blob: options.blob });
  void app.register(traceReadRoutes, credentialed);
}
