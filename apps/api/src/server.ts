import {
  openDrainOwnership,
  ping,
  pingClickHouse,
  type DrainOwnership,
} from "@egma/db";
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
import {
  closeAcceptance,
  openAcceptance,
  stagedLoad,
} from "./ingestion/accept.ts";
import { retainedDefects } from "./ingestion/defects.ts";
import { startDrainer, type Drainer } from "./ingestion/drainer.ts";
import {
  pendingObjectStore,
  type PendingObjectStore,
} from "./ingestion/object-store.ts";
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
  /**
   * Whether this process runs the standing drainer, over and above what its
   * role already says. Defaults to whatever the role says.
   *
   * The role is the deployment's answer — `all` and `drain` drain, `ingest`
   * does not — and this is the seam a proof uses to hold a sealed segment
   * still and look inside it: in a running deployment that state lasts about
   * as long as one upload, and a proof that raced it would be a proof about
   * timing. It can only take draining away, never give it to a role that does
   * not have it.
   */
  readonly drainsPendingEvidence?: boolean;
  /**
   * Whether the trace store's schema has finished being applied.
   *
   * The entrypoint owns that work — it is non-fatal and runs beside the server
   * — and the drainer and the health surface both have to ask rather than
   * assume. Absent means "nothing is applying it", which is the honest answer
   * for a suite that migrated its own store before building the API.
   */
  readonly traceStoreReady?: (() => boolean) | undefined;
};

export type Api = {
  readonly app: FastifyInstance;
  /**
   * The provider the server was built on, handed back rather than hidden: the
   * seam is what the rest of egma will ask for identities through, and a thing
   * nobody can reach is a thing nobody can test.
   */
  readonly identity: Identity;
  /**
   * This process's drainer once the server is ready, or nothing where it names
   * no ingestion store or was built not to drain.
   *
   * Handed back on the same terms as the identity provider: whoever owns the
   * server owns its standing work, and `drainNow` is how a caller waits for a
   * pass to have *finished* rather than to have been scheduled.
   */
  drainer(): Drainer | undefined;
};

export function buildApi(options: ServerOptions): Api {
  const { config } = options;
  const { role } = config.ingestion;
  /** `all` and `ingest` serve the acceptance path; `drain` serves none of it. */
  const acceptsEvidence = role !== "drain";
  /** `all` and `drain` walk the pending prefix; `ingest` never does. */
  const drainsEvidence =
    role !== "ingest" && options.drainsPendingEvidence !== false;

  // One client for the whole process, shared by the drainer and the health
  // check: two would be two connection pools to one bucket, and a health probe
  // that used its own would be proving a path nothing else takes.
  const ingestionStore: PendingObjectStore | undefined =
    config.ingestion.store === undefined
      ? undefined
      : pendingObjectStore(config.ingestion.store, {
          requestTimeoutMilliseconds:
            config.ingestion.requestTimeoutMilliseconds,
        });

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
   * `/health` answers one question: **can this process still accept evidence
   * and keep the promise it makes when it does?**
   *
   * That promise is object-store durability, so the status code follows the
   * three things acceptance actually needs — Postgres for authentication and
   * control state, a writable local log below its refusal bound, and a
   * reachable ingestion bucket. Nothing else may flip it.
   *
   * **ClickHouse deliberately cannot.** It used to: a slow trace store made
   * this endpoint answer `503`, which took the container out of its own health
   * check and, on the hosted platform, took the shared address down with it —
   * while the write path was perfectly able to accept evidence and drain it
   * later. Read health and drain health are real facts and they are reported
   * here, but they are components rather than verdicts. A query outage is a
   * query outage; it is not egma being unable to receive a conversation.
   *
   * The path and the existing body keys stay exactly as they were, because
   * five `depends_on` edges and one hosted tunnel already read them.
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

  /** Whether the local log will take more, asked of the log rather than guessed. */
  const stagedState = (): {
    readonly state: "writable" | "full" | "unavailable";
    readonly bytes: number;
    readonly records: number;
  } => {
    try {
      const load = stagedLoad();
      if (load === undefined) return { state: "unavailable", bytes: 0, records: 0 };
      return {
        state: load.full ? "full" : "writable",
        bytes: load.bytes,
        records: load.records,
      };
    } catch (cause) {
      app.log.error({ err: cause }, "health check could not read the local log");
      return { state: "unavailable", bytes: 0, records: 0 };
    }
  };

  /** What this process is doing about the pending prefix, in one word. */
  const drainState = ():
    | "draining"
    | "standby"
    | "migrating"
    | "not_running" => {
    if (!drainsEvidence || drainer === undefined) return "not_running";
    const standing = drainer.standingBy();
    if (standing === "trace_store_migrating") return "migrating";
    if (standing === "standby") return "standby";
    return "draining";
  };

  app.get("/health", { logLevel: "warn" }, async (_request, reply) => {
    const [postgres, clickhouse, ingestion] = await Promise.all([
      reachability("Postgres", ping),
      reachability("ClickHouse", pingClickHouse),
      ingestionStore === undefined
        ? Promise.resolve("unreachable" as const)
        : reachability("the ingestion object store", () =>
            ingestionStore.reachable(),
          ),
    ]);
    const staged = stagedState();

    // A `drain` process serves no acceptance path, so its write readiness is
    // Postgres alone: holding it unhealthy for a bucket it never writes to
    // would take a perfectly good drainer out of its own health check.
    const ready =
      postgres === "reachable" &&
      (!acceptsEvidence ||
        (ingestion === "reachable" && staged.state === "writable"));

    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      role,
      postgres,
      clickhouse,
      ingestion,
      localLog: staged.state,
      // Reported so an operator can see a backlog forming before it refuses.
      // Both, because both bounds bind and either one can be the near one.
      stagedBytes: staged.bytes,
      stagedRecords: staged.records,
      drain: drainState(),
      // Every reason class this process has retained an accepted segment
      // under, and how many of each. Absent means nothing was retained, which
      // is what a healthy deployment reports forever.
      retainedDefects: Object.fromEntries(retainedDefects()),
    });
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
  //
  // Registered for the roles that accept evidence. A `drain` process has no
  // local log open and no promise it could keep, so the honest answer there is
  // that this door is not here — rather than a door that takes a request and
  // refuses every one of them.
  if (acceptsEvidence) {
    void app.register(traceRoutes, {
      provider: identity.provider,
      rateLimit,
      serviceToken: config.simulatorServiceToken,
    });
  }

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
  // Exactly one process per deployment drains: pending objects into
  // ClickHouse, the replay-safe handoffs, and then the object. A second
  // `all` or `drain` instance starts its drainer, fails to take the
  // deployment's claim, and stands by — which is the whole arrangement, and is
  // why an operator can restart the one that holds it without doing anything.
  let drainer: Drainer | undefined;
  let drainOwnership: DrainOwnership | undefined;
  app.addHook("onReady", async () => {
    // The drainer first, so the hand-off below has somewhere to hand to. Its
    // own startup scan is what makes that hand-off optional: a segment whose
    // hint is lost costs a scan interval and never an object.
    if (ingestionStore !== undefined && drainsEvidence) {
      drainOwnership = await openDrainOwnership();
      drainer = startDrainer({
        store: ingestionStore,
        log: app.log,
        scanIntervalMilliseconds: config.ingestion.scanIntervalMilliseconds,
        ownership: drainOwnership,
        ...(options.traceStoreReady === undefined
          ? {}
          : { traceStoreReady: options.traceStoreReady }),
      });
    }

    // Opening acceptance recovers whatever the last stop left staged, so
    // evidence that was in hand when a process died is on its way again within
    // the first tick rather than after the first new request. A `drain`
    // process opens none: it serves no door, and a local log nothing writes to
    // is a directory and a file handle for nothing.
    if (acceptsEvidence) {
      openAcceptance({
        settings: config.ingestion,
        log: app.log,
        onSegmentDurable: (segment) => {
          drainer?.wake(segment.key);
        },
      });
    }
    orphanSweep = startOrphanSweep({
      log: app.log,
      ...(options.orphanSweepIntervalMilliseconds === undefined
        ? {}
        : { intervalMilliseconds: options.orphanSweepIntervalMilliseconds }),
    });
    // Retell has to be pulled, and pulling is how evidence arrives — so it
    // belongs to the roles that accept. Every selected agent is DB-leased
    // before a provider request, so several accepting replicas can run the
    // same loop without overlapping one target.
    if (acceptsEvidence) {
      retellProductionIngestion = startRetellProductionIngestion({
        log: app.log,
        ...(options.retellProductionIngestionIntervalMilliseconds === undefined
          ? {}
          : {
              intervalMilliseconds:
                options.retellProductionIngestionIntervalMilliseconds,
            }),
        ...(options.retellReach === undefined
          ? {}
          : { reach: options.retellReach }),
      });
    }
  });
  app.addHook("onClose", async () => {
    // Awaited, so closing drains any tick in flight: whoever closes the app
    // and then the stores knows the sweep holds no connection to them.
    await orphanSweep?.stop();
    await retellProductionIngestion?.stop();
    // Acceptance before the drainer, so nothing new is uploaded into a bucket
    // nobody is reading; and neither uploads nor drains anything on the way
    // out. What is staged is on the disk with its checksums and what is pending
    // is in the bucket, and the next start is what moves both.
    await closeAcceptance();
    await drainer?.stop();
    // Last, so the claim is given up only once this process has stopped
    // draining. Postgres would drop it with the connection anyway; releasing it
    // here is what lets the next instance take over immediately rather than
    // after a socket timeout.
    await drainOwnership?.release();
  });

  return { app, identity, drainer: () => drainer };
}
