import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  installBillingPlugIn,
  reconcileGraderCatalog,
  runClickHouseMigrations,
  runMigrations,
  seedPersonaLibrary,
  estimateVoiceSimulationDemand,
} from "@egma/db";

import { loadCloudBilling, type StoppableJob } from "./billing.ts";
import { loadConfig, type Config } from "./config.ts";
import { platformEvent } from "./platform-log.ts";
import { buildApi } from "./server.ts";
import { startRateCardInitialization } from "./rate-card.ts";
import {
  createVoiceFleetWake,
  createVoiceFleetReconciler,
  type VoiceFleetReconcileResult,
} from "./voice-fleet.ts";

const config = loadConfig();

// Postgres migrations apply on boot and are a hard gate. There is no separate
// migration container and no manual step, and two instances starting at once
// cannot both apply. A file that fails throws here, before anything is served:
// an instance running against a schema it could not finish applying would look
// healthy until the first read of a column nobody created. Authentication and
// acceptance both depend on this store, so nothing can usefully start without
// it.
const migrations = await runMigrations(config.databaseUrl);

connect({
  databaseUrl: config.databaseUrl,
  encryptionKey: config.encryptionKey,
});
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

/**
 * Apply ClickHouse migrations in the background with capped exponential retry.
 * Acceptance can serve while ClickHouse is unavailable; draining waits for
 * schema readiness. The ingest-only role skips these migrations.
 */
type TraceStoreSchema =
  | { readonly state: "skipped" }
  | { readonly state: "migrating" }
  | { readonly state: "ready"; readonly applied: readonly string[] };

let traceSchema: TraceStoreSchema =
  config.ingestion.role === "ingest"
    ? { state: "skipped" }
    : { state: "migrating" };

// Egma-provided personas, written from the fixed-id catalog before any
// project can be created or read. A new project points its default directly at
// one of these rows, so provisioning must fail at start-up rather than create a
// project with a missing default if the catalog cannot be written.
//
// Catalog edits add immutable versions and move the shared current pointer.
// Old simulations keep their pinned version. A no-op boot returns no rows and
// writes no log entry.
const personaShelf = await seedPersonaLibrary();

// egma's own graders, written onto the shelf from egma's own catalog. After the
// migrations because it writes rows, and before the first request because a
// project reading its Library a second later has to find them there.
//
// Reconciliation is keyed by stable definition identifiers. A release that
// changes executable logic creates one immutable shared definition version and
// moves only the shared current pointer. Future runs pin it; old run plans keep
// their exact version. Project rows keep only scope and pass threshold. A
// release that changed nothing writes nothing at all — not even `updated_at`.
const graderCatalog = await reconcileGraderCatalog();

// The billing adapter this deployment's settings select.
//
// With no Stripe secret named this is `undefined`, nothing is imported, and
// the product runs on the open plug-in — every allowance unlimited, every
// usage record discarded. That is the deployment every self-hoster runs and it
// is not a special case. With one named, the commercially licensed package is
// loaded here, once, and its plan rows are written before the first request:
// an allowance cannot be answered against a plan nobody wrote.
const cloudBilling = await loadCloudBilling(config);

const running: Config = cloudBilling === undefined
  ? config
  : { ...config, billing: cloudBilling.plugIn };

// The billing plug-in, put in place for the whole process before the first
// request. This is where the seams inside the data-access module — run start,
// the claim door and the write that stores a usage record — start reaching it.
installBillingPlugIn(running.billing);

const voiceFleetSettings = config.voiceFleet;
const hostedVoice = voiceFleetSettings === undefined
  ? undefined
  : await (async () => {
      // Daytona and AWS STS stay outside the self-hosted boot path. Only the
      // explicit launcher setting loads either client.
      const [{ Daytona }, adapter] = await Promise.all([
        import("@daytona/sdk"),
        import("./voice-fleet-daytona.ts"),
      ]);
      const client = new Daytona({
        apiKey: voiceFleetSettings.apiKey,
        ...(voiceFleetSettings.apiUrl === undefined
          ? {}
          : { apiUrl: voiceFleetSettings.apiUrl }),
        ...(voiceFleetSettings.target === undefined
          ? {}
          : { target: voiceFleetSettings.target }),
      });
      return {
        client,
        adapter,
        claimRuntime: adapter.daytonaClaimRuntime(voiceFleetSettings, { client }),
      };
    })();

let reconcileVoiceFleet:
  | (() => Promise<VoiceFleetReconcileResult>)
  | undefined;
const wakeVoiceFleet = config.voiceFleet === undefined
  ? undefined
  : createVoiceFleetWake({
      reconcile: () => reconcileVoiceFleet?.(),
      failed: (err) => {
        app.log.error(
          { err },
          "voice fleet reconciliation failed; the sweep will retry",
        );
      },
    });

const { app } = buildApi({
  config: running,
  traceStoreReady: () => traceSchema.state === "ready",
  ...(wakeVoiceFleet === undefined ? {} : { wakeVoiceFleet }),
  ...(hostedVoice === undefined
    ? {}
    : { daytonaClaimRuntime: hostedVoice.claimRuntime }),
  ...(cloudBilling === undefined ? {} : { billingRoutes: cloudBilling.routes }),
  ...(cloudBilling?.webhookRoutes === undefined
    ? {}
    : { billingWebhookRoutes: cloudBilling.webhookRoutes }),
});

if (config.voiceFleet !== undefined) {
  if (hostedVoice === undefined) throw new Error("Daytona was not initialized");
  const fleet = hostedVoice.adapter.daytonaVoiceFleet(config.voiceFleet, {
    client: hostedVoice.client,
    log: app.log,
    onFreed: () => wakeVoiceFleet?.(),
  });
  const reconciler = createVoiceFleetReconciler({
    fleet,
    estimateDemand: () => estimateVoiceSimulationDemand({
      caps: config.simulationConcurrencyCaps,
    }),
    log: app.log,
  });
  reconcileVoiceFleet = reconciler.reconcile;
}

/** The longest this process waits between attempts on the trace-store schema. */
const TRACE_SCHEMA_BACKOFF_CAP_MILLISECONDS = 5 * 60_000;
/** Set the moment a signal arrives, so the retry loop stops instead of racing shutdown. */
let stopping = false;

if (traceSchema.state === "migrating") {
  void (async () => {
    let backoffMilliseconds = 1_000;
    for (;;) {
      if (stopping) return;
      try {
        const applied = await runClickHouseMigrations(config.clickhouseUrl);
        traceSchema = { state: "ready", applied: applied.applied };
        app.log.info(
          { traceStore: applied.applied },
          applied.applied.length === 0
            ? "trace-store schema already up to date"
            : "trace-store schema migrations applied",
        );
        return;
      } catch (cause) {
        // Reported and waited out, never thrown and never terminal: the
        // acceptance path is already serving, and a store slow to wake finishes
        // on a later attempt while the drainer stands by.
        app.log.error(
          { err: cause, retryInMilliseconds: backoffMilliseconds },
          "the trace-store schema could not be applied; draining is held until it is",
        );
        await new Promise<void>((wake) => {
          // Unref'd, so a backoff in flight never keeps the process from exiting.
          setTimeout(wake, backoffMilliseconds).unref();
        });
        backoffMilliseconds = Math.min(
          backoffMilliseconds * 2,
          TRACE_SCHEMA_BACKOFF_CAP_MILLISECONDS,
        );
      }
    }
  })();
}

if (personaShelf.length > 0) {
  // Names, ids and immutable version ids are product catalog facts. Persona
  // content and provider credentials are not logged.
  app.log.info(
    { personas: personaShelf },
    "Predefined personas were written to the library",
  );
}
if (graderCatalog.definitions.length > 0) {
  // The names and the versions: what is worth saying is which of egma's own
  // graders this release put on the shelf or moved, and a version of 1 is one
  // that arrived while anything higher is one whose definition changed.
  app.log.info(
    { graders: graderCatalog.definitions },
    "Predefined graders were written to the library",
  );
}
if (cloudBilling !== undefined && cloudBilling.seededPlans.length > 0) {
  // A plan is a price somebody set. Saying which rows this boot wrote is what
  // makes a pricing change readable in a deployment log rather than only in a
  // file's history.
  app.log.info(
    { plans: cloudBilling.seededPlans },
    "Cloud plan rows were written from the shipped file",
  );
}
if (cloudBilling !== undefined && cloudBilling.caughtUp.charged > 0) {
  // A usage sink may fail without failing the write that stored the record,
  // and a resend cannot replace the lost delivery — so the plug-in charges
  // what it finds uncharged when it loads. Every row here is money this
  // deployment would otherwise never have collected.
  app.log.warn(
    {
      charged: cloudBilling.caughtUp.charged,
      amountMicros: cloudBilling.caughtUp.amountMicros,
    },
    "Inference charges that reached no sink were caught up at boot",
  );
}
if (graderCatalog.projectGraders.length > 0) {
  // The projects, never anything a customer wrote: what is worth saying is
  // that projects which lacked their protected Expected behaviors policy now
  // have it, and which ones.
  app.log.info(
    {
      projects: graderCatalog.projectGraders.map((grader) => grader.projectId),
    },
    "Egma's Expected behaviors grader was added to existing projects",
  );
}
app.log.info(
  { applied: migrations.applied, role: config.ingestion.role },
  migrations.applied.length === 0
    ? "schema already up to date"
    : "schema migrations applied",
);

/**
 * The hourly job that tells Stripe what each Pro organization's month has
 * used.
 *
 * **In this process, on a deployment that bills, and nowhere else.** It is
 * started with the cloud plug-in and it is the only scheduled work billing
 * adds: the allowances are enforced from Postgres on every request, and this
 * only reports minutes so Stripe can price the tiers and put the overage on
 * the invoice. A Stripe that is unreachable delays a bill and stops no work.
 *
 * It runs once when this process starts serving, for the hour that has just
 * closed — so a deployment that was restarting on the hour still reports it —
 * and then on the hour.
 * Every event carries an identifier made of the meter, the organization and
 * the hour, so a repeat is refused by Stripe rather than counted twice.
 *
 * The `ingest` role does not run it, for the reason it skips the trace-store
 * schema: a process that only accepts evidence has no business reporting
 * somebody's month.
 */
let meterJob: StoppableJob | undefined;
let rateCardJob: StoppableJob | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    meterJob?.stop();
    rateCardJob?.stop();
    void (async () => {
      await app.close();
      await disconnect();
      await disconnectClickHouse();
      app.log.info(platformEvent("egma.service.stopped", "API service stopped"));
    })();
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(
  platformEvent("egma.service.started", "API service started", {
    "server.port": config.port,
  }),
);

// Started once the process is serving: it is neither a gate on serving nor
// something a request waits for.
rateCardJob = startRateCardInitialization(app.log, running.billing.pricingUnavailable);
if (cloudBilling !== undefined && config.ingestion.role !== "ingest") {
  meterJob = cloudBilling.startMeterJob(app.log);
}
