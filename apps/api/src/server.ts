import { ping } from "@egma/db";
import Fastify, { type FastifyInstance } from "fastify";

import { createIdentity, type Identity } from "./auth/better-auth.ts";
import { loggingEmailSender, type EmailSender } from "./auth/email.ts";
import { admitIdentity, onIdentityCreated } from "./auth/provisioning.ts";
import { meRoutes } from "./routes/me.ts";
import { signupRoutes } from "./routes/signup.ts";
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

  const emailSender =
    options.emailSender ??
    loggingEmailSender((email) => {
      app.log.info(
        { to: email.to, subject: email.subject, body: email.body },
        "no mail transport is configured, so this message was not sent",
      );
    });

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
  app.get("/health", { logLevel: "warn" }, async (_request, reply) => {
    try {
      await ping();
    } catch (cause) {
      app.log.error({ err: cause }, "health check could not reach Postgres");
      return reply.code(503).send({ status: "unavailable", postgres: "unreachable" });
    }
    return reply.send({ status: "ok", postgres: "reachable" });
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

  return { app, identity };
}
