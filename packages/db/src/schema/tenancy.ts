import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { persona } from "./personas.ts";
import { EGMA_PROVIDED_PERSONAS } from "../persona-library/ids.ts";
import { user } from "./identity.ts";
import {
  API_KEY_SCOPES,
  citext,
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  ROLES,
  updatedAt,
  type ApiKeyScope,
  type Role,
} from "./columns.ts";
import { check } from "drizzle-orm/pg-core";

/** Tenancy. The organization is the customer, and the only boundary. */

export const organization = pgTable(
  "organization",
  {
    id: idText("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    externalIdentityProvider: text("external_identity_provider"),
    externalIdentityId: text("external_identity_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("organization_id_prefix", table.id, "org"),
    unique("organization_slug_unique").on(table.slug),
    unique("organization_external_identity_unique").on(
      table.externalIdentityProvider,
      table.externalIdentityId,
    ),
  ],
);

export const organizationSettings = pgTable(
  "organization_settings",
  {
    organizationId: idText("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null means keep forever. */
    retentionDays: integer("retention_days"),
    dataResidency: text("data_residency"),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck(
      "organization_settings_organization_id_prefix",
      table.organizationId,
      "org",
    ),
  ],
);

export const project = pgTable(
  "project",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /**
     * What this product area is for, in the words of whoever set it up.
     *
     * Optional, and nullable rather than defaulted to the empty string: a
     * project nobody has described yet is *undescribed*, and a page can say so
     * — where an empty string is a description somebody wrote and left blank.
     */
    description: text("description"),
    /**
     * The opaque token an edit has to name to be allowed to land — see
     * `revisions.ts`. A project's name, slug and description are live fields
     * that two admins can be looking at in two tabs, and the last write must
     * not silently win.
     */
    revision: idText("revision").notNull(),
    /**
     * The persona a test created naming none receives, so authoring a first
     * test never waits on authoring a persona. New projects point directly at
     * Egma's shared, read-only default persona. An admin may replace it with
     * another Egma-provided persona or with a Custom fork. This is
     * required. The database default also protects direct internal inserts.
     *
     * **It lives on the project, and this is the one place the layering
     * bends.** Every other table below the tenancy tables points *up* at a
     * project; this column points down at a product table, so this file has to
     * import one. The default belongs to the project rather than to any test:
     * it is one answer for the whole product area, changed in one place, and
     * putting it anywhere else would mean each test carrying a copy of a
     * decision nobody made per test. A migration trigger enforces that the
     * target is either Egma-provided or owned by this exact project.
     *
     * **The resulting import cycle is deliberate and safe**, and it is worth
     * knowing why before either file is rearranged. `persona` names
     * `project` for its tenancy and `project` now names `persona` for
     * this pointer. Neither reads the other while either is still being
     * evaluated: a column's `references` takes a function rather than a
     * column, and a table's constraint list is a function the table definition
     * stores instead of calling. Both are only run later, once every table in
     * this schema exists. Replace either with a value read at definition time
     * and the cycle stops being safe.
     */
    defaultPersonaId: idText("default_persona_id")
      .notNull()
      .default(EGMA_PROVIDED_PERSONAS.defaultPersona)
      .references((): AnyPgColumn => persona.id, { onDelete: "restrict" }),
    deletedAt: moment("deleted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("project_id_prefix", table.id, "prj"),
    prefixCheck("project_revision_prefix", table.revision, "rev"),
    // Uniqueness follows scope, and the tenant column is always in the
    // constraint. There is deliberately no unique on organization_id alone:
    // one project per organization is a provisioning default, not a schema
    // rule, so a second project stays a product change and not a migration.
    unique("project_organization_id_slug_unique").on(
      table.organizationId,
      table.slug,
    ),
    // Looks redundant next to the primary key; it is the composite-foreign-key
    // target that makes an organization/project mismatch unrepresentable.
    unique("project_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    index("project_organization_id_idx")
      .on(table.organizationId)
      .where(sql`${table.deletedAt} is null`),
  ],
);

export const membership = pgTable(
  "membership",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: idText("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().$type<Role>(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("membership_id_prefix", table.id, "mbr"),
    oneOf("membership_role_allowed", table.role, [...ROLES]),
    // One organization per person, in v1. Dropping this unique index is the
    // whole reversal, which is why nothing reads a person's organization
    // without going through the resolver.
    unique("membership_user_id_unique").on(table.userId),
    unique("membership_organization_id_user_id_unique").on(
      table.organizationId,
      table.userId,
    ),
    index("membership_organization_id_idx").on(table.organizationId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    role: text("role").notNull().$type<Role>(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: moment("expires_at").notNull(),
    acceptedAt: moment("accepted_at"),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("invitation_id_prefix", table.id, "inv"),
    oneOf("invitation_role_allowed", table.role, [...ROLES]),
    unique("invitation_token_hash_unique").on(table.tokenHash),
    index("invitation_organization_id_idx").on(table.organizationId),
  ],
);

export const apiKey = pgTable(
  "api_key",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null means the key is organization-scoped. */
    projectId: idText("project_id"),
    scope: text("scope").notNull().$type<ApiKeyScope>(),
    /** A single SHA-256 over a high-entropy random secret. */
    hash: text("hash").notNull(),
    prefix: text("prefix").notNull(),
    displaySuffix: text("display_suffix").notNull(),
    name: text("name"),
    lastUsedAt: moment("last_used_at"),
    revokedAt: moment("revoked_at"),
    /**
     * A key carries no role of its own; it resolves its creator's current role
     * at request time, so it must always have a creator.
     */
    createdByUserId: idText("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("api_key_id_prefix", table.id, "key"),
    oneOf("api_key_scope_allowed", table.scope, [...API_KEY_SCOPES]),
    check(
      "api_key_project_scope_agrees",
      sql`(${table.scope} = 'project') = (${table.projectId} is not null)`,
    ),
    unique("api_key_hash_unique").on(table.hash),
    // The pairing, not each column on its own: a key cannot name one
    // organization and another organization's project.
    foreignKey({
      name: "api_key_project_organization_fk",
      columns: [table.projectId, table.organizationId],
      foreignColumns: [project.id, project.organizationId],
    }).onDelete("cascade"),
    index("api_key_organization_id_idx").on(table.organizationId),
  ],
);
