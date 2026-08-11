import { boolean, pgTable, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, idText, prefixCheck } from "./columns.ts";

/**
 * The identity of this Egma platform, not of any customer on it.
 *
 * One row lives with the platform database. It therefore survives API process
 * restarts and moves with a restored platform backup. The singleton key makes
 * two API processes racing on first read settle on the same identifier.
 */
export const platformInstance = pgTable(
  "platform_instance",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: idText("id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("platform_instance_id_unique").on(table.id),
    prefixCheck("platform_instance_id_format", table.id, "pf"),
  ],
);
