import { ping, pingClickHouse } from "@egma/db";
import Fastify, { type FastifyInstance } from "fastify";

import { createIdentity, type Identity } from "./auth/better-auth.ts";
import {
  loggingEmailSender,
  smtpEmailSender,
  type EmailSender,
} from "./auth/email.ts";
import { admitIdentity, onIdentityCreated } from "./auth/provisioning.ts";
import { agentRoutes } from "./routes/agents.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { claimRoutes } from "./routes/claims.ts";
import { deviceRoutes } from "./routes/device.ts";
import { heartbeatRoutes } from "./routes/heartbeats.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { memberRoutes } from "./routes/members.ts";
import { mockToolRoutes } from "./routes/mock-tools.ts";
import { platformRoutes } from "./routes/platform.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runRoutes } from "./routes/runs.ts";
import { signOutRoutes } from "./routes/sign-out.ts";
import { signupRoutes } from "./routes/signup.ts";
import { testRoutes } from "./routes/tests.ts";
import { traceReadRoutes } from "./routes/trace-reads.ts";
import { traceRoutes } from "./routes/traces.ts";
import { fixedWindowRateLimit, type RateLimit } from "./http/rate-limit.ts";
import { webHandler } from "./http/web-handler.ts";
import { startOrphanSweep, type OrphanSweep } from "./simulation-sweep.ts";
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
  /**
   * Where log lines are written. Defaults to the process's own output, which
   * is what a container reads.
   *
   * A test hands in a destination of its own, because one of the promises this
   * door makes is about what is *not* written: a customer's provider secret
   * arrives here and must appear in no line egma keeps. That promise is only
   * worth making while something can read the log back and check it, so the
   * log is a seam rather than a side effect. A destination handed in is asked
   * for lines, whatever `LOG_LEVEL` a test run was started with.
   */
  readonly logTo?: { write(line: string): void } | undefined;
  /**
   * How often the standing orphan sweep runs. Defaults to the ~30s cadence; a
   * test hands in a shorter one rather than watching a real clock.
   */
  readonly orphanSweepIntervalMilliseconds?: number;
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
    logger:
      options.logTo === undefined
        ? { level: process.env.LOG_LEVEL ?? "info" }
        : { level: "info", stream: options.logTo },
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

  // Which egma this is, answered to anybody who asks. Outside the credentialed
  // scope on purpose and beside the health check for the same reason: a
  // repository asks it before there is a key to ask with, and the answer names
  // the deployment rather than anything inside it.
  void app.register(platformRoutes, { baseUrl: config.baseUrl });

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

  // The agent group: registering an agent with the first way of reaching it,
  // reading it back, and attaching another. Its own credentialed scope, like
  // every other group, so the rate limit and the context resolve once for it.
  void app.register(agentRoutes, { provider: identity.provider, rateLimit });

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

  // The mocked world a project's simulations run in: what egma answers with
  // when the agent calls one of its tools, so a test never books a real
  // appointment. Its own scope like every other group, so its refusals — a tool
  // this project already answers for among them — never reach another group's
  // error handler.
  void app.register(mockToolRoutes, { provider: identity.provider, rateLimit });

  // What a terminal starts and then watches: a run over one connection,
  // pinning exact versions, and the numbered feed a follower resumes from.
  // The base URL is handed in because the reply carries a results address a
  // person opens in a browser, and where this instance is is configuration
  // rather than something a route can know.
  void app.register(runRoutes, {
    provider: identity.provider,
    rateLimit,
    baseUrl: config.baseUrl,
  });

  // The simulator's claim door. Outside the credentialed scope and the
  // per-organization rate limit on purpose: the caller is egma's own
  // simulator, whose service token is the whole gate and resolves to no
  // customer — so there is no organization to key a budget on, and a busy
  // run can never eat a customer's request budget from the inside.
  void app.register(claimRoutes, {
    serviceToken: config.simulatorServiceToken,
  });

  // The heartbeat door, beside the claim door on the same terms — and all
  // the more so, because a busy run beats every few seconds per conversation,
  // which is exactly the traffic a per-organization budget must never see.
  void app.register(heartbeatRoutes, {
    serviceToken: config.simulatorServiceToken,
  });

  // And the report door, on the claim door's exact terms: the same gate,
  // the same exemption, and each row's own claimant naming whose
  // conversation a document may land.
  void app.register(reportRoutes, {
    serviceToken: config.simulatorServiceToken,
  });

  // The OTLP door, registered without `fastify-plugin` for the same reason the
  // provider's adapter is: it replaces every body parser inside its own scope
  // so that telemetry arrives as the bytes that were sent, and encapsulation is
  // what stops that reaching the JSON routes above. It takes the service token
  // beside the customer credentials because it is the one door with two: a
  // customer key files an agent's traces, and the simulator's own spans arrive
  // through this same door naming the simulation they are evidence of.
  void app.register(traceRoutes, {
    provider: identity.provider,
    rateLimit,
    serviceToken: config.simulatorServiceToken,
  });

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

  // The standing orphan sweep, started with the server and stopped with it.
  // Its timer is unref'd, so a shutdown never waits on a sweep that has not
  // happened; every replica runs one, which the seam makes harmless.
  let orphanSweep: OrphanSweep | undefined;
  app.addHook("onReady", async () => {
    orphanSweep = startOrphanSweep({
      log: app.log,
      ...(options.orphanSweepIntervalMilliseconds === undefined
        ? {}
        : { intervalMilliseconds: options.orphanSweepIntervalMilliseconds }),
    });
  });
  app.addHook("onClose", async () => {
    // Awaited, so closing drains any tick in flight: whoever closes the app
    // and then the stores knows the sweep holds no connection to them.
    await orphanSweep?.stop();
  });

  return { app, identity };
}
