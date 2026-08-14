import { boolean, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, idText, prefixCheck, updatedAt } from "./columns.ts";

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

/**
 * What this deployment has been configured with: one row for each setting,
 * sealed, and owned by the whole platform rather than by any customer on it.
 *
 * **Why the platform owns these at all.** They used to live in a file beside
 * the deployment that only the egma CLI read. Start the platform any other way
 * — the plain `docker compose up` the documentation shows, a machine restart in
 * a different directory, a colleague who cloned the repository — and every
 * setting was absent; and absent did not fail, because each variable had an
 * empty default. Every container started, every health check passed, and the
 * failure arrived minutes later as a carrier refusal naming nothing about
 * configuration. Postgres has a volume, so a setting written here survives a
 * restart, an upgrade and a move to another machine.
 *
 * **It carries no organization and no project**, and that is the whole point of
 * the table: these belong to the deployment. `platform_instance` above is the
 * precedent — a row that belongs to the whole platform and to no customer. The
 * judge is the other half of the same decision and is deliberately *not* here:
 * a judge is owned by the project that chose it, because a judge configured per
 * container would spend from an account nobody in that project agreed to. The
 * persona's own providers were argued the same way and decided the other way,
 * at the founder's direction: on a self-hosted deployment the operator and the
 * only project's admin are the same person, and asking twice for one key buys
 * nothing. The trigger to revisit is the first hosted tenant.
 *
 * **One row per setting rather than one sealed document.** The interface that
 * reads and writes these is a settings form that changes one field at a time;
 * each setting carries its own hint the way the judge configuration already
 * does; and adding a setting later is an insert rather than a schema change.
 *
 * That last property is why `name` carries **no allowed-value check**, which is
 * the one place this table departs from the schema's usual habit of pinning an
 * enumerated column. A check here would mean a migration for every setting the
 * platform grows, which is exactly the cost the row-per-setting shape was
 * chosen to avoid. What a name may be is `PLATFORM_SETTINGS` below, and the
 * access module refuses a write that names anything else — a name nobody wrote
 * is a row nothing ever reads, which is a very different kind of wrong from a
 * connection whose type no adapter has shipped for.
 */
export const platformSetting = pgTable(
  "platform_setting",
  {
    id: idText("id").primaryKey(),
    /** Which setting this is, from `PLATFORM_SETTINGS`. */
    name: text("name").notNull(),
    /**
     * The value, sealed with the deployment's own encryption key — the same
     * module and the same key a connection's credentials and a judge's key are
     * sealed with, keeping its version prefix so a later re-sealing is a data
     * migration rather than a guess at what an old row was encrypted with.
     *
     * Everything is sealed, including the settings that are not secret. One
     * rule for the column means there is no second shape a reader has to know
     * about, and no row whose secrecy depends on which writer wrote it.
     */
    value: text("value").notNull(),
    /**
     * What may be shown: the whole value for a setting that is not a secret,
     * and the last few characters for one that is. It is the only thing any
     * read of these answers with, which is what makes "never returns a key" a
     * property of the column rather than a promise each caller keeps.
     */
    hint: text("hint").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("platform_setting_id_prefix", table.id, "pfs"),
    // The setting's name is what a caller names and what a write conflicts on;
    // the identifier is the row's own, on the schema's standing rule that every
    // table has one.
    unique("platform_setting_name_unique").on(table.name),
  ],
);

/**
 * A setting this platform can hold, as a person meets it.
 *
 * The label is the words a readiness answer names it in — "the persona's model
 * key" rather than `persona_model_key` — because "setup required" with a column
 * name after it sends a self-hoster to read source.
 */
export type PlatformSettingDefinition = {
  readonly name: PlatformSettingName;
  /** What a person calls it, in a refusal and in a setup interview alike. */
  readonly label: string;
  /**
   * Whether the stored value may ever be shown back. A secret's hint is its
   * last few characters, so two keys can be told apart without either being
   * handed out; anything else hints with itself.
   */
  readonly secret: boolean;
};

/**
 * Every setting this platform knows about, in the order a person is asked for
 * them.
 *
 * The list grows as the effort moves the rest of the deployment's settings in:
 * the carrier trunk and the media backend, the speech providers and their keys.
 * Adding one here is an insert at run time and nothing else — no migration, and
 * no check constraint to widen.
 */
export const PLATFORM_SETTINGS = [
  {
    name: "persona_model_provider",
    label: "the persona's model provider",
    secret: false,
  },
  { name: "persona_model", label: "the persona's model", secret: false },
  { name: "persona_model_key", label: "the persona's model key", secret: true },
] as const satisfies readonly PlatformSettingDefinition[];

/** The name of one setting. A write that names anything else is refused. */
export type PlatformSettingName =
  | "persona_model_provider"
  | "persona_model"
  | "persona_model_key";

/** The settings a caller is changing or seeding, by name. */
export type PlatformSettingValues = Readonly<
  Partial<Record<PlatformSettingName, string>>
>;
