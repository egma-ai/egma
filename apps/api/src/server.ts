import { ping, pingClickHouse } from "@egma/db";
import { platformOpenApi } from "@egma/platform-api/openapi";
import type { Fetch as RetellFetch } from "@egma/retell";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import {
  createIdentity,
  type Identity,
  type IdentityOptions,
} from "./auth/better-auth.ts";
import {
  loggingEmailSender,
  smtpEmailSender,
  type EmailSender,
} from "./auth/email.ts";
import { admitIdentity, onIdentityCreated } from "./auth/provisioning.ts";
import { closeAcceptance, openAcceptance } from "./ingestion/accept.ts";
import { claimRoutes } from "./routes/claims.ts";
import { deviceRoutes } from "./routes/device.ts";
import { heartbeatRoutes } from "./routes/heartbeats.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { passwordResetRoutes } from "./routes/password-reset.ts";
import { platformApiRoutes } from "./routes/platform-api.ts";
import { platformSettingsRoutes } from "./routes/platform-settings.ts";
import { reportRoutes } from "./routes/reports.ts";
import { signOutRoutes } from "./routes/sign-out.ts";
import { signupRoutes } from "./routes/signup.ts";
import { traceRoutes } from "./routes/traces.ts";
import { fixedWindowRateLimit, type RateLimit } from "./http/rate-limit.ts";
import { webHandler } from "./http/web-handler.ts";
import {
  startRetellProductionIngestion,
  type RetellProductionIngestion,
} from "./retell-production-ingestion.ts";
import type { RetellReach } from "./retell/api.ts";
import { startOrphanSweep, type OrphanSweep } from "./simulation-sweep.ts";
import type { Config } from "./config.ts";
import {
  platformEvent,
  PRIVATE_LOG_SERIALIZERS,
} from "./platform-log.ts";

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
  /**
   * How often the standing Retell production-ingestion loop checks for due
   * Monitoring targets. Each target keeps its own stable ~30s schedule.
   */
  readonly retellProductionIngestionIntervalMilliseconds?: number;
  /**
   * Where Retell answers production-ingestion reads. Absent is Retell itself;
   * a test stands a Retell-shaped server on loopback.
   */
  readonly retellReach?: RetellReach;
  /** Test-only device-flow pace; a production server uses five seconds. */
  readonly deviceAuthorizationInterval?: IdentityOptions["deviceAuthorizationInterval"];
  /** Test seam for Retell account reads. Production uses the global fetch. */
  readonly retellFetch?: RetellFetch | undefined;
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
  const logger = {
    level: options.logTo === undefined ? (process.env.LOG_LEVEL ?? "info") : "info",
    serializers: PRIVATE_LOG_SERIALIZERS,
    ...(options.logTo === undefined ? {} : { stream: options.logTo }),
  };

  const app = Fastify({
    logger,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
    // Fastify's built-in request lines include the raw URL and client address.
    // One safe completion record is written below from the route template.
    logController: new LogController({ disableRequestLogging: true }),
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
      ? loggingEmailSender(() => {
          // The body contains a signed link and the recipient is personal
          // data. Neither belongs in platform telemetry. The application flow
          // already returns the link directly when this transport is active.
          app.log.info(
            platformEvent(
              "egma.email.delivery.skipped",
              "email was not sent because no mail transport is configured",
            ),
          );
        })
      : smtpEmailSender(config.smtp));

  const identity = createIdentity({
    baseUrl: config.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    emailSender,
    ...(options.deviceAuthorizationInterval === undefined
      ? {}
      : { deviceAuthorizationInterval: options.deviceAuthorizationInterval }),
    // Provider diagnostics are not a second path around the platform log's
    // privacy boundary. The provider's message and arbitrary detail objects can
    // contain customer values, so only a safe exception shape reaches Pino.
    log: (level, _message, details) => {
      const cause = details.find((detail) => detail instanceof Error);
      app.log[level]({ err: cause }, "identity provider reported a diagnostic");
    },
    hooks: {
      admitIdentity: admitIdentity(config.singleOrganization),
      // A project's immutable grader versions now name their own models. The
      // provider key is resolved only when grading work starts, so signup must
      // not copy a deployment credential into the new project's Postgres rows.
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

  app.get("/openapi.json", { logLevel: "warn" }, async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=300")
      .send(platformOpenApi),
  );

  app.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route === "/health" && reply.statusCode < 400) {
      done();
      return;
    }

    const event = platformEvent(
      "egma.http.server.request.finished",
      "HTTP request finished",
      {
        "http.request.method": request.method,
        "http.route": route ?? "<unmatched>",
        "http.response.status_code": reply.statusCode,
        duration_ms: reply.elapsedTime,
      },
    );
    if (reply.statusCode >= 500) request.log.error(event);
    else request.log.info(event);
    done();
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

  // Every customer-managed resource is registered through this one boundary.
  // It is the same explicit operation set that produces OpenAPI and the
  // generated TypeScript client. The separate protocols below do not enter it.
  void app.register(platformApiRoutes, {
    provider: identity.provider,
    rateLimit,
    emailSender,
    baseUrl: config.baseUrl,
    blob: config.blob,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
    ...(options.retellReach === undefined
      ? {}
      : { retellReach: options.retellReach }),
  });

  // What this deployment has been configured with, as an owner reads and
  // changes it. Its own credentialed scope, like every other group, so its one
  // refusal — the settings of a platform are not everybody's to see — never
  // reaches another group's error handler. It stays outside the public
  // platform API because deployment settings are not customer resources.
  void app.register(platformSettingsRoutes, {
    provider: identity.provider,
    rateLimit,
    // What a deployment holds for itself is an owner's to read and change only
    // while that owner is the whole deployment. On one serving several
    // customers the carrier route belongs to none of them, and the question of
    // whose it is is not answered yet.
    singleOrganization: config.singleOrganization,
  });

  // The simulator's claim door. Outside the credentialed scope and the
  // per-organization rate limit on purpose: the caller is egma's own
  // simulator, whose service token is the whole gate and resolves to no
  // customer — so there is no organization to key a budget on, and a busy
  // run can never eat a customer's request budget from the inside.
  void app.register(claimRoutes, {
    serviceToken: config.simulatorServiceToken,
    providerCredentials: config.providerCredentials,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
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

  // Outside the credentialed scope on purpose: somebody following an
  // invitation has no membership, so there is no context to resolve them into
  // and no organization to key a budget on. The token is the credential there.
  void app.register(invitationRoutes, { provider: identity.provider });

  // Beside it and outside the same scope, for the same reason turned around:
  // somebody who cannot remember their password cannot sign in to ask for a
  // new one, so this pair answers before anybody is anybody. Which transport
  // the deployment has decides where the link goes and nothing else — the
  // sender already decides that, and reset never gained a setting of its own.
  void app.register(passwordResetRoutes, {
    identity,
    authBasePath: AUTH_BASE_PATH,
    baseUrl: config.baseUrl,
    secret: config.authSecret,
  });

  // The standing orphan sweep, started with the server and stopped with it.
  // Its timer is unref'd, so a shutdown never waits on a sweep that has not
  // happened; every replica runs one, which the seam makes harmless.
  let orphanSweep: OrphanSweep | undefined;
  // Retell production ingestion runs beside the orphan sweep. Every selected
  // agent is DB-leased before a provider request, so every API replica can run
  // the same loop without overlapping one target.
  let retellProductionIngestion: RetellProductionIngestion | undefined;
  app.addHook("onReady", async () => {
    // Before anything can be accepted, and before the drainer that will read
    // the same bucket: opening it recovers whatever the last stop left staged,
    // so evidence that was in hand when a process died is on its way again
    // within the first tick rather than after the first new request.
    openAcceptance({ settings: config.ingestion, log: app.log });
    orphanSweep = startOrphanSweep({
      log: app.log,
      ...(options.orphanSweepIntervalMilliseconds === undefined
        ? {}
        : { intervalMilliseconds: options.orphanSweepIntervalMilliseconds }),
    });
    retellProductionIngestion = startRetellProductionIngestion({
      log: app.log,
      ...(options.retellProductionIngestionIntervalMilliseconds === undefined
        ? {}
        : {
            intervalMilliseconds:
              options.retellProductionIngestionIntervalMilliseconds,
          }),
      ...(options.retellReach === undefined ? {} : { reach: options.retellReach }),
    });
  });
  app.addHook("onClose", async () => {
    // Awaited, so closing drains any tick in flight: whoever closes the app
    // and then the stores knows the sweep holds no connection to them.
    await orphanSweep?.stop();
    await retellProductionIngestion?.stop();
    // Last, and it uploads nothing on the way out: what is staged is on the
    // disk with its checksums, and the next start is what sends it.
    await closeAcceptance();
  });

  return { app, identity };
}
