import { sql } from "drizzle-orm";
import { boolean, check, pgTable } from "drizzle-orm/pg-core";

import { createdAt, idText, prefixCheck } from "./columns.ts";

/**
 * Who this deployment is.
 *
 * One row, minted the first time anybody asks, and never written again. It says
 * nothing about any customer — it is the deployment's own name for itself, and
 * the one fact an agent repository commits beside the identifiers this platform
 * owns.
 *
 * It lives in the database rather than in configuration for the two things a
 * repository binding has to survive. A restart, a new container, a changed port
 * or a moved origin all keep the same identity, because the data did. And a
 * *different* egma later served at the same address is a different identity,
 * because its database is a different database — which is the case a stored
 * origin alone cannot tell apart, and the reason the identifier is stored at
 * all. Restoring this deployment's backup somewhere else deliberately carries
 * the identity with it: the resources the binding protects came back too.
 *
 * `only` is the whole primary key, so the table can hold one row and no second
 * one is representable. Two instances booting at the same moment race on that
 * key, and the loser reads what the winner wrote.
 */
export const platformInstance = pgTable(
  "platform_instance",
  {
    only: boolean("only").primaryKey().default(true),
    id: idText("id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("platform_instance_only_one", sql`${table.only}`),
    prefixCheck("platform_instance_id_prefix", table.id, "ins"),
  ],
);
