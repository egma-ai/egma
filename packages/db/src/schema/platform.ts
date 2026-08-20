import { boolean, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";

import { createdAt, idText, oneOf, prefixCheck, updatedAt } from "./columns.ts";

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
 * The active carrier route for this deployment, stored one sealed member per
 * row so it survives process and machine restarts.
 *
 * It carries no organization or project because a phone route belongs to the
 * deployment. The four-name catalog below is the complete boundary. Model
 * choices and provider credentials have different owners and no write path to
 * this table.
 *
 * The access module treats the rows as one route: address plus source number
 * for source-IP authentication, or all four rows for SIP authentication. It
 * validates and writes that bundle in one transaction, so an old username can
 * never be combined with a new password.
 */
export const platformSetting = pgTable(
  "platform_setting",
  {
    id: idText("id").primaryKey(),
    /** Which setting this is, from `PLATFORM_SETTINGS`. */
    name: text("name").notNull(),
    /**
     * The value, sealed with the deployment's own encryption key — the same
     * module and the same key a connection's credentials are
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
    oneOf("platform_setting_name_allowed", table.name, [
      "carrier_trunk_address",
      "carrier_trunk_number",
      "carrier_trunk_username",
      "carrier_trunk_password",
    ]),
    // The route member's name is what a caller names and what a write conflicts on;
    // the identifier is the row's own, on the schema's standing rule that every
    // table has one.
    unique("platform_setting_name_unique").on(table.name),
  ],
);

/**
 * The phone route this platform owns.
 *
 * Model choices belong to immutable persona and grader versions. Provider keys
 * belong to deployment credential custody. VAD and media selection are
 * simulator deployment details. None of those facts may be written into this
 * row-per-setting store: doing so would recreate the independent live fields
 * that produced the production STT hybrid.
 *
 * The carrier is different. It is one live platform route, independent of the
 * persona that speaks over it. Address and source number are required. Username
 * and password are an optional pair because a carrier may authenticate by
 * source IP instead.
 */
export const PLATFORM_SETTINGS = [
  {
    name: "carrier_trunk_address",
    label: "the carrier trunk",
    secret: false,
    required: true,
  },
  {
    name: "carrier_trunk_number",
    label: "the source number",
    secret: false,
    required: true,
  },
  {
    name: "carrier_trunk_username",
    label: "the carrier trunk username",
    secret: false,
    required: false,
  },
  {
    name: "carrier_trunk_password",
    label: "the carrier trunk password",
    secret: true,
    required: false,
  },
] as const satisfies readonly {
  readonly name: string;
  /** What a person calls it, in a refusal and in a setup interview alike. */
  readonly label: string;
  /**
   * Whether the stored value may ever be shown back. A secret's hint is its
   * last few characters, so two keys can be told apart without either being
   * handed out; anything else hints with itself.
   */
  readonly secret: boolean;
  /**
   * Whether every route must hold it. The SIP username and password are an
   * optional pair because source-IP-authenticated carriers need neither.
   */
  readonly required: boolean;
}[];

/**
 * A setting this platform can hold, as a person meets it — one entry of the
 * catalog above, read off it rather than restated. `graders.ts`'s shape for
 * every closed vocabulary in this schema, applied to a list of records.
 */
export type PlatformSettingDefinition = (typeof PLATFORM_SETTINGS)[number];

/** The name of one setting. A write that names anything else is refused. */
export type PlatformSettingName = PlatformSettingDefinition["name"];

/**
 * Settings by name, in the clear.
 *
 * One shape for the three journeys a plain value makes: what a caller is
 * changing, what an environment is seeding, and what the platform hands the
 * simulator on a work order. They are the same thing said three times, and a
 * second alias for the third would be a second vocabulary for one map.
 */
export type PlatformSettingValues = Readonly<
  Partial<Record<PlatformSettingName, string>>
>;
