import { newId } from "@egma/ids";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

import { db, type Transaction } from "../client.ts";
import { managedDeployment } from "../managed-deployment.ts";
import {
  isModelProvider,
  PROVIDERS_BY_JOB,
  type ModelJob,
  type ModelProvider,
} from "../models/catalog.ts";
import type {
  GraderModel,
  PersonaModels,
  SpeechSelection,
} from "../models/selections.ts";
import { newRevision } from "../revisions.ts";
import { grader, graderVersion, judgeConfiguration, judgeCredential } from "../schema/graders.ts";
import { modelAccess, modelProviderCredential } from "../schema/models.ts";
import { persona, personaVersion } from "../schema/personas.ts";
import { platformSetting, type PlatformSettingName } from "../schema/platform.ts";
import { organization, project } from "../schema/tenancy.ts";
import {
  modelCredentialCandidate,
  modelUpgradeAction,
  type CredentialCandidateSource,
  type CredentialEnvelopeShape,
  type ModelUpgradeActionKind,
} from "../schema/upgrade.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { DeploymentTenancy } from "./platform-settings.ts";
import { traitsFromRow } from "./personas.ts";

/**
 * The upgrade that moves an installation configured before the model catalog
 * existed onto explicit persona and grader selections — additively, without
 * rewriting one line of history.
 *
 * **It is a boot act rather than a statement in a migration file, and the
 * reason is what it has to do.** It copies sealed envelopes between tables,
 * mints persona and grader versions through the same rules an edit does, reads
 * a persona's own voice against a deployment-wide speaking provider, and writes
 * sentences a person has to be able to act on. None of that is SQL anybody
 * could test a case at a time, and all of it has to be idempotent because a
 * deployment runs it on every start.
 *
 * **The whole of what it will not do is as important as what it does.** It
 * never invents a provider, a model, a voice or a speed. It never compares two
 * secrets to decide they are the same key. It never copies a deployment-wide
 * key or selection into more than one organization. Where the answer is not
 * unambiguous it writes an *action* — one sentence naming what an administrator
 * has to choose — and leaves the legacy path working exactly as it was.
 *
 * **Nothing here is a cleanup.** Every legacy row stays: the deployment's own
 * settings, the judge credentials, the project judge configurations, the old
 * versions and the old work orders. That is what makes the compatibility period
 * real, and removing them is the next release's job, gated on the completion
 * marker this file also writes.
 */

/**
 * What the upgrade did, for the boot log. Identifiers and provider names only —
 * no key, no hint, and nothing a customer authored.
 */
export type ModelUpgradeReport = {
  /** Organizations a hosted deployment wrote managed access for. */
  readonly managedAccess: readonly string[];
  /** Legacy keys copied in as candidates, by their new `mcc_` ids. */
  readonly candidates: readonly string[];
  /** Providers whose sole candidate became the active credential. */
  readonly activated: readonly string[];
  /** Personas given an explicit successor version. */
  readonly personas: readonly string[];
  /** Graders given an explicit successor version. */
  readonly graders: readonly string[];
  /** Decisions left for an administrator, as kind and subject. */
  readonly actions: readonly {
    readonly kind: ModelUpgradeActionKind;
    readonly subject: string;
  }[];
};

/**
 * What this act is locked on: this deployment, and nothing narrower.
 *
 * `seedRunningGraders`' lock, for its reason. The reads that decide what to
 * write span every organization, persona and grader, so two replicas holding
 * two finer locks would still both read "nothing has been upgraded" and both
 * write.
 */
export const UPGRADING_MODEL_SETUP = "egma:upgrade-model-setup";

/**
 * The one grader type that asks a model at all.
 *
 * A `code` grader computes its answer and speaks to nobody, so it has no legacy
 * judge to move across and nothing an explicit selection would decide. Leaving
 * it out is what keeps the completion marker reachable on a deployment whose
 * latency graders would otherwise wait forever for a model they never use.
 */
const JUDGED = "llm_as_judge";

/**
 * Which catalog provider a legacy word means, where this release carries one.
 *
 * **A map rather than a guess, and the absences are the interesting half.**
 *
 * - `openai_realtime` is the transport this release's OpenAI listening entry
 *   *is*, so a deployment on it moves across unchanged.
 * - Legacy `openai` **listening** is the segmented `audio/transcriptions`
 *   endpoint, which this release deliberately does not ship — the catalog
 *   carries the realtime socket instead, and the two take different model ids.
 *   Moving one to the other would be a substitution nobody asked for, arriving
 *   as a provider refusal on somebody's first simulation. So it is absent, and
 *   a persona on it keeps the legacy path and gets an action.
 * - `elevenlabs` speaking is not in this release's catalog at all. Deferred
 *   rather than cancelled — and until it returns, a persona on it keeps the
 *   legacy path and gets an action saying so. No substitute is chosen: another
 *   company's voice is not this persona's voice.
 * - `scripted` is the deterministic test provider. It is not an account
 *   anybody holds and it is not selectable from the catalog, so it cannot be
 *   migrated into one.
 */
const CATALOG_PROVIDER: Readonly<Record<ModelJob, Readonly<Record<string, ModelProvider>>>> = {
  llm: { openai: "openai" },
  stt: { deepgram: "deepgram", openai_realtime: "openai" },
  tts: { cartesia: "cartesia", openai: "openai" },
};

/** The provider a legacy word names for this job, or `undefined`. */
function catalogProviderFor(job: ModelJob, legacy: string): ModelProvider | undefined {
  const mapped = CATALOG_PROVIDER[job][legacy];
  if (mapped === undefined) return undefined;
  // Belt and braces: the map is release data and the catalog is release data,
  // and a pair that fell out of one but not the other must not become visible.
  return PROVIDERS_BY_JOB[job].some((entry) => entry.provider === mapped)
    ? mapped
    : undefined;
}

/**
 * Where each legacy key lives, and which model job's provider setting names the
 * account it belongs to.
 *
 * The judge's keys are not here because they are not deployment settings — they
 * are collected from their own tables below.
 */
const SETTING_KEYS: readonly {
  readonly key: PlatformSettingName;
  readonly provider: PlatformSettingName;
  readonly job: ModelJob;
}[] = [
  { key: "persona_model_key", provider: "persona_model_provider", job: "llm" },
  { key: "speech_to_text_key", provider: "speech_to_text_provider", job: "stt" },
  { key: "text_to_speech_key", provider: "text_to_speech_provider", job: "tts" },
];

/** The settings this upgrade reads, by name, with their stored hints. */
type Settings = ReadonlyMap<
  string,
  { readonly value: string; readonly hint: string; readonly changedAt: Date }
>;

/**
 * A non-secret setting's whole value, read off its hint.
 *
 * **The hint *is* the value for anything that is not a secret**, which the
 * platform settings table says in as many words, so a provider name, a model id
 * and a voice id are all readable without opening one envelope. That is worth
 * saying out loud: this upgrade never unseals anything, including the values it
 * copies, and it could not compare two keys even if it wanted to.
 */
function plain(settings: Settings, name: PlatformSettingName): string | undefined {
  const held = settings.get(name)?.hint.trim();
  return held === undefined || held === "" ? undefined : held;
}

export async function upgradeModelSetup(
  deployment: DeploymentTenancy,
): Promise<ModelUpgradeReport> {
  return db().transaction(async (tx) => {
    // Taken before anything is read, so the replica that arrives second waits
    // here and then finds every decision already made.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${UPGRADING_MODEL_SETUP}::text, 0))`,
    );

    const organizations = await tx
      .select({ id: organization.id })
      .from(organization)
      .orderBy(organization.id);

    const managed = await grantHostedManagedAccess(tx, organizations);

    /**
     * Whether deployment-wide configuration may be copied into an organization
     * at all.
     *
     * **Both halves, and the second is not redundant.** The flag is what the
     * deployment declares itself to be; the count is what is actually in the
     * database. A deployment left on the single-organization flag that has
     * somehow grown a second organization must not copy one team's provider key
     * into another team's — so the count decides, and the flag alone never
     * does.
     */
    const single =
      deployment.singleOrganization && organizations.length === 1
        ? organizations[0]?.id
        : undefined;

    if (single === undefined) {
      const actions = await noticeEveryOrganization(tx, organizations);
      await settleFinishedActions(tx);
      return {
        managedAccess: managed,
        candidates: [],
        activated: [],
        personas: [],
        graders: [],
        actions,
      };
    }

    const settings = await readSettings(tx);
    const collected = await collectCandidates(tx, single, settings);
    const chosen = await activateSoleCandidates(tx, single);
    const personas = await upgradePersonas(tx, single, settings);
    const graders = await upgradeGraders(tx, single);

    await settleFinishedActions(tx);

    return {
      managedAccess: managed,
      candidates: collected,
      activated: chosen.activated,
      personas: personas.upgraded,
      graders: graders.upgraded,
      actions: [...chosen.actions, ...personas.actions, ...graders.actions],
    };
  });
}

/**
 * On hosted Egma, give every organization that has never chosen the access its
 * deployment operates.
 *
 * **Who pays is the deployment's own policy, and this is the one thing about it
 * that was left half-applied.** Hosted Egma already writes `managed` on every
 * organization it provisions, so an organization created the day before this
 * release reads `customer-owned` while the one created the day after reads
 * `managed` — two answers to a question the deployment, not the customer,
 * decides. It matters beyond tidiness: the mandatory grading backfill seeds a
 * hosted project's expected-behaviors copy with the release's proved model, and
 * a project whose organization reads `customer-owned` would resolve that
 * selection against a credential nobody stored and write `errored` verdicts for
 * it.
 *
 * **It copies no secret and no model selection**, so it is not the backfill the
 * specification forbids across several organizations: nothing deployment-wide
 * moves into anybody's rows, and every persona and grader keeps exactly the
 * selections it had.
 *
 * **Nothing happens on a self-hosted deployment**, which has no provider
 * accounts of Egma's to spend and must connect an inference key first. And
 * nothing happens on a hosted deployment that has not been switched on: the
 * hosted flag is unset in production, so this is inert there until a human
 * turns managed access on.
 */
async function grantHostedManagedAccess(
  tx: Transaction,
  organizations: readonly { readonly id: string }[],
): Promise<readonly string[]> {
  if (!managedDeployment().hosted) return [];
  if (organizations.length === 0) return [];

  const written = await tx
    .insert(modelAccess)
    .values(
      organizations.map((one) => ({
        organizationId: one.id,
        mode: "managed" as const,
        // Nobody: the deployment decided this, and no administrator asked.
        updatedBy: null,
      })),
    )
    // An organization that has chosen keeps its choice — including one that
    // deliberately chose customer-owned on hosted Egma.
    .onConflictDoNothing({ target: modelAccess.organizationId })
    .returning({ id: modelAccess.organizationId });

  return written.map((row) => row.id);
}

/**
 * The visible action for every organization on a deployment that copies nothing
 * into it.
 *
 * A deployment serving several customers holds one set of model settings and
 * one platform judge key, and there is no organization they belong to. So
 * nothing is backfilled, existing work stays on the compatibility path, and
 * each organization whose personas or graders still lack selections is told —
 * once — that it has to choose.
 */
async function noticeEveryOrganization(
  tx: Transaction,
  organizations: readonly { readonly id: string }[],
): Promise<readonly { readonly kind: ModelUpgradeActionKind; readonly subject: string }[]> {
  const written: { kind: ModelUpgradeActionKind; subject: string }[] = [];
  for (const one of organizations) {
    if (!(await stillOnTheLegacyPath(tx, one.id))) continue;
    await recordAction(tx, one.id, "set_up_model_access", one.id, [
      "This deployment serves several organizations, so Egma copied no",
      "deployment-wide provider key or model choice into this one. Choose",
      "Managed by Egma, or add this organization's own provider credentials,",
      "and select the models for its personas and graders.",
    ].join(" "));
    written.push({ kind: "set_up_model_access", subject: one.id });
  }
  return written;
}

async function stillOnTheLegacyPath(
  tx: Transaction,
  organizationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ found: sql<number>`1` })
    .from(persona)
    .innerJoin(personaVersion, eq(persona.currentVersionId, personaVersion.id))
    .where(
      and(
        eq(persona.organizationId, organizationId),
        isNull(personaVersion.models),
      ),
    )
    .limit(1);
  if (row !== undefined) return true;

  const [judged] = await tx
    .select({ found: sql<number>`1` })
    .from(grader)
    .innerJoin(graderVersion, eq(grader.currentVersionId, graderVersion.id))
    .where(
      and(
        eq(grader.organizationId, organizationId),
        eq(grader.type, JUDGED),
        isNull(grader.deletedAt),
        isNull(graderVersion.graderModel),
      ),
    )
    .limit(1);
  return judged !== undefined;
}

async function readSettings(tx: Transaction): Promise<Settings> {
  const rows = await tx
    .select({
      name: platformSetting.name,
      value: platformSetting.value,
      hint: platformSetting.hint,
      changedAt: platformSetting.updatedAt,
    })
    .from(platformSetting);
  return new Map(
    rows.map((row) => [
      row.name,
      { value: row.value, hint: row.hint, changedAt: row.changedAt },
    ]),
  );
}

/**
 * Every place a legacy provider key could be, copied here sealed.
 *
 * **Three sources, and the specification names all three**: the deployment's
 * own model, listening and speaking keys; the organization's judge credentials;
 * and a project judge configuration that still *owns* a key rather than
 * pointing at one. A configuration that points at a judge credential is not a
 * fourth source — the credential it points at is already the second — and
 * treating it as one would manufacture a second candidate for a provider that
 * really has one, which is exactly the arithmetic that decides whether anything
 * activates.
 *
 * **The envelope is copied byte for byte and nothing is opened.** That is what
 * keeps the old references working through the compatibility period, and it is
 * why this can run with no ability to tell two keys apart.
 */
async function collectCandidates(
  tx: Transaction,
  organizationId: string,
  settings: Settings,
): Promise<readonly string[]> {
  const found: {
    provider: string;
    source: CredentialCandidateSource;
    sourceName: string;
    credentials: string;
    credentialsHint: string;
    shape: CredentialEnvelopeShape;
    /** The source row's own `updated_at`, which is how a rotation is noticed. */
    sourceChangedAt: Date;
  }[] = [];

  for (const { key, provider, job } of SETTING_KEYS) {
    const sealed = settings.get(key);
    const named = plain(settings, provider);
    if (sealed === undefined || named === undefined) continue;
    found.push({
      // The catalog's word where this release carries the pair, and the legacy
      // word where it does not. Recording the legacy word rather than dropping
      // the row keeps the key findable — by an administrator today, and by the
      // release that adds that provider back.
      provider: catalogProviderFor(job, named) ?? named,
      source: "platform_setting",
      sourceName: key,
      credentials: sealed.value,
      credentialsHint: sealed.hint,
      // A platform setting seals the value itself. Recorded rather than
      // converted, so nothing is opened while the keys are being collected.
      shape: "bare_value",
      sourceChangedAt: sealed.changedAt,
    });
  }

  const credentials = await tx
    .select({
      label: judgeCredential.label,
      provider: judgeCredential.provider,
      credentials: judgeCredential.credentials,
      hint: judgeCredential.credentialsHint,
      changedAt: judgeCredential.updatedAt,
    })
    .from(judgeCredential)
    .where(
      and(
        eq(judgeCredential.organizationId, organizationId),
        isNull(judgeCredential.archivedAt),
      ),
    )
    .orderBy(judgeCredential.label);
  for (const row of credentials) {
    found.push({
      provider: catalogProviderFor("llm", row.provider) ?? row.provider,
      source: "judge_credential",
      sourceName: row.label,
      credentials: row.credentials,
      credentialsHint: row.hint,
      shape: "key_document",
      sourceChangedAt: row.changedAt,
    });
  }

  const platformJudges = await tx
    .select({
      projectId: judgeConfiguration.projectId,
      provider: judgeConfiguration.provider,
      credentials: judgeConfiguration.credentials,
      hint: judgeConfiguration.credentialsHint,
      changedAt: judgeConfiguration.updatedAt,
    })
    .from(judgeConfiguration)
    .where(
      and(
        eq(judgeConfiguration.organizationId, organizationId),
        eq(judgeConfiguration.source, "platform"),
      ),
    )
    .orderBy(judgeConfiguration.projectId);
  for (const row of platformJudges) {
    if (row.credentials === null) continue;
    found.push({
      provider: catalogProviderFor("llm", row.provider) ?? row.provider,
      source: "judge_configuration",
      sourceName: row.projectId,
      credentials: row.credentials,
      credentialsHint: row.hint ?? "",
      shape: "key_document",
      sourceChangedAt: row.changedAt,
    });
  }

  if (found.length === 0) return [];

  const written = await tx
    .insert(modelCredentialCandidate)
    .values(
      found.map((one) => ({
        id: newId("mcc"),
        organizationId,
        provider: one.provider,
        source: one.source,
        sourceName: one.sourceName,
        credentials: one.credentials,
        credentialsHint: one.credentialsHint,
        shape: one.shape,
        sourceChangedAt: one.sourceChangedAt,
      })),
    )
    /**
     * The source row is the identity, and the copy **tracks** it.
     *
     * A key rotated in its original row is not a new candidate — it is the same
     * source saying something different — so the copy is refreshed rather than
     * discarded. Discarding it was the fault: `writePlatformSettings` and
     * `editJudgeCredential` are both open during the compatibility period, so
     * an operator really can rotate one, and a copy frozen at the old value
     * left this organization spending a key that had been revoked.
     *
     * **Guarded by the source's own clock, and by the safe hint beside it.**
     *
     * The clock is the main answer: the source says when it last changed and
     * the copy remembers when it was taken. What it cannot answer alone is a
     * rotation landing on the *same stamp* as the write the copy recorded — and
     * that is far likelier than the column suggests, because every writer of
     * these rows passes a JavaScript `Date`. `timestamptz` holds microseconds;
     * a `Date` carries milliseconds, so the last three digits of every one of
     * these stamps are zero and the real granularity is a millisecond. Two
     * writes inside one millisecond compare equal, a strict `<` matches
     * nothing, and the copy silently keeps a key that has been revoked.
     *
     * So the hint is asked as well. **This is not the comparison the
     * specification forbids.** That rule is about deciding whether two
     * *different sources* hold one account's key — inferring equality between
     * two secrets nobody may read. This compares one copy against its own
     * origin, on the four characters already published to every browser that
     * draws the Model providers screen, to answer "has this row been
     * rewritten". No secret is read and no two keys are equated.
     *
     * A ciphertext comparison would answer the same question and is still
     * refused: the seal is nonced, so two writes of one key differ, and it
     * would report "changed" on every boot and rewrite every row forever.
     *
     * **Where a rotation collides on both the millisecond and the last four
     * characters, this copy stays behind until the next write moves either.**
     * A stated residue rather than a claim of completeness — and far better
     * than a `>=`, which would rewrite every row on every restart and make
     * "when the stored key last changed" mean nothing.
     */
    .onConflictDoUpdate({
      target: [
        modelCredentialCandidate.organizationId,
        modelCredentialCandidate.provider,
        modelCredentialCandidate.source,
        modelCredentialCandidate.sourceName,
      ],
      set: {
        credentials: sql`excluded.credentials`,
        credentialsHint: sql`excluded.credentials_hint`,
        shape: sql`excluded.shape`,
        sourceChangedAt: sql`excluded.source_changed_at`,
      },
      setWhere: sql`${modelCredentialCandidate.sourceChangedAt} < excluded.source_changed_at
        or ${modelCredentialCandidate.credentialsHint} <> excluded.credentials_hint`,
    })
    .returning({ id: modelCredentialCandidate.id });

  return written.map((row) => row.id);
}

/**
 * A provider with exactly one candidate gets that key as the organization's
 * active credential. A provider with two gets an action instead.
 *
 * **The rule is a count and never a comparison.** Two sources holding the same
 * key are two candidates here, because deciding they were one would mean
 * reading a plaintext, a ciphertext or a hint as evidence of equality, and none
 * of the three is evidence of anything: two envelopes of one key differ, two
 * hints of two different keys can match, and the plaintext is not a thing this
 * upgrade may open. So Egma counts, and where it cannot be sure it asks.
 *
 * **A credential an administrator already stored is never overwritten.** They
 * chose it after this release shipped, which is a later and better answer than
 * anything a legacy row can offer.
 */
async function activateSoleCandidates(
  tx: Transaction,
  organizationId: string,
): Promise<{
  readonly activated: readonly string[];
  readonly actions: readonly { readonly kind: ModelUpgradeActionKind; readonly subject: string }[];
}> {
  const candidates = await tx
    .select({
      id: modelCredentialCandidate.id,
      provider: modelCredentialCandidate.provider,
      credentials: modelCredentialCandidate.credentials,
      hint: modelCredentialCandidate.credentialsHint,
      shape: modelCredentialCandidate.shape,
      sourceChangedAt: modelCredentialCandidate.sourceChangedAt,
      activatedAt: modelCredentialCandidate.activatedAt,
    })
    .from(modelCredentialCandidate)
    .where(eq(modelCredentialCandidate.organizationId, organizationId))
    .orderBy(modelCredentialCandidate.id);

  const byProvider = new Map<string, typeof candidates>();
  for (const one of candidates) {
    byProvider.set(one.provider, [...(byProvider.get(one.provider) ?? []), one]);
  }

  const activated: string[] = [];
  const actions: { kind: ModelUpgradeActionKind; subject: string }[] = [];

  /**
   * A rotated source reaches the credential that is tracking it, whatever else
   * is true of its provider.
   *
   * **Keyed on provenance and on nothing else**, which is what makes it safe to
   * do before any of the rules below: the credential names the one candidate it
   * follows, so a provider with two stored keys is not ambiguous here even
   * though it is ambiguous for *activation*. A credential an administrator
   * typed holds null and is unreachable from this statement.
   *
   * Guarded by when the source last moved **or** by its safe hint differing, so
   * a boot that rotated nothing leaves `updated_at` alone — a person reads it
   * as "when the stored key last changed" — while a rotation that landed on the
   * same millisecond as this row's last write is still noticed. See the
   * collection above for why a millisecond is the real granularity here, and
   * why asking the hint is not the comparison the specification forbids.
   */
  for (const candidate of candidates) {
    if (candidate.activatedAt === null) continue;
    if (!isModelProvider(candidate.provider)) continue;

    let envelope: string;
    try {
      envelope = asACredential(candidate);
    } catch {
      continue;
    }

    const [rotated] = await tx
      .update(modelProviderCredential)
      .set({
        credentials: envelope,
        credentialsHint: candidate.hint,
        revision: newId("rev"),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(modelProviderCredential.organizationId, organizationId),
          eq(modelProviderCredential.upgradedFrom, candidate.id),
          or(
            lt(modelProviderCredential.updatedAt, candidate.sourceChangedAt),
            ne(modelProviderCredential.credentialsHint, candidate.hint),
          ),
        ),
      )
      .returning({ id: modelProviderCredential.id });

    if (rotated !== undefined) activated.push(candidate.provider);
  }

  for (const [provider, forProvider] of [...byProvider].sort()) {
    /**
     * A provider this release's catalog does not carry, and the reason this
     * check is *after* the count rather than before it.
     *
     * There is no credential row such a key could become, so it cannot be
     * activated and cannot be chosen between. But it was configured, it is
     * still stored, and saying nothing about it is exactly the silence this
     * whole section exists to break: the deployment would keep speaking through
     * a provider the product no longer offers, and the only sign would be the
     * persona actions naming it. So it gets an action of its own, naming the
     * catalog, and the screen shows its key as kept and unusable.
     */
    if (!isModelProvider(provider)) {
      await recordAction(
        tx,
        organizationId,
        "select_model_provider_credential",
        provider,
        `This installation holds a stored ${provider} key, and ${provider} is not a provider in this release's model catalog — so Egma cannot use it and will not choose a substitute for it. Store a key for a provider this release carries under Model providers.`,
      );
      actions.push({ kind: "select_model_provider_credential", subject: provider });
      continue;
    }

    if (forProvider.length > 1) {
      await recordAction(
        tx,
        organizationId,
        "select_model_provider_credential",
        provider,
        `Egma found ${forProvider.length} stored ${provider} keys on this installation and cannot tell whether they are the same account, so none was activated. Choose which one this organization uses, or store a replacement, under Model providers.`,
      );
      actions.push({ kind: "select_model_provider_credential", subject: provider });
      continue;
    }

    const [sole] = forProvider;
    if (sole === undefined) continue;

    /**
     * A stored key that will not open stops this provider and nothing else.
     *
     * The alternative is a boot that throws, and a deployment that will not
     * start because one legacy row is corrupt is a worse answer than a
     * deployment that starts and says which provider needs a key typed again.
     * An administrator choosing a candidate by hand is told loudly instead —
     * they asked about this exact key, so the refusal belongs in their answer.
     */
    let envelope: string;
    try {
      envelope = asACredential(sole);
    } catch {
      await recordAction(
        tx,
        organizationId,
        "select_model_provider_credential",
        provider,
        `Egma could not read the stored ${provider} key it found on this installation, so nothing was activated for it. Store a ${provider} key again under Model providers.`,
      );
      actions.push({ kind: "select_model_provider_credential", subject: provider });
      continue;
    }

    /**
     * **Activation happens once per candidate, and only once.**
     *
     * A candidate already stamped is never inserted again. That is what stops
     * an administrator who *removed* the credential being overruled by the next
     * restart putting it back — the row is gone, the stamp says the upgrade has
     * already had its turn, and their removal stands. Keeping such a credential
     * *current* is the refresh above, which needs the row to still be there and
     * to still be tracking this candidate.
     */
    if (sole.activatedAt !== null) continue;

    const [written] = await tx
      .insert(modelProviderCredential)
      .values({
        id: newId("mpc"),
        organizationId,
        provider,
        credentials: envelope,
        credentialsHint: sole.hint,
        revision: newId("rev"),
        // Which stored key this credential is following, so a rotation of that
        // source can find it again and an administrator's own key never can be
        // found this way at all.
        upgradedFrom: sole.id,
        createdBy: null,
      })
      .onConflictDoNothing({
        target: [
          modelProviderCredential.organizationId,
          modelProviderCredential.provider,
        ],
      })
      .returning({ id: modelProviderCredential.id });

    if (written === undefined) continue;

    await tx
      .update(modelCredentialCandidate)
      .set({ activatedAt: new Date() })
      .where(eq(modelCredentialCandidate.id, sole.id));
    activated.push(provider);
  }

  return { activated, actions };
}

/**
 * One candidate's envelope, in the shape the credential store reads — and
 * checked, once, on the way through.
 *
 * **This is the one place the upgrade opens a secret, and it opens it to *use*
 * it rather than to learn anything about it.** A credential sealed by the judge
 * or credential stores already holds `{ key }` and is copied across untouched;
 * a deployment setting seals the value itself, so becoming a credential means
 * being written in the credential store's shape, which cannot be done without
 * the plaintext however briefly.
 *
 * **It opens both shapes, and that is deliberate rather than wasteful.** A
 * `key_document` needs no conversion, but an envelope that will not open is a
 * credential that fails at the first simulation that selects its provider —
 * hours or days after somebody chose it, with a message about grading rather
 * than about the choice they made. Opening it here moves that failure to the
 * moment of the choice, where it can be answered.
 *
 * Opened exactly once. Nothing is compared, nothing is logged, and nothing is
 * returned but the envelope: the plaintext exists for the length of one check
 * and one re-seal.
 */
export function asACredential(candidate: {
  readonly credentials: string;
  readonly shape: string;
}): string {
  const opened = openCredentials(candidate.credentials);

  if (candidate.shape === "key_document") {
    const held =
      typeof opened === "object" && opened !== null && !Array.isArray(opened)
        ? (opened as Record<string, unknown>)["key"]
        : undefined;
    if (typeof held !== "string" || held === "") {
      throw new Error(
        "a stored credential did not hold a key this upgrade could make an organization credential of; the row needs repairing before it can be used",
      );
    }
    // Unchanged, because it is already what the credential store reads. The
    // open above was the check, and the envelope that lands is the one that was
    // already there — so nothing is re-sealed and nothing moves.
    return candidate.credentials;
  }

  if (typeof opened !== "string" || opened === "") {
    throw new Error(
      "a stored deployment setting did not hold a value this upgrade could make a credential of; the row needs repairing before it can be used",
    );
  }
  return sealCredentials({ key: opened });
}

/** Why one persona could not be given an explicit successor. */
type Blocked = { readonly blocked: string };

function isBlocked(value: unknown): value is Blocked {
  return typeof value === "object" && value !== null && "blocked" in value;
}

/**
 * The three selections a persona's successor version carries, worked out from
 * the deployment's settings and the persona's own voice — or the sentence
 * saying why there is no unambiguous answer.
 *
 * **The voice precedence is the specification's, and the conflict case is the
 * whole reason it is written down.** A persona's versioned voice is what that
 * persona *sounds like*, so its provider, id and speed win outright. The
 * deployment supplies a voice only where the persona has none. And where the
 * persona's voice provider disagrees with the deployment's speaking provider,
 * there is no answer that is not a guess — one of the two is about to change,
 * and Egma is not the one who should decide which — so the persona keeps the
 * legacy path and somebody chooses.
 *
 * **The legacy reasoning-effort setting is deliberately not read here.** It is
 * not part of what a persona selects, and a successor carrying it would be a
 * new version writing down a field this release retired.
 */
function selectionsFor(
  settings: Settings,
  /**
   * The persona's own voice, which every persona has.
   *
   * **Required rather than optional, because the traits say so.** A version's
   * `voice` is a written trait with a provider, an id and a speed, and the
   * shape guard refuses a row without one — so a fallback to the deployment's
   * voice here would be a branch nothing could reach, and an unreachable branch
   * reads as a rule that exists. The specification's "the deployment supplies a
   * voice only when the persona has none" is satisfied by there being no such
   * persona.
   */
  voice: { readonly provider: string; readonly voiceId: string; readonly speed: number },
): PersonaModels | Blocked {
  const llmProvider = plain(settings, "persona_model_provider");
  const llmModel = plain(settings, "persona_model");
  const sttProvider = plain(settings, "speech_to_text_provider");
  const sttModel = plain(settings, "speech_to_text_model");
  const ttsProvider = plain(settings, "text_to_speech_provider");
  const ttsModel = plain(settings, "text_to_speech_model");

  const missing = [
    llmProvider === undefined ? "a model provider" : undefined,
    llmModel === undefined ? "a model" : undefined,
    sttProvider === undefined ? "a speech-to-text provider" : undefined,
    sttModel === undefined ? "a speech-to-text model" : undefined,
    ttsProvider === undefined ? "a text-to-speech provider" : undefined,
    ttsModel === undefined ? "a text-to-speech model" : undefined,
  ].filter((one): one is string => one !== undefined);
  if (
    llmProvider === undefined ||
    llmModel === undefined ||
    sttProvider === undefined ||
    sttModel === undefined ||
    ttsProvider === undefined ||
    ttsModel === undefined
  ) {
    return {
      blocked: `this deployment's settings name ${missing.join(", ")} nowhere, so Egma could not work out what this persona thinks, listens and speaks with. Select its models under Persona models.`,
    };
  }

  const llm = catalogProviderFor("llm", llmProvider);
  if (llm === undefined) return { blocked: notCarried("thinks with", llmProvider) };
  const stt = catalogProviderFor("stt", sttProvider);
  if (stt === undefined) return { blocked: notCarried("listens with", sttProvider) };

  if (voice.provider !== ttsProvider) {
    return {
      blocked: `this persona's own voice is ${voice.provider} and this deployment speaks with ${ttsProvider}. Egma will not choose between them. Select this persona's text-to-speech provider, model and voice under Persona models.`,
    };
  }
  const tts = catalogProviderFor("tts", voice.provider);
  if (tts === undefined) return { blocked: notCarried("speaks with", voice.provider) };

  // The persona's own voice and its own pace, which is the precedence written
  // down: what a persona sounds like is the persona's, not the deployment's.
  const speech: SpeechSelection = {
    provider: tts,
    model: ttsModel,
    voiceId: voice.voiceId,
    speed: voice.speed,
  };

  return {
    llm: { provider: llm, model: llmModel },
    stt: { provider: stt, model: sttModel },
    tts: speech,
  };
}

function notCarried(doing: string, provider: string): string {
  return `this deployment ${doing} ${provider}, which is not a provider in this release's model catalog, so Egma will not choose a substitute for it. Select a provider this release carries under Persona models.`;
}

/**
 * Every current persona still on the compatibility path, given one explicit
 * successor version — or one sentence saying why it could not have one.
 *
 * **One new version, and the old ones are not touched.** A run that pinned last
 * week's version keeps meaning what it meant, and the successor is the whole
 * persona as the next simulation will meet it: the same traits, plus what it
 * thinks, listens and speaks with, written down.
 *
 * **Only personas whose *current* version lacks selections**, which is what
 * makes running this twice write nothing the second time: after the first run
 * the current version has them, so the second finds nothing to do.
 */
async function upgradePersonas(
  tx: Transaction,
  organizationId: string,
  settings: Settings,
): Promise<{
  readonly upgraded: readonly string[];
  readonly actions: readonly { readonly kind: ModelUpgradeActionKind; readonly subject: string }[];
}> {
  const waiting = await tx
    .select({
      id: persona.id,
      versionId: personaVersion.id,
      version: personaVersion.version,
      traits: personaVersion.traits,
    })
    .from(persona)
    .innerJoin(personaVersion, eq(persona.currentVersionId, personaVersion.id))
    .where(
      and(
        eq(persona.organizationId, organizationId),
        isNull(personaVersion.models),
      ),
    )
    .orderBy(persona.id);

  const upgraded: string[] = [];
  const actions: { kind: ModelUpgradeActionKind; subject: string }[] = [];

  for (const one of waiting) {
    const traits = traitsFromRow(one.traits, one.versionId);
    const selections = selectionsFor(settings, traits.voice);
    if (isBlocked(selections)) {
      await recordAction(
        tx,
        organizationId,
        "select_persona_models",
        one.id,
        selections.blocked,
      );
      actions.push({ kind: "select_persona_models", subject: one.id });
      continue;
    }

    const versionId = newId("prsv");
    await tx.insert(personaVersion).values({
      id: versionId,
      personaId: one.id,
      version: one.version + 1,
      // The traits verbatim, including the legacy voice fields. Nothing reads
      // those once a version carries selections — the speaking selection is the
      // one source — and rewriting them would be an upgrade editing content
      // somebody wrote.
      traits: one.traits,
      models: selections,
      // Nobody: Egma wrote this, and the persona's author did not ask for it.
      createdBy: null,
    });
    await tx
      .update(persona)
      .set({ currentVersionId: versionId, revision: newRevision(), updatedAt: new Date() })
      .where(eq(persona.id, one.id));
    upgraded.push(one.id);
  }

  return { upgraded, actions };
}

/**
 * Every current grader still on the compatibility path, given one explicit
 * successor version — or one sentence saying why it could not have one.
 *
 * **The per-grader override wins.** A grader that named its own judge model
 * said, in as many words, that the project's default was not the model it
 * wanted; carrying the project's over it would silently change what that check
 * is judged by. Where the grader named none, the project's judge configuration
 * is what it was effectively running on, and that is what moves across.
 *
 * **The successor names no `judge_model`.** It carries a complete selection
 * that is never overridden by anything, so keeping the old override beside it
 * would be a field nothing reads on a version somebody has to interpret.
 */
async function upgradeGraders(
  tx: Transaction,
  organizationId: string,
): Promise<{
  readonly upgraded: readonly string[];
  readonly actions: readonly { readonly kind: ModelUpgradeActionKind; readonly subject: string }[];
}> {
  const waiting = await tx
    .select({
      id: grader.id,
      projectId: grader.projectId,
      versionId: graderVersion.id,
      version: graderVersion.version,
      config: graderVersion.config,
      judgeModel: graderVersion.judgeModel,
      judgeProvider: judgeConfiguration.provider,
      judgeConfigured: judgeConfiguration.model,
    })
    .from(grader)
    .innerJoin(graderVersion, eq(grader.currentVersionId, graderVersion.id))
    .leftJoin(judgeConfiguration, eq(grader.projectId, judgeConfiguration.projectId))
    .where(
      and(
        eq(grader.organizationId, organizationId),
        // A code grader asks no model, so a selection on it would decide
        // nothing. It is not on a legacy path — it was never on a model path
        // at all — so it neither gains a successor nor holds up the marker.
        eq(grader.type, JUDGED),
        isNull(grader.deletedAt),
        isNull(graderVersion.graderModel),
      ),
    )
    .orderBy(grader.id);

  const upgraded: string[] = [];
  const actions: { kind: ModelUpgradeActionKind; subject: string }[] = [];

  for (const one of waiting) {
    const override = overrideFrom(one.judgeModel);
    const effective =
      override ??
      (one.judgeProvider === null || one.judgeConfigured === null
        ? undefined
        : { provider: one.judgeProvider, model: one.judgeConfigured });

    if (effective === undefined) {
      await recordAction(
        tx,
        organizationId,
        "select_grader_model",
        one.id,
        "this grader names no model of its own and its project has no judge configured, so Egma could not work out what judges it. Select its model under Grader model.",
      );
      actions.push({ kind: "select_grader_model", subject: one.id });
      continue;
    }

    const provider = catalogProviderFor("llm", effective.provider);
    if (provider === undefined) {
      await recordAction(
        tx,
        organizationId,
        "select_grader_model",
        one.id,
        `this grader judges with ${effective.provider}, which is not a provider in this release's model catalog, so Egma will not choose a substitute for it. Select a provider this release carries under Grader model.`,
      );
      actions.push({ kind: "select_grader_model", subject: one.id });
      continue;
    }

    const model: GraderModel = { provider, model: effective.model };
    const versionId = newId("grv");
    await tx.insert(graderVersion).values({
      id: versionId,
      graderId: one.id,
      version: one.version + 1,
      config: one.config,
      judgeModel: null,
      graderModel: model,
      createdBy: null,
    });
    await tx
      .update(grader)
      .set({ currentVersionId: versionId, updatedAt: new Date() })
      .where(eq(grader.id, one.id));
    upgraded.push(one.id);
  }

  return { upgraded, actions };
}

/** The stored `judge_model` override, or nothing where the row holds none. */
function overrideFrom(
  value: unknown,
): { readonly provider: string; readonly model: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const held = value as Record<string, unknown>;
  const { provider, model } = held;
  return typeof provider === "string" && typeof model === "string"
    ? { provider, model }
    : undefined;
}

/**
 * One decision left for an administrator, written once.
 *
 * Re-writing the same one refreshes its sentence and re-opens it if it had been
 * settled, because a subject that has fallen back onto the legacy path really
 * is outstanding again. The identity is the subject rather than the row, so the
 * list does not grow every time a container starts.
 */
async function recordAction(
  tx: Transaction,
  organizationId: string,
  kind: ModelUpgradeActionKind,
  subject: string,
  detail: string,
): Promise<void> {
  await tx
    .insert(modelUpgradeAction)
    .values({ id: newId("mua"), organizationId, kind, subject, detail })
    .onConflictDoUpdate({
      target: [
        modelUpgradeAction.organizationId,
        modelUpgradeAction.kind,
        modelUpgradeAction.subject,
      ],
      set: { detail, resolvedAt: null, updatedAt: new Date() },
      /**
       * Only where something really moved.
       *
       * **Without this the row is rewritten on every boot**, and a container
       * that restarts twice an hour would carry an `updated_at` that says the
       * decision arrived minutes ago and a `resolved_at` that was cleared for
       * no reason. The timestamps are the only record of when Egma first asked
       * and when somebody answered, and a write on every start makes both of
       * them mean nothing.
       */
      setWhere: sql`${modelUpgradeAction.detail} <> ${detail}
        or ${modelUpgradeAction.resolvedAt} is not null`,
    });
}

/**
 * Stamp every action whose subject has since been settled.
 *
 * **The read that draws these filters live anyway**, so this is bookkeeping
 * rather than correctness: it keeps the table from carrying rows about personas
 * that were given their models months ago, and it is what a later reader uses
 * to see that a decision was made rather than never needed.
 */
async function settleFinishedActions(tx: Transaction): Promise<void> {
  await tx.execute(sql`
    update model_upgrade_action as a
       set resolved_at = now(), updated_at = now()
     where a.resolved_at is null
       and (
         (a.kind = 'select_persona_models' and not exists (
            select 1 from persona p
              join persona_version v on v.id = p.current_version_id
             where p.id = a.subject and v.models is null))
      or (a.kind = 'select_grader_model' and not exists (
            select 1 from grader g
              join grader_version gv on gv.id = g.current_version_id
             where g.id = a.subject and g.type = 'llm_as_judge'
               and g.deleted_at is null and gv.grader_model is null))
      or (a.kind = 'select_model_provider_credential' and exists (
            select 1 from model_provider_credential c
             where c.organization_id = a.organization_id and c.provider = a.subject))
      or (a.kind = 'set_up_model_access' and not exists (
            select 1 from persona p
              join persona_version v on v.id = p.current_version_id
             where p.organization_id = a.organization_id and v.models is null)
          and not exists (
            select 1 from grader g
              join grader_version gv on gv.id = g.current_version_id
             where g.organization_id = a.organization_id and g.type = 'llm_as_judge'
               and g.deleted_at is null and gv.grader_model is null))
       )
  `);
}
