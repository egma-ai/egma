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
 * Device authorization combines provider-managed codes/state with Egma's selected
 * organization and project. Foreign keys validate the scope pairing. The terminal
 * reads this scope before token exchange consumes the row; its API key is minted separately.
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
