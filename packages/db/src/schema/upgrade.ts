import { pgTable, text, unique } from "drizzle-orm/pg-core";

import { organization } from "./tenancy.ts";
import {
  createdAt,
  idText,
  moment,
  oneOf,
  prefixCheck,
  updatedAt,
} from "./columns.ts";

/**
 * What the upgrade onto model selections leaves behind: the legacy keys it
 * found, and the decisions it refused to make on somebody's behalf.
 *
 * The stamp that says an installation has *finished* is not here — it is one
 * nullable column on `platform_instance`, which is already the row that belongs
 * to the whole deployment and to no customer on it.
 *
 * **Both exist because an upgrade cannot guess.** A deployment configured
 * before persona and grader models existed holds provider keys in three
 * different places and model choices in a fourth; the upgrade collects what is
 * there and gives every current persona and grader an explicit successor where
 * the answer is unambiguous. Where it is not — two keys for one provider, a
 * persona voice that disagrees with the deployment's speaking provider, a
 * setting naming a provider this release does not carry — it writes an *action*
 * instead and leaves the old path working. A guessed answer would be a
 * simulation quietly conducted with a model nobody chose, and that is worse
 * than a sentence asking somebody to choose.
 */

/**
 * Where one legacy key was found. Every source Egma knows how to look in, and
 * the word is what an administrator reads when several candidates make them
 * choose.
 *
 * - `platform_setting` — a deployment-wide model, speech or speaking key.
 * - `judge_credential` — an organization's own judge key.
 * - `judge_configuration` — the deployment's own key on a project's `platform`
 *   judge, which is a key the project never held and could not see.
 */
export const CREDENTIAL_CANDIDATE_SOURCES = [
  "platform_setting",
  "judge_credential",
  "judge_configuration",
] as const;
export type CredentialCandidateSource =
  (typeof CREDENTIAL_CANDIDATE_SOURCES)[number];

/**
 * What is *inside* one copied envelope, which is not the same question in every
 * legacy store.
 *
 * **Two stores, two shapes, and finding this out late would have been a broken
 * credential rather than a broken build.** Every credential table in this schema
 * seals a small document, `{ key }`, so that the envelope can grow a field
 * without a format guess. The deployment's own settings seal the value itself,
 * because a platform setting is one value and there was never a second field to
 * name. Both are sealed under the same master key with the same envelope
 * format; what differs is the plaintext they hold.
 *
 * So the shape is recorded with the copy, and it is read exactly once — when a
 * candidate becomes an organization's active credential and has to be written
 * in the shape that store reads. Collection itself opens nothing.
 */
export const CREDENTIAL_ENVELOPE_SHAPES = ["key_document", "bare_value"] as const;
export type CredentialEnvelopeShape =
  (typeof CREDENTIAL_ENVELOPE_SHAPES)[number];

/**
 * One legacy provider key, copied here sealed exactly as it was stored.
 *
 * **Copied rather than moved, and the difference is the compatibility period.**
 * The row it came from keeps working — an old grading plan still resolves its
 * recorded judge credential, and a persona still on the legacy path still reads
 * the deployment's own settings — so the envelope is duplicated byte for byte
 * and nothing is opened to do it. The later cleanup removes the originals.
 *
 * **One row per source, never per secret.** Two sources holding the same key
 * are two candidates here, because deciding they were the same key would mean
 * comparing plaintext, ciphertext or hints — and the specification forbids
 * inferring equality from any of the three. So the arithmetic is deliberately
 * blunt: one candidate for a provider may become that organization's active
 * credential, and two mean an administrator chooses.
 *
 * **`provider` carries no allowed-value check**, unlike every other provider
 * column in this schema. A deployment configured before this release may name
 * a provider this release's catalog does not carry, and refusing the row would
 * throw the record away — leaving nothing to show an administrator and nothing
 * for a later release that adds that provider back to find. What may become
 * *active* is checked where activation happens, against the catalog, so an
 * unusable candidate is recorded and never spendable.
 */
export const modelCredentialCandidate = pgTable(
  "model_credential_candidate",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The provider account this key belongs to, as the legacy row spelled it. */
    provider: text("provider").notNull(),
    /** Which kind of legacy row it came from. See `CREDENTIAL_CANDIDATE_SOURCES`. */
    source: text("source").notNull(),
    /**
     * Which row exactly: the platform setting's name, the judge credential's
     * label, or the project a `platform` judge configuration belongs to. It is
     * what an administrator choosing between two candidates reads, so it has to
     * say more than four characters of a key can.
     */
    sourceName: text("source_name").notNull(),
    /**
     * The sealed envelope, copied verbatim. The same `v1.<iv>.<ciphertext>.
     * <tag>` under the same master key every credential in this schema uses,
     * so nothing was opened to write this and nothing has to be to spend it.
     */
    credentials: text("credentials").notNull(),
    /** The last characters of the key, as the row it came from already held. */
    credentialsHint: text("credentials_hint").notNull(),
    /**
     * What the envelope holds inside. See `CREDENTIAL_ENVELOPE_SHAPES`: the
     * credential stores seal `{ key }` and the deployment's own settings seal
     * the value itself, and a copy that did not record which would be a
     * credential nothing could open.
     */
    shape: text("shape").notNull(),
    /**
     * When this candidate became the organization's active model-provider
     * credential, or null while it has not. Null on every candidate of a
     * provider that had more than one.
     */
    activatedAt: moment("activated_at"),
    createdAt: createdAt(),
  },
  (table) => [
    prefixCheck("model_credential_candidate_id_prefix", table.id, "mcc"),
    oneOf("model_credential_candidate_source_allowed", table.source, [
      ...CREDENTIAL_CANDIDATE_SOURCES,
    ]),
    oneOf("model_credential_candidate_shape_allowed", table.shape, [
      ...CREDENTIAL_ENVELOPE_SHAPES,
    ]),
    /**
     * One candidate per legacy row, which is what makes re-running the upgrade
     * write nothing the second time. The source and its name together name the
     * row it was copied from; the provider is in the key because one platform
     * setting is a key for exactly one provider and one judge credential too.
     */
    unique("model_credential_candidate_one_per_source").on(
      table.organizationId,
      table.provider,
      table.source,
      table.sourceName,
    ),
  ],
);

/**
 * What an administrator has to decide, because the upgrade would not.
 *
 * Each names the act rather than the fault — `select_persona_models` rather
 * than "persona incomplete" — because the sentence beside it already says what
 * went wrong and the word is what the screen draws a link from.
 *
 * - `select_model_provider_credential` — several legacy keys claim one
 *   provider, so none became active. The subject is the provider.
 * - `select_persona_models` — this persona could not receive an explicit
 *   successor: the deployment's settings were incomplete, named a provider this
 *   release does not carry, or its own voice provider disagreed with the
 *   deployment's speaking provider. The subject is the persona.
 * - `select_grader_model` — this grader had no effective legacy model, or one
 *   naming a provider this release does not carry. The subject is the grader.
 * - `set_up_model_access` — this organization is one of several on a
 *   deployment, so nothing deployment-wide was copied into it at all. The
 *   subject is the organization.
 */
export const MODEL_UPGRADE_ACTIONS = [
  "select_model_provider_credential",
  "select_persona_models",
  "select_grader_model",
  "set_up_model_access",
] as const;
export type ModelUpgradeActionKind = (typeof MODEL_UPGRADE_ACTIONS)[number];

/**
 * One thing an administrator has to choose before this organization has left
 * the legacy path, written once by the upgrade and cleared when it is done.
 *
 * **One-time, held by the unique below.** The upgrade runs on every boot, so an
 * action that could be written twice would become a list that grows every time
 * a container restarts. The subject is in the key because one persona's missing
 * selection and another's are two different decisions.
 *
 * **`detail` is Egma's own writing and never a customer's.** It names the model
 * job, the provider and what is missing; it carries no key, no hint and no
 * authored content, so it is safe in a log and safe in a browser.
 */
export const modelUpgradeAction = pgTable(
  "model_upgrade_action",
  {
    id: idText("id").primaryKey(),
    organizationId: idText("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Which decision this is. See `MODEL_UPGRADE_ACTIONS`. */
    kind: text("kind").notNull(),
    /**
     * What it is about: a persona id, a grader id, a provider's name, or the
     * organization's own id. Not a foreign key, because a provider is not a row
     * and because an action outliving a deleted persona is a stale sentence
     * rather than a broken pointer — the read below drops it.
     */
    subject: text("subject").notNull(),
    /** The sentence a person reads. Egma's words, never a secret. */
    detail: text("detail").notNull(),
    /** When somebody finished it, or null while it is still outstanding. */
    resolvedAt: moment("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    prefixCheck("model_upgrade_action_id_prefix", table.id, "mua"),
    oneOf("model_upgrade_action_kind_allowed", table.kind, [
      ...MODEL_UPGRADE_ACTIONS,
    ]),
    unique("model_upgrade_action_one_per_subject").on(
      table.organizationId,
      table.kind,
      table.subject,
    ),
  ],
);
