import { pgTable, text, unique } from "drizzle-orm/pg-core";

import { organization } from "./tenancy.ts";
import { user } from "./identity.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";
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

/**
 * One inference key an organization holds for the Egma model gateway, as
 * hosted Egma stores it: **a hash and its lifecycle, never a readable copy.**
 *
 * The sibling of `api_key` and deliberately not the same table. A product key
 * resolves to a person, a role and a project, and opens every ordinary Egma
 * door; this one resolves to an organization and opens exactly one thing —
 * managed model traffic through the Egma model gateway. Keeping them apart is
 * what makes "an inference key cannot use a normal Egma product interface" a
 * property of where the secret is looked up rather than a rule a door has to
 * remember: the product's resolver reads `api_key` and this row is not in it.
 *
 * **Several active keys per organization, on purpose.** Separate installations
 * hold separate keys, and rotation is create-then-revoke rather than
 * replace-in-place — so an administrator can bring a replacement up before the
 * old key stops working and nothing stops mid-run.
 */
export const inferenceKey = pgTable(
  "inference_key",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * What an administrator calls this key, so a list of several says which
     * installation each belongs to. Required: an unnamed key in a list of four
     * is a key nobody dares revoke.
     */
    name: text("name").notNull(),
    /**
     * A single SHA-256 over the secret, and the whole of what is kept.
     *
     * Unique across the deployment, which is what lets a validation request
     * find a key by its hash alone without naming an organization first — the
     * organization is the row's answer, never the caller's question.
     */
    hash: text("hash").notNull(),
    /** The static prefix every inference key starts with. */
    prefix: text("prefix").notNull(),
    /** The last characters of the secret. Enough to tell two keys apart. */
    displaySuffix: text("display_suffix").notNull(),
    createdBy: idText("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    /** When a connection last authenticated with it, so a dead key is visible. */
    lastUsedAt: moment("last_used_at"),
    /** When it stopped working. Read on every connection, so there is no cache to wait out. */
    revokedAt: moment("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("inference_key_id_prefix", table.id, "ifk"),
    unique("inference_key_hash_unique").on(table.hash),
  ],
);

/**
 * The one inference key a self-hosted organization has connected, sealed.
 *
 * **The other end of the row above, in the other deployment.** Hosted Egma
 * keeps the hash so it can answer "is this key good and whose is it"; the
 * self-hosted deployment keeps the secret itself, because it has to present it
 * every time a simulation opens a connection to the gateway. Neither holds what
 * the other does, which is the whole arrangement: a stolen hosted database
 * yields no usable key, and a stolen self-hosted one yields exactly the one
 * organization's own key and nothing else's.
 *
 * **One per organization, held by the primary key.** A self-hosted deployment
 * connects one key at a time; rotating is replacing this row, and the safe
 * overlap lives in Egma Cloud where several keys may be active at once.
 *
 * **`cloud_organization_id` is the binding, and it is why this column exists.**
 * Validation answers which Egma Cloud organization owns the key, and that
 * answer is written down — so a key belonging to somebody else's Egma Cloud
 * organization is refused while a binding stands, rather than quietly moving
 * this deployment's managed traffic onto another customer's account.
 */
export const managedAccessKey = pgTable(
  "managed_access_key",
  {
    organizationId: idText("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The Egma Cloud organization this local organization is bound to. */
    cloudOrganizationId: idText("cloud_organization_id").notNull(),
    /** The key, sealed with the deployment's own master key. Never read back out. */
    credentials: text("credentials").notNull(),
    /** The last characters of the key. Never enough of it to use. */
    credentialsHint: text("credentials_hint").notNull(),
    connectedBy: idText("connected_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck(
      "managed_access_key_organization_id_prefix",
      table.organizationId,
      "org",
    ),
    // `cloud_organization_id` carries no format check, and that is the
    // convention rather than an omission: a prefix check pins the identifiers
    // *this* deployment mints, and this one is another deployment's answer,
    // written down exactly as validation returned it. A check here would be
    // Egma Cloud's identifier format frozen into a self-hoster's database.
  ],
);
