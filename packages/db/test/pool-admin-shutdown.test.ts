import { setTimeout as after } from "node:timers/promises";

import { expect, it } from "vitest";

import { ping } from "../src/client.ts";
import {
  createConnectedDatabase,
  createMigratedDatabase,
  forceDrop,
} from "./support/database.ts";

/**
 * A killed idle connection must never take the process with it.
 *
 * Teardown drops each test database `with (force)`, which terminates any
 * backend still attached. The terminated backend's FATAL — `57P01`,
 * `admin_shutdown` — arrives asynchronously on whichever pool held the idle
 * connection, as an `error` event. An unlistened `error` event is an uncaught
 * exception: the run fails with every test green, which is how this file's
 * absence looked in CI. In production the same event is a restarted or failed-
 * over Postgres, and the cost is the whole API process.
 *
 * Both pools — the application's in `src/client.ts` and the test support's in
 * `support/database.ts` — park an idle connection here, have the database
 * dropped out from under them on purpose, and the assertion is arriving at the
 * end of the file at all. Before the listeners existed, this file failed the
 * run exactly the way CI did.
 */

it("the support pool survives its database being force-dropped under it", async () => {
  const database = await createMigratedDatabase("admin_shutdown_support");
  // One answered query parks an idle connection in the pool.
  const answered = await database.sql("select 1 as one");
  expect(answered.rows[0]).toEqual({ one: 1 });

  await forceDrop(database.name);
  // The FATAL from the killed backend arrives asynchronously; give it time to
  // land while the pool sits idle. There is nothing to assert afterwards — an
  // uncaught exception here fails the run, and its absence is the proof.
  await after(400);

  await database.close();
});

it("the application pool survives the same, and stays usable", async () => {
  const database = await createConnectedDatabase("admin_shutdown_app");
  await ping();

  await forceDrop(database.name);
  await after(400);

  // The pool discarded the killed client. It must still be usable — the next
  // checkout mints a fresh connection; against a dropped database that is an
  // ordinary rejection on the query itself, never a process-level event.
  await expect(ping()).rejects.toThrow();

  await database.close();
});
