import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  reconcileDeploymentCarrierSettings,
  runClickHouseMigrations,
  runMigrations,
  seedGraderLibrary,
  seedPersonaLibrary,
  seedPlatformSettings,
  seedRunningGraders,
} from "@egma/db";

import { loadConfig } from "./config.ts";
import { platformEvent } from "./platform-log.ts";
import { buildApi } from "./server.ts";

const config = loadConfig();

// Migrations apply on boot, to both stores. There is no separate migration
// container and no manual step, and two instances starting at once cannot both
// apply to Postgres. A file that fails throws here, before anything is served:
// an instance running against a schema it could not finish applying would look
// healthy until the first read of a column nobody created.
const migrations = await runMigrations(config.databaseUrl);
const traceMigrations = await runClickHouseMigrations(config.clickhouseUrl);

connect({
  databaseUrl: config.databaseUrl,
  encryptionKey: config.encryptionKey,
});
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

// The carrier route this environment offers, written when the platform does
// not already hold one. This is how an automated deployment configures phone
// routing with no interview. In the default `platform` mode, a restart never
// replaces a complete route somebody changed.
const seeded = await seedPlatformSettings(config.platformSettings);

// An operator can instead say that the deployment environment owns the carrier
// route. Reconcile it on every start in that mode, after seeding. A changed
// route replaces the stored route, and an absent route removes it. This choice
// is explicit and independent of how many organizations the platform serves.
const reconciled =
  config.carrierSettingsSource === "environment"
    ? await reconcileDeploymentCarrierSettings(config.platformSettings)
    : [];

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
// An upsert keyed by fixed identifiers, so this is free on every boot after the
// first: a release that improved a judge prompt refreshes that row and bumps
// its version, and a release that changed nothing writes nothing at all — not
// even `updated_at`. That is what makes running it every time the mechanism
// rather than half of one.
const shelved = await seedGraderLibrary();

// And the other half of it: a shelf full of definitions judges nothing until a
// project is running a copy of one. Every project created from now on is born
// with the `expected_behaviors` copy inside the transaction that creates it;
// this writes it into every project made before that was true, so no project —
// new or old — runs unjudged.
//
// After the seeding above, because the copy points at the entry and the foreign
// key means it. Idempotent for a reason stronger than the upsert's: it asks
// whether a project has ever *had* a copy, so a team that switched theirs off
// keeps it off across every restart.
const judging = await seedRunningGraders();

const { app } = buildApi({ config });
if (seeded.length > 0) {
  // The names, never the values and never their hints: what is worth saying is
  // that this platform just gained settings it did not have, and which ones.
  app.log.info(
    { settings: seeded },
    "the environment supplied platform settings this deployment was missing",
  );
}
if (reconciled.length > 0) {
  // Names only. A value or hint here would put a production credential in the
  // deployment log, which is another credential store by accident.
  app.log.info(
    { settings: reconciled },
    "the deployment reconciled its carrier settings from the environment",
  );
}
if (personaShelf.length > 0) {
  // Names, ids and immutable version ids are product catalog facts. Persona
  // content and provider credentials are not logged.
  app.log.info(
    { personas: personaShelf },
    "Egma-provided personas were written to the library",
  );
}
if (shelved.length > 0) {
  // The names and the versions: what is worth saying is which of egma's own
  // graders this release put on the shelf or moved, and a version of 1 is one
  // that arrived while anything higher is one whose definition changed.
  app.log.info(
    { graders: shelved },
    "Egma-provided graders were written to the library",
  );
}
if (judging.length > 0) {
  // The projects, never anything a customer wrote: what is worth saying is that
  // projects which had no mandatory grading now have it, and which ones.
  app.log.info(
    { projects: judging.map((copy) => copy.projectId) },
    "Egma's expected-behaviors grader was switched on in projects that had never had it",
  );
}
app.log.info(
  { applied: migrations.applied, traceStore: traceMigrations.applied },
  migrations.applied.length === 0 && traceMigrations.applied.length === 0
    ? "schema already up to date"
    : "schema migrations applied",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
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
