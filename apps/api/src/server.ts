import { ping, pingClickHouse } from "@egma/db";
import Fastify, { type FastifyInstance } from "fastify";

import { createIdentity, type Identity } from "./auth/better-auth.ts";
import {
  loggingEmailSender,
  smtpEmailSender,
  type EmailSender,
} from "./auth/email.ts";
import { admitIdentity, onIdentityCreated } from "./auth/provisioning.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { deviceRoutes } from "./routes/device.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { memberRoutes } from "./routes/members.ts";
import { signOutRoutes } from "./routes/sign-out.ts";
import { signupRoutes } from "./routes/signup.ts";
import { testRoutes } from "./routes/tests.ts";
import { traceReadRoutes } from "./routes/trace-reads.ts";
import { traceRoutes } from "./routes/traces.ts";
import { fixedWindowRateLimit, type RateLimit } from "./http/rate-limit.ts";
import { webHandler } from "./http/web-handler.ts";
import type { Config } from "./config.ts";

/** Where the auth provider's own endpoints live, under the shared origin. */
export const AUTH_BASE_PATH = "/api/auth";

export type ServerOptions = {
  readonly config: Config;
  /**
   * Defaults to the transport that writes to the log and delivers nothing,
   * which is what a self-host with no SMTP configured runs. A test hands in one
   * that reports delivery to see the other branch.
   */
  readonly emailSender?: EmailSender;
  /**
   * Defaults to a fixed window over the configured per-minute budget. A test
   * hands in one with a tiny budget, or its own clock, rather than making the
   * suite wait out a window.
   */
  readonly rateLimit?: RateLimit;
};

export type Api = {
  readonly app: FastifyInstance;
  /**
   * The provider the server was built on, handed back rather than hidden: the
   * seam is what the rest of egma will ask for identities through, and a thing
   * nobody can reach is a thing nobody can test.
   */
  readonly identity: Identity;
};

export function buildApi(options: ServerOptions): Api {
  const { config } = options;

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Forwarded headers are believed only when somebody said there is a proxy
    // in front. Everything that reads the request's origin — the provider's
    // cookie attributes among them — reads what this resolves.
    trustProxy: config.trustProxy,
  });

  // Which transport this is decides two other things by itself — whether
  // signup waits for a verification click, and whether an invitation hands its
  // link back — so there is no second setting for either to disagree with.
  const emailSender =
    options.emailSender ??
    (config.smtp === undefined
      ? loggingEmailSender((email) => {
          app.log.info(
            { to: email.to, subject: email.subject, body: email.body },
            "no mail transport is configured, so this message was not sent",
          );
        })
      : smtpEmailSender(config.smtp));

  const identity = createIdentity({
    baseUrl: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    emailSender,
    log: (level, message, details) => {
      app.log[level]({ details }, message);
    },
    hooks: {
      admitIdentity: admitIdentity(config.singleOrganization),
      onIdentityCreated: onIdentityCreated(),
    },
  });

  // The container health check polls this every few seconds; logging each poll
  // would bury everything else in `docker compose logs`.
  /**
   * Both stores are answered for, and neither is optional: there is no second
   * analytical path behind ClickHouse, so an instance that cannot reach it is
   * not a degraded egma — it is one that would accept a trace and lose it. Both
   * are asked every time rather than stopping at the first failure, so a health
   * response says what is wrong rather than only that something is.
   */
  const reachability = async (
    store: string,
    reach: () => Promise<void>,
  ): Promise<"reachable" | "unreachable"> => {
    try {
      await reach();
      return "reachable";
    } catch (cause) {
      app.log.error({ err: cause }, `health check could not reach ${store}`);
      return "unreachable";
    }
  };

  app.get("/health", { logLevel: "warn" }, async (_request, reply) => {
    const [postgres, clickhouse] = await Promise.all([
      reachability("Postgres", ping),
      reachability("ClickHouse", pingClickHouse),
    ]);

    const healthy = postgres === "reachable" && clickhouse === "reachable";
    return reply
      .code(healthy ? 200 : 503)
      .send({ status: healthy ? "ok" : "unavailable", postgres, clickhouse });
  });

  // Registered without `fastify-plugin` on purpose: the adapter replaces every
  // body parser inside its own scope so the provider sees the bytes that were
  // sent, and encapsulation is what stops that reaching the JSON routes below.
  void app.register(webHandler, {
    prefix: AUTH_BASE_PATH,
    handler: identity.handler,
  });

  void app.register(signupRoutes, {
    identity,
    authBasePath: AUTH_BASE_PATH,
    baseUrl: config.baseUrl,
    singleOrganization: config.singleOrganization,
  });

  void app.register(meRoutes, { provider: identity.provider });

  void app.register(signOutRoutes, { provider: identity.provider });

  void app.register(deviceRoutes, {
    identity,
    authBasePath: AUTH_BASE_PATH,
    baseUrl: config.baseUrl,
  });

  const rateLimit =
    options.rateLimit ??
    fixedWindowRateLimit({
      limit: config.rateLimitPerMinute,
      windowMilliseconds: 60_000,
    });

  void app.register(apiKeyRoutes, { provider: identity.provider, rateLimit });

  void app.register(memberRoutes, {
    provider: identity.provider,
    rateLimit,
    emailSender,
    baseUrl: config.baseUrl,
  });

  // What a developer's folder syncs against. Its own scope, like every other
  // group here, so the credentialed hook and the routes it protects cannot come
  // apart and one group's error handler never answers another's refusals.
  void app.register(testRoutes, { provider: identity.provider, rateLimit });

  // The OTLP door, registered without `fastify-plugin` for the same reason the
  // provider's adapter is: it replaces every body parser inside its own scope
  // so that telemetry arrives as the bytes that were sent, and encapsulation is
  // what stops that reaching the JSON routes above.
  void app.register(traceRoutes, { provider: identity.provider, rateLimit });

  // The v1 read surface, in its own scope beside the door rather than inside
  // it. It shares the `/v1/traces` path and none of the door's arrangements: a
  // list and a transcript are ordinary JSON responses, and the parser the door
  // replaces is one they want back.
  void app.register(traceReadRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  // Outside the credentialed scope on purpose: somebody following an
  // invitation has no membership, so there is no context to resolve them into
  // and no organization to key a budget on. The token is the credential there.
  void app.register(invitationRoutes, { provider: identity.provider });

  return { app, identity };
}
