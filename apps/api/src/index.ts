import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  runClickHouseMigrations,
  runMigrations,
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

connect({ databaseUrl: config.databaseUrl });
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

const { app } = buildApi({ config });
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
