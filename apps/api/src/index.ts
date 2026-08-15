import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  runClickHouseMigrations,
  runMigrations,
  seedDefaultJudge,
  seedPlatformSettings,
} from "@egma/db";

import { loadConfig } from "./config.ts";
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

// The platform's own judge, given to every project that has configured none.
// After the migrations because it writes a row, and before the first request
// because a run started a second later has to be gradable. It never overwrites
// a project's own choice, so running it on every boot is what makes a project
// created later get one too.
const judged =
  config.defaultJudge === undefined ? [] : await seedDefaultJudge(config.defaultJudge);

// The settings this environment offers, written for anything the platform does
// not already hold. This is how an automated deployment configures itself with
// no interview — and it never replaces a setting somebody has changed, so a
// redeploy carrying a script's copy of an old key cannot undo a new one.
const seeded = await seedPlatformSettings(config.platformSettings);

const { app } = buildApi({ config });
if (seeded.length > 0) {
  // The names, never the values and never their hints: what is worth saying is
  // that this platform just gained settings it did not have, and which ones.
  app.log.info(
    { settings: seeded },
    "the environment supplied platform settings this deployment was missing",
  );
}
if (judged.length > 0) {
  // The project ids, never the key and never its hint: what is worth saying is
  // that somebody's grading just started working, and which projects it is
  // about.
  app.log.info({ projects: judged }, "the platform's default judge was given to projects that had none");
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
    })();
  });
}

await app.listen({ host: config.host, port: config.port });
