import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

import { user } from "./identity.ts";
import { organization, project } from "./tenancy.ts";
import {
  createdAt,
  DEVICE_CODE_STATUSES,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * A terminal asking to be let in.
 *
 * This is the one table where the two halves of the model meet, which is why it
 * has a file of its own rather than sitting with the other four identity
 * tables. The left half is the auth provider's: the device code, the user code,
 * who claimed it and what state it is in are RFC 8628's fields, written and
 * read by the provider. The right half is egma's: which organization and which
 * project the person chose to authorize the terminal for, which the provider
 * has no field for and no opinion about.
 *
 * The choice is recorded here rather than carried in the RFC's `scope` string
 * because it is two foreign keys into egma's tenancy tables, and the pairing is
 * checked by the database the same way every other tenancy pairing is. A
 * terminal cannot be authorized for one customer's project under another
 * customer's name, even by a hand-written `UPDATE`.
 *
 * Nothing here is long-lived. The row expires, and the provider deletes it the
 * moment the terminal exchanges the code — which is why the key the terminal
 * ends up holding is minted from this row rather than stored in it.
 */
export const deviceCode = pgTable(
  "device_code",
  {
    id: idText("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: idText("user_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    clientId: text("client_id"),
    scope: text("scope"),
    status: text("status").notNull(),
    /**
     * What the terminal is being authorized for, chosen by the person at the
     * moment they approve. Empty until then, and both are filled together.
     */
    organizationId: idText("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    projectId: idText("project_id"),
    expiresAt: moment("expires_at").notNull(),
    lastPolledAt: moment("last_polled_at"),
    pollingInterval: integer("polling_interval"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("device_code_id_prefix", table.id, "dvc"),
    oneOf("device_code_status_allowed", table.status, [
      ...DEVICE_CODE_STATUSES,
    ]),
    unique("device_code_device_code_unique").on(table.deviceCode),
    unique("device_code_user_code_unique").on(table.userCode),
    // Either the terminal has been aimed at a customer and a project, or it has
    // not been aimed at all. An organization with no project would leave the
    // pairing below unchecked, because a foreign key over a null column passes.
    check(
      "device_code_authorized_for_agrees",
      sql`(${table.organizationId} is null) = (${table.projectId} is null)`,
    ),
    // The pairing, not each column on its own.
    foreignKey({
      name: "device_code_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("device_code_expires_at_idx").on(table.expiresAt),
  ],
);
