import {
  billingIsConfigured,
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  installBillingPlugIn,
} from "@egma/db";
import { providerCredentialSource } from "@egma/provider-credentials";

import { loadConfig } from "./config.ts";
import { makeLog, platformEvent } from "./log.ts";
import { startService } from "./service.ts";

/**
 * The grader service, started.
 *
 * **No migrations here, unlike the API.** The API applies the schema to both
 * stores on boot and this container waits for it to be healthy, so a grader that
 * migrated too would be a second writer racing the first over the same files for
 * no benefit. It reads a schema somebody else applied, which is the whole reason
 * it can be one more copy rather than one more decision.
 *
 * Provider keys come from the deployment credential source. After a claimed
 * job resolves its frozen grader versions, the service reads the current bundle
 * once only when at least one of them calls a model. Nothing is unsealed from
 * Postgres, and code-only work does not depend on a credential store.
 *
 * **Billing is selected here the same way the API selects it**, from the same
 * setting and through the same dynamic import: a grading job's only spend is
 * the judge's model usage, and the claim asks the deployment whether Egma's
 * key may fund it before it hands one out. With no Stripe secret named,
 * nothing is imported and every claim is funded, which is the deployment every
 * self-hoster runs.
 */
const config = loadConfig();
const log = makeLog(config.logLevel, config.claimant);

connect({ databaseUrl: config.databaseUrl });
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

if (billingIsConfigured(config)) {
  // The plan rows come with the plug-in, so whichever process boots first
  // writes them and the other finds them there. A grader that reached a
  // customer's account before anybody had written a plan row would meet the
  // account's own foreign key.
  const ee = await import("@egma/ee");
  const cloud = await ee.loadCloudBilling();
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
    // Asked to stop rather than killed: the job in hand is finished and its
    // grades are written before anything closes. A copy that was killed
    // mid-judgment would cost one lease and no data — but there is no reason to
    // spend either when the container is being replaced on purpose.
    service.stop();
  });
}

await service.finished;
await disconnect();
await disconnectClickHouse();
log.info(platformEvent("egma.service.stopped"), "grader service stopped");
