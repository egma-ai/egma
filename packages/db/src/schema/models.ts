import { pgTable, text, unique } from "drizzle-orm/pg-core";

import { organization } from "./tenancy.ts";
import { user } from "./identity.ts";
import { createdAt, idText, oneOf, prefixCheck, updatedAt } from "./columns.ts";
import { MODEL_PROVIDERS } from "../models/catalog.ts";

/**
 * Who pays for the organization's model traffic, and — where the organization
 * pays for it itself — the keys that authorize it.
 *
 * Two tables, both keyed by the organization, because the organization is the
 * only tenancy boundary and both of these facts belong to the customer rather
 * than to any project, persona or grader inside it. A persona names a provider;
 * it never names a credential and never holds a secret, so rotating a key
 * changes no authored version and an authored version can never leak one.
 */

/**
 * The two ways an organization's model traffic can be paid for. One
 * organization-wide value, and there is deliberately no third state and no
 * per-provider mixing: "managed for speech, my own for the LLM" is a policy
 * nobody asked for and a resolution rule in every claim forever.
 */
export const MODEL_ACCESS_MODES = ["managed", "customer-owned"] as const;
export type ModelAccessMode = (typeof MODEL_ACCESS_MODES)[number];

/**
 * The organization's one model access choice.
 *
 * **A missing row is `customer-owned` rather than a fault.** Every organization
 * that existed before this table did has no row, and customer-owned is the
 * honest reading of that: nothing has been connected to Egma's own provider
 * accounts, so nothing may spend from them. Writing a row for every existing
 * organization would say a decision was made where none was.
 *
 * A table of its own rather than a column on `organization_settings`, for the
 * reason the judge configuration is its own table: settings is read whenever an
 * organization is drawn, and this is read on the claim path for every
 * simulation. Keeping them apart keeps a hot read off a page's row and lets
 * this one grow the fields managed access needs without touching the other.
 */
export const modelAccess = pgTable(
  "model_access",
  {
    organizationId: idText("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** `managed` or `customer-owned`. See `MODEL_ACCESS_MODES`. */
    mode: text("mode").notNull(),
    updatedBy: idText("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("model_access_organization_id_prefix", table.organizationId, "org"),
    oneOf("model_access_mode_allowed", table.mode, [...MODEL_ACCESS_MODES]),
  ],
);

/**
 * One model provider's key, sealed, owned by the organization.
 *
 * **At most one active credential per provider, held by the database.** Two
 * keys for one account is a question — which one does this simulation
 * spend from? — that nothing downstream could answer without inventing a rule,
 * and a persona stores the provider rather than a credential id precisely so
 * that there is nothing to choose between. Replacing the key rotates it: the
 * row keeps its identity and the next claim picks the new secret up.
 *
 * **The secret is write-only and there is no read that returns it.** The access
 * module's `COLUMNS` names every column an answer may carry, and the envelope
 * is not among them — so the field is absent from the read shape rather than
 * blanked, and leaking one through a serializer is not a thing anybody can
 * forget. What a person may see is the hint, the last few characters, which
 * exists for one job: telling two keys apart.
 *
 * **The label the judge credential carried is deliberately gone.** A judge
 * credential could be one of several for a provider, so it needed a name to be
 * chosen by; there is one per provider here, so the provider *is* the name and
 * a second one would be a field two admins could disagree about.
 */
export const modelProviderCredential = pgTable(
  "model_provider_credential",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Which provider account this authorizes. See `MODEL_PROVIDERS`. */
    provider: text("provider").notNull(),
    /**
     * The key, sealed with the deployment's own encryption key — the same
     * module and the same master key a connection's credentials are sealed
     * with, keeping its version prefix so a later re-sealing is a data
     * migration rather than a guess at what an old row held.
     */
    credentials: text("credentials").notNull(),
    /** The last characters of the key. Never enough of it to use. */
    credentialsHint: text("credentials_hint").notNull(),
    /** The opaque token an edit has to name to be allowed to land. */
    revision: idText("revision").notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("model_provider_credential_id_prefix", table.id, "mpc"),
    prefixCheck(
      "model_provider_credential_revision_prefix",
      table.revision,
      "rev",
    ),
    oneOf("model_provider_credential_provider_allowed", table.provider, [
      ...MODEL_PROVIDERS,
    ]),
    /**
     * The one-per-provider rule, held by the database rather than by whoever
     * writes the row. Removing a credential deletes it rather than archiving
     * it: unlike a judge credential, nothing points at this row by id — a
     * persona names the provider — so there is no frozen plan to strand and no
     * history to make unreadable.
     */
    unique("model_provider_credential_one_per_provider").on(
      table.organizationId,
      table.provider,
    ),
  ],
);
