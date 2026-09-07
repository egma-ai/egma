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
  upsertRateCard,
} from "@egma/db";

import { loadCloudBilling } from "./billing.ts";
import { loadConfig, type Config } from "./config.ts";
import { platformEvent } from "./platform-log.ts";
import { buildApi } from "./server.ts";

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
 * The trace store's own schema, applied in the background and never fatal.
 *
 * **This is the failure the durable boundary exists to remove.** A slow
 * ClickHouse Cloud wake used to throw out of this module, so the process never
 * reached `listen()` — and an egma that could have accepted evidence into
 * object storage and drained it later instead accepted nothing, and took the
 * hosted address down with it. Evidence is safe when it is durable in the
 * bucket; ClickHouse is what happens next, and "next" is allowed to be late.
 *
 * So it runs beside the server rather than in front of it, its state is a
 * reported component, and the drainer refuses to drain until it finishes —
 * writing a segment into a schema still being built is how a good object
 * becomes a retained defect for a reason that had nothing to do with it.
 *
 * It never settles into a terminal failure. A slow or unreachable store is
 * retried with a doubling, capped backoff: the migrations are idempotent and one
 * instance holds their lock, so a later attempt finishes what an earlier one
 * could not — and until one does, the acceptance path keeps taking evidence and
 * the drainer stands by. A process stuck in a `failed` state would hold the
 * deployment's one drain claim behind a green health check for good, while a
 * healthy sibling stood by forever.
 *
 * The `ingest` role skips it: that process never writes ClickHouse, and a role
 * that only accepts evidence has no business applying somebody else's schema.
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

// The rate card, written from the shipped file onto its table. After the
// migrations because it writes rows, and before the first request because the
// door that stores a usage record prices it against this table — a record
// written before the prices existed would be stored at nothing and could never
// be corrected, since a stored cost never moves.
//
// An insert that does nothing where the price is already there, so every
// instance can run it on every boot and only a release that added a price
// writes anything. A price is never updated: a change is a new row with a
// later effective date, and the old row is what a past simulation is still
// priced at.
const rateCard = await upsertRateCard();

// The billing adapter this deployment's settings select.
//
// With no Stripe secret named this is `undefined`, nothing is imported, and
// the product runs on the open plug-in — every allowance unlimited, every
// usage record discarded. That is the deployment every self-hoster runs and it
// is not a special case. With one named, the commercially licensed package is
// loaded here, once, and its plan rows are written before the first request:
// an allowance cannot be answered against a plan nobody wrote.
const cloudBilling = await loadCloudBilling(config);
const plans = await cloudBilling?.seedPlans();

const running: Config = cloudBilling === undefined
  ? config
  : { ...config, billing: cloudBilling.plugIn };

// The billing plug-in, put in place for the whole process before the first
// request. This is where the seams inside the data-access module — run start,
// the claim door and the write that stores a usage record — start reaching it.
installBillingPlugIn(running.billing);

const { app } = buildApi({
  config: running,
  traceStoreReady: () => traceSchema.state === "ready",
  ...(cloudBilling === undefined ? {} : { billingRoutes: cloudBilling.routes }),
});

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
if (rateCard.written.length > 0) {
  // Prices are product catalog facts and are worth saying once: what this
  // release added, and from which date each applies.
  app.log.info(
    { prices: rateCard.written },
    "Rate-card prices were written from the shipped file",
  );
}
if (plans !== undefined && plans.written.length > 0) {
  // A plan is a price somebody set. Saying which rows this boot wrote is what
  // makes a pricing change readable in a deployment log rather than only in a
  // file's history.
  app.log.info(
    { plans: plans.written },
    "Cloud plan rows were written from the shipped file",
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
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
