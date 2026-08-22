import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
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
 */
const config = loadConfig();
const log = makeLog(config.logLevel, config.claimant);

connect({ databaseUrl: config.databaseUrl });
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

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
