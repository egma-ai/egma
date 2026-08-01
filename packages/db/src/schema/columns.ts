import { idCheckPattern, type IdPrefix } from "@egma/ids";
import { sql } from "drizzle-orm";
import { check, customType, timestamp } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Every identifier column. `COLLATE "C"` is byte comparison with no language
 * rules: as fast as comparing a uuid, and immune to the index corruption that
 * follows an operating-system collation change.
 */
export const idText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text COLLATE "C"';
  },
});

/** Case-insensitive text, from the `citext` extension. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

/**
 * Timezone-aware, always. A simulation can begin before midnight and end after
 * it, and the two ends can sit in different time zones.
 */
export const moment = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const createdAt = () => moment("created_at").notNull().defaultNow();
export const updatedAt = () => moment("updated_at").notNull().defaultNow();

/** Pins a table's identifier column to that table's own prefix. */
export const prefixCheck = (
  name: string,
  column: AnyPgColumn,
  prefix: IdPrefix,
) => check(name, sql`${column} ~ ${sql.raw(`'${idCheckPattern(prefix)}'`)}`);

/** Enumerated values are text plus a check, never a native Postgres enum. */
export const oneOf = (name: string, column: AnyPgColumn, values: string[]) =>
  check(
    name,
    sql`${column} in ${sql.raw(`(${values.map((value) => `'${value}'`).join(", ")})`)}`,
  );

export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const API_KEY_SCOPES = ["organization", "project"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const DEVICE_CODE_STATUSES = ["pending", "approved", "denied"] as const;
export type DeviceCodeStatus = (typeof DEVICE_CODE_STATUSES)[number];
