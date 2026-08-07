import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
} from "@egma/db";

import { loadConfig } from "./config.ts";
import { makeLog } from "./log.ts";
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
 * **No encryption key, either.** Grading reads conversations, graders and test
 * versions, and writes verdicts; it never touches a connection's credentials, so
 * it is never handed the key that would unseal one. A service that cannot
 * decrypt a secret cannot leak one.
 */
const config = loadConfig();
const log = makeLog(config.logLevel, config.claimant);

connect({ databaseUrl: config.databaseUrl });
connectClickHouse({ clickhouseUrl: config.clickhouseUrl });

const service = startService({ config, log });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info("stopping", { signal });
    // Asked to stop rather than killed: the job in hand is finished and its
    // verdicts are written before anything closes. A copy that was killed
    // mid-judgment would cost one lease and no data — but there is no reason to
    // spend either when the container is being replaced on purpose.
    service.stop();
  });
}

await service.finished;
await disconnect();
await disconnectClickHouse();
log.info("stopped");
