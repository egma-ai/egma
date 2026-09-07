/**
 * Start PostgreSQL and ClickHouse with Compose and wait for readiness.
 * compose.ts supplies unused application-variable placeholders.
 */

import { composeOrExit } from "./compose.ts";

composeOrExit(["up", "-d", "--wait", "postgres", "clickhouse"]);
