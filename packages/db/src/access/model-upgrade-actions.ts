import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { db } from "../client.ts";

import { grader, graderVersion } from "../schema/graders.ts";
import { modelProviderCredential } from "../schema/models.ts";
import { persona, personaVersion } from "../schema/personas.ts";
import {
  modelCredentialCandidate,
  modelUpgradeAction,
  type CredentialCandidateSource,
  type ModelUpgradeActionKind,
} from "../schema/upgrade.ts";
import { newId } from "@egma/ids";
import { isModelProvider, type ModelProvider } from "../models/catalog.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * What the upgrade left for an administrator, and the one thing they can do
 * about a key it would not choose between.
 *
 * **These are visible because a silent compatibility path is a trap.** A
 * persona that kept the legacy path still runs — that is the point of the
 * compatibility period — so nothing about it looks broken until the release
 * that removes the legacy path arrives and it stops. The action is what makes
 * the choice visible while there is still time to make it, and it names the
 * screen it is made on.
 *
 * **Nothing here can show a key.** A candidate answers its provider, where it
 * was found, and four characters. Activating one moves a sealed envelope from
 * one row to another without opening it, exactly as the upgrade itself does.
 */

/** One decision still outstanding, as a person reads it. */
export type ModelUpgradeAction = {
  readonly id: string;
  readonly kind: ModelUpgradeActionKind;
  /** The persona, grader, provider or organization it is about. */
  readonly subject: string;
  /** Egma's own sentence. Never a key, a hint, or anything a customer wrote. */
  readonly detail: string;
  readonly createdAt: Date;
};

/**
 * The decisions this organization still has to make.
 *
 * **Filtered against what is true now rather than against the stamp.** An
 * administrator who gives a persona its models has finished that action, and
 * the list has to say so on the next read rather than at the next restart. The
 * stamp is bookkeeping written by the boot act; this is the answer.
 *
 * Readable at every role, on the model access read's terms: what is missing is
 * not a secret, and somebody who cannot fix it still has to be able to see why
 * their run reported what it reported.
 */
export async function listModelUpgradeActions(
  auth: AuthContext,
): Promise<readonly ModelUpgradeAction[]> {
  authorize(auth, "read", here(auth));

  const rows = await db()
    .select({
      id: modelUpgradeAction.id,
      kind: modelUpgradeAction.kind,
      subject: modelUpgradeAction.subject,
      detail: modelUpgradeAction.detail,
      createdAt: modelUpgradeAction.createdAt,
    })
    .from(modelUpgradeAction)
    .where(
      and(
        within(auth, modelUpgradeAction),
        sql`case ${modelUpgradeAction.kind}
              when 'select_persona_models' then exists (
                select 1 from persona p
                  join persona_version v on v.id = p.current_version_id
                 where p.id = ${modelUpgradeAction.subject}
                   and v.models is null)
              when 'select_grader_model' then exists (
                select 1 from grader g
                  join grader_version gv on gv.id = g.current_version_id
                 where g.id = ${modelUpgradeAction.subject}
                   and g.type = 'llm_as_judge'
                   and g.deleted_at is null and gv.grader_model is null)
              when 'select_model_provider_credential' then not exists (
                select 1 from model_provider_credential c
                 where c.organization_id = ${modelUpgradeAction.organizationId}
                   and c.provider = ${modelUpgradeAction.subject})
              else exists (
                select 1 from persona p
                  join persona_version v on v.id = p.current_version_id
                 where p.organization_id = ${modelUpgradeAction.organizationId}
                   and v.models is null)
                or exists (
                select 1 from grader g
                  join grader_version gv on gv.id = g.current_version_id
                 where g.organization_id = ${modelUpgradeAction.organizationId}
                   and g.type = 'llm_as_judge'
                   and g.deleted_at is null and gv.grader_model is null)
            end`,
      ),
    )
    .orderBy(asc(modelUpgradeAction.createdAt), asc(modelUpgradeAction.id));

  return rows.map((row) => ({
    ...row,
    kind: row.kind as ModelUpgradeActionKind,
  }));
}

/** One legacy key the upgrade found, as a person choosing between two sees it. */
export type CredentialCandidate = {
  readonly id: string;
  /** The provider account it authorizes, as the legacy row spelled it. */
  readonly provider: string;
  /** Which kind of legacy row it came from. */
  readonly source: CredentialCandidateSource;
  /** Which row exactly — the setting's name, the credential's label, a project. */
  readonly sourceName: string;
  /** The last characters of the key. Never enough of it to use. */
  readonly hint: string;
  /** Whether this is the key the organization is now using for that provider. */
  readonly active: boolean;
  /**
   * Whether it *could* be. False for a provider this release's catalog does not
   * carry — the key is kept and shown, because throwing it away would lose the
   * only record that it was ever configured, but nothing can spend it.
   */
  readonly selectable: boolean;
  readonly createdAt: Date;
};

/**
 * Every legacy key the upgrade found for this organization.
 *
 * **Only an administrator**, on the row of the permission table that already
 * names provider credentials: which of two accounts this organization's
 * simulations spend from is that kind of decision.
 */
export async function listCredentialCandidates(
  auth: AuthContext,
): Promise<readonly CredentialCandidate[]> {
  authorize(auth, "manage_organization", here(auth));

  const rows = await db()
    .select({
      id: modelCredentialCandidate.id,
      provider: modelCredentialCandidate.provider,
      source: modelCredentialCandidate.source,
      sourceName: modelCredentialCandidate.sourceName,
      hint: modelCredentialCandidate.credentialsHint,
      activatedAt: modelCredentialCandidate.activatedAt,
      createdAt: modelCredentialCandidate.createdAt,
    })
    .from(modelCredentialCandidate)
    .where(within(auth, modelCredentialCandidate))
    .orderBy(
      asc(modelCredentialCandidate.provider),
      asc(modelCredentialCandidate.id),
    );

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    source: row.source as CredentialCandidateSource,
    sourceName: row.sourceName,
    hint: row.hint,
    active: row.activatedAt !== null,
    selectable: isModelProvider(row.provider),
    createdAt: row.createdAt,
  }));
}

/**
 * Make one candidate this organization's active credential for its provider.
 *
 * **The envelope moves sealed and nothing is opened.** The stored key becomes
 * the organization's key for that provider from the next claim onwards — which
 * is ordinary rotation, and it mints no persona or grader version, because a
 * credential is operational state and never authored behavior.
 *
 * **A provider this release does not carry is refused by name.** There is no
 * credential row it could become, and storing one would be Egma holding a
 * secret for an account nothing can spend from.
 */
export async function activateCredentialCandidate(
  auth: AuthContext,
  id: string,
): Promise<{ readonly provider: ModelProvider; readonly hint: string }> {
  authorize(auth, "manage_organization", here(auth));

  return db().transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        id: modelCredentialCandidate.id,
        provider: modelCredentialCandidate.provider,
        credentials: modelCredentialCandidate.credentials,
        hint: modelCredentialCandidate.credentialsHint,
      })
      .from(modelCredentialCandidate)
      .where(
        and(
          within(auth, modelCredentialCandidate),
          eq(modelCredentialCandidate.id, id),
        ),
      )
      .limit(1);

    if (candidate === undefined) {
      throw new UnprocessableInputError(
        "that is not a stored key this organization was offered a choice between",
      );
    }
    if (!isModelProvider(candidate.provider)) {
      throw new UnprocessableInputError(
        `${candidate.provider} is not a provider in this release's model catalog, so its stored key cannot be used. Store a key for a provider this release carries instead.`,
      );
    }

    const now = new Date();
    await tx
      .insert(modelProviderCredential)
      .values({
        id: newId("mpc"),
        organizationId: auth.organizationId,
        provider: candidate.provider,
        credentials: candidate.credentials,
        credentialsHint: candidate.hint,
        revision: newId("rev"),
        createdBy: auth.userId,
      })
      .onConflictDoUpdate({
        target: [
          modelProviderCredential.organizationId,
          modelProviderCredential.provider,
        ],
        set: {
          credentials: candidate.credentials,
          credentialsHint: candidate.hint,
          revision: newId("rev"),
          updatedAt: now,
        },
      });

    // Exactly one candidate per provider is the active one, so choosing this
    // one un-chooses the other. Two rows both stamped active would be two
    // answers to "which key is this organization spending".
    await tx
      .update(modelCredentialCandidate)
      .set({ activatedAt: null })
      .where(
        and(
          within(auth, modelCredentialCandidate),
          eq(modelCredentialCandidate.provider, candidate.provider),
        ),
      );
    await tx
      .update(modelCredentialCandidate)
      .set({ activatedAt: now })
      .where(eq(modelCredentialCandidate.id, candidate.id));

    return { provider: candidate.provider, hint: candidate.hint };
  });
}

/**
 * Whether this organization still has anything on the legacy path at all — the
 * one-line answer a settings screen draws a banner from.
 *
 * Deliberately a count of live facts rather than of action rows: an
 * organization that never needed an action has none, and an organization whose
 * personas were all given selections this morning has stale ones.
 */
export async function modelUpgradeOutstanding(auth: AuthContext): Promise<number> {
  authorize(auth, "read", here(auth));
  return (await listModelUpgradeActions(auth)).length;
}

/** Whether a persona or grader of this organization is still on the old path. */
export async function anythingOnTheLegacyPath(auth: AuthContext): Promise<boolean> {
  authorize(auth, "read", here(auth));

  const [waiting] = await db()
    .select({ found: sql<number>`1` })
    .from(persona)
    .innerJoin(personaVersion, eq(persona.currentVersionId, personaVersion.id))
    .where(
      and(within(auth, persona), isNull(personaVersion.models)),
    )
    .limit(1);
  if (waiting !== undefined) return true;

  const [judged] = await db()
    .select({ found: sql<number>`1` })
    .from(grader)
    .innerJoin(graderVersion, eq(grader.currentVersionId, graderVersion.id))
    .where(
      and(
        within(auth, grader),
        eq(grader.type, "llm_as_judge"),
        isNull(grader.deletedAt),
        isNull(graderVersion.graderModel),
      ),
    )
    .limit(1);
  return judged !== undefined;
}
