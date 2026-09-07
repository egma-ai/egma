import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  installBillingPlugIn,
} from "@egma/db";
import { providerCredentialSource } from "@egma/provider-credentials";

import { loadConfig } from "./config.ts";
import { loadCloudBilling } from "./billing.ts";
import { makeLog, platformEvent } from "./log.ts";
import { startService } from "./service.ts";

/**
 * Start after the API has applied migrations; this service does not migrate.
 * Resolve deployment provider keys once per claimed job only if a frozen
 * grader definition needs a model. Code-only grading needs no provider key.

 */
const config = loadConfig();
const log = makeLog(config.logLevel, config.claimant);

connect({ databaseUrl: config.databaseUrl });
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

const cloud = await loadCloudBilling(config);
if (cloud !== undefined) {
  installBillingPlugIn(cloud.plugIn);
  log.info(
    platformEvent("egma.billing.installed", {
      plans: cloud.seededPlans.join(","),
      // What loading it charged: the stored usage records a failed usage sink
      // never charged. Zero on every ordinary boot.
      caughtUp: cloud.caughtUp.charged,
    }),
    "the cloud billing adapter is installed",
  );
}

const service = startService({
  config,
  log,
  providerCredentials: providerCredentialSource(process.env),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info(
      platformEvent("egma.service.stop_requested", { signal }),
      "grader service stop requested",
    );
    // Finish active jobs and persist their grades before closing stores.
    service.stop();
  });
}

await service.finished;
await disconnect();
await disconnectClickHouse();
log.info(platformEvent("egma.service.stopped"), "grader service stopped");
