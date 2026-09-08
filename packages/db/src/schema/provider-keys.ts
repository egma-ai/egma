import { check, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { MODEL_PROVIDERS } from "../models/catalog.ts";
import { idText, oneOf, prefixCheck, updatedAt } from "./columns.ts";
import { organization } from "./tenancy.ts";

/** One current encrypted provider key per organization and provider. */
export const providerKey = pgTable(
  "provider_key",
  {
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    credentials: text("credentials").notNull(),
    hint: text("hint").notNull(),
    revision: idText("revision").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.provider] }),
    oneOf("provider_key_provider_allowed", table.provider, [
      ...MODEL_PROVIDERS,
    ]),
    prefixCheck("provider_key_revision_prefix", table.revision, "rev"),
    check("provider_key_hint_shape", sql`char_length(${table.hint}) = 8`),
  ],
);
