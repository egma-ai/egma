/**
 * Stop what `pnpm db:up` started, and whatever else this workspace is running.
 *
 * `docker compose down`, unchanged from what this command has always been: it
 * takes the whole project down rather than the two stores, because a developer
 * asking for the deployment to stop means the deployment.
 *
 * It needs the same wrapper `start-stores.ts` does, and that is worth saying
 * plainly because it is the half that is easy to forget: Compose reads the
 * whole file before it does anything, `down` included. A `down` that refused
 * over a variable no container it is stopping ever read would leave a developer
 * unable to stop what they had just been able to start. See `compose.ts`.
 */

import { composeOrExit } from "./compose.ts";

composeOrExit(["down"]);
