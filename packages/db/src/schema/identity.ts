import { boolean, index, pgTable, text, unique } from "drizzle-orm/pg-core";

import {
  citext,
  createdAt,
  idText,
  moment,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * Identity. egma writes this DDL and owns the one user table; the auth provider
 * reads and writes these rows with its own migrator disabled, so it can use the
 * tables but cannot alter them.
 *
 * The fifth table the provider reads, `device_code`, is in `device.ts`: it is
 * the one that also carries tenancy, so it names both this file and the
 * tenancy tables and cannot sit inside either.
 */

export const user = pgTable(
  "user",
  {
    id: idText("id").primaryKey(),
    email: citext("email").notNull(),
    name: text("name"),
    image: text("image"),
    emailVerified: boolean("email_verified").notNull().default(false),
    externalIdentityProvider: text("external_identity_provider"),
    externalIdentityId: text("external_identity_id"),
    deactivatedAt: moment("deactivated_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("user_id_prefix", table.id, "usr"),
    unique("user_email_unique").on(table.email),
    // Postgres treats every null as distinct, so this permits unlimited empties
    // while allowing one of each real pairing.
    unique("user_external_identity_unique").on(
      table.externalIdentityProvider,
      table.externalIdentityId,
    ),
  ],
);

export const session = pgTable(
  "session",
  {
    id: idText("id").primaryKey(),
    userId: idText("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: moment("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("session_id_prefix", table.id, "ses"),
    unique("session_token_unique").on(table.token),
    index("session_user_id_idx").on(table.userId),
  ],
);

export const account = pgTable(
  "account",
  {
    id: idText("id").primaryKey(),
    userId: idText("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: moment("access_token_expires_at"),
    refreshTokenExpiresAt: moment("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("account_id_prefix", table.id, "acc"),
    index("account_user_id_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: idText("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: moment("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("verification_id_prefix", table.id, "vrf"),
    index("verification_identifier_idx").on(table.identifier),
  ],
);
