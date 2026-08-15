/**
 * Start the two stores the test suite needs, and nothing else.
 *
 * `docker compose up -d --wait postgres clickhouse` is the whole of the work.
 * Naming the two services is what holds this to the two stores: neither has a
 * `depends_on`, so nothing else in the deployment comes up beside them.
 *
 * Why it is a wrapper at all, and why the values it hands Compose reach no
 * container, is in `compose.ts` next to the values themselves.
 */

import { composeOrExit } from "./compose.ts";

composeOrExit(["up", "-d", "--wait", "postgres", "clickhouse"]);
