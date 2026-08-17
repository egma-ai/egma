import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  managedDeploymentFrom,
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
 * **The encryption key, and exactly one thing it opens.** A judged grader has to
 * replay the project's own judge key to the provider, so this process holds the
 * key that unseals one — there is no arrangement in which the thing making the
 * call does not. What it can reach is held narrow on the other side: a judge key
 * is resolved through one door that refuses every caller whose context did not
 * come from a grading claim, and a connection's credentials are behind a door
 * that asks for a permission the engine's context does not carry. So this
 * service can open the one secret it needs and none of the others.
 *
 * It is optional, and its absence is an ordinary deployment: a project that
 * configured no judge never opens an envelope. One that did, on a grader given
 * no key, gets `errored` verdicts saying so rather than a service that will not
 * start.
 */
const config = loadConfig();
const log = makeLog(config.logLevel, config.claimant);

connect({
  databaseUrl: config.databaseUrl,
  ...(config.encryptionKey === undefined
    ? {}
    : { encryptionKey: config.encryptionKey }),
  // The same three names the control plane reads, read the same way. A grader
  // that resolved a different gateway address from the simulator beside it
  // would judge a conversation on an account nobody chose.
  managedDeployment: managedDeploymentFrom(process.env),
});
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
