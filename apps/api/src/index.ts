import { connect, disconnect, runMigrations } from "@egma/db";

import { loadConfig } from "./config.ts";
import { buildApi } from "./server.ts";

const config = loadConfig();

// Migrations apply on boot. There is no separate migration container and no
// manual step, and two instances starting at once cannot both apply.
const migrations = await runMigrations(config.databaseUrl);

connect({
  databaseUrl: config.databaseUrl,
  encryptionKey: config.encryptionKey,
});

const { app } = buildApi({ config });
app.log.info(
  { applied: migrations.applied },
  migrations.applied.length === 0
    ? "schema already up to date"
    : "schema migrations applied",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await disconnect();
    })();
  });
}

await app.listen({ host: config.host, port: config.port });
