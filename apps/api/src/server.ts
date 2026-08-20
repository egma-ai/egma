import { ping, pingClickHouse } from "@egma/db";
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
import { agentRoutes } from "./routes/agents.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { claimRoutes } from "./routes/claims.ts";
import { deviceRoutes } from "./routes/device.ts";
import { graderLibraryRoutes } from "./routes/grader-library.ts";
import { graderRoutes } from "./routes/graders.ts";
import { heartbeatRoutes } from "./routes/heartbeats.ts";
import { invitationRoutes } from "./routes/invitations.ts";
import { meRoutes } from "./routes/me.ts";
import { memberRoutes } from "./routes/members.ts";
import { monitoringRoutes } from "./routes/monitoring.ts";
import { organizationRoutes } from "./routes/organization.ts";
import { personaRoutes } from "./routes/personas.ts";
import { projectRoutes } from "./routes/projects.ts";
import { mockToolRoutes } from "./routes/mock-tools.ts";
import { passwordResetRoutes } from "./routes/password-reset.ts";
import { platformRoutes } from "./routes/platform.ts";
import { platformSettingsRoutes } from "./routes/platform-settings.ts";
import { recordingRoutes } from "./routes/recordings.ts";
import { reportRoutes } from "./routes/reports.ts";
import { runRoutes } from "./routes/runs.ts";
import { signOutRoutes } from "./routes/sign-out.ts";
import { signupRoutes } from "./routes/signup.ts";
import { simulationRoutes } from "./routes/simulations.ts";
import { testRoutes } from "./routes/tests.ts";
import { traceReadRoutes } from "./routes/trace-reads.ts";
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

  // Read before login and before any repository identifier is sent. It is
  // public because the CLI uses it to decide whether login is safe to start.
  //
  // Whether this deployment can dial is no longer worked out here and handed
  // down: the carrier is one of the platform's own settings now, so the door
  // that reports it and the door that enforces it each read the store when
  // they are asked. That is what stops them being one answer from start-up
  // that an operator finishing setup cannot change without a restart, and they
  // still cannot disagree — one store, one `phoneReadiness`, two callers.
  void app.register(platformRoutes, { origin: config.baseUrl });

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

  // The agent group: registering an agent with the first way of reaching it,
  // reading it back, and attaching another. Its own credentialed scope, like
  // every other group, so the rate limit and the context resolve once for it.
  void app.register(agentRoutes, {
    provider: identity.provider,
    rateLimit,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
  });

  // Production Monitoring setup is project configuration, not a simulation
  // connection. Each platform opens its own setup flow behind this route group.
  void app.register(monitoringRoutes, {
    provider: identity.provider,
    rateLimit,
    ...(options.retellFetch === undefined
      ? {}
      : { retellFetch: options.retellFetch }),
    ...(options.retellReach === undefined
      ? {}
      : { retellReach: options.retellReach }),
  });

  void app.register(memberRoutes, {
    provider: identity.provider,
    rateLimit,
    emailSender,
    baseUrl: config.baseUrl,
  });

  // The customer itself, and the product areas inside it. Two groups rather
  // than one because they answer different questions — which organization am I
  // in, and which projects does it hold — and because a project is addressed in
  // the path here while every product resource names one beside itself.
  void app.register(organizationRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  void app.register(projectRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  // What this deployment has been configured with, as an owner reads and
  // changes it. Its own credentialed scope, like every other group, so its one
  // refusal — the settings of a platform are not everybody's to see — never
  // reaches another group's error handler. It sits beside the public platform
  // route rather than inside it: they answer at addresses that share a prefix
  // and share nothing else, one asking for no credential and one refusing
  // anybody but an owner.
  void app.register(platformSettingsRoutes, {
    provider: identity.provider,
    rateLimit,
    // What a deployment holds for itself is an owner's to read and change only
    // while that owner is the whole deployment. On one serving several
    // customers the carrier route belongs to none of them, and the question of
    // whose it is is not answered yet.
    singleOrganization: config.singleOrganization,
  });

  // What a developer's folder syncs against. Its own scope, like every other
  // group here, so the credentialed hook and the routes it protects cannot come
  // apart and one group's error handler never answers another's refusals.
  void app.register(personaRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  void app.register(testRoutes, { provider: identity.provider, rateLimit });

  // The shelf of grader definitions a developer picks from — egma's own two,
  // and a team's when custom authoring arrives. Its own scope like every other
  // group, and one verb inside it: the library is read, never authored, which
  // is the whole shape of shipping a small set of predefined graders rather
  // than an authoring surface.
  void app.register(graderLibraryRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  // The graders a project actually judges with, the one act that makes another
  // — pressing Use on an entry from the shelf above — and the one act that
  // stops one, which is deleting it, because a copy that exists judges and
  // there is no other switch. Its own scope like every other group. No create
  // taking a type and criteria and no edit, because a grader is always a copy
  // of a definition somebody can read, and defining one is the surface
  // ADR-0009 shelved.
  void app.register(graderRoutes, { provider: identity.provider, rateLimit });

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

  // One conversation's own evidence: what happened, how egma judged it, and the
  // two ways a person revisits that judgement. Its own scope beside the run
  // group rather than inside it, because a conversation is reached by its own id
  // — the address somebody pastes into a ticket — and because its refusals are
  // its own: nothing to judge again, and nothing to disagree with.
  void app.register(simulationRoutes, {
    provider: identity.provider,
    rateLimit,
  });

  // Where a recording's reference becomes something a browser can play. Its own
  // scope beside the run group rather than inside it, because one route serves
  // two surfaces — a run's results and a transcript — and neither owns it. The
  // store is handed in and may be absent: naming where a browser reaches it is
  // what turns this on, and a deployment that named none says so in a sentence
  // rather than answering an empty player.
  void app.register(recordingRoutes, {
    provider: identity.provider,
    rateLimit,
    blob: config.blob,
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
  });

  return { app, identity };
}
