/**
 * Run docker compose down for the entire Compose project, including any
 * application services. compose.ts handles required-variable interpolation.
 */

import { composeOrExit } from "./compose.ts";

composeOrExit(["down"]);
