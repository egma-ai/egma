import { newId } from "@egma/ids";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import {
  judgeConfiguration,
  judgeCredential,
  JUDGE_PROVIDERS,
  type JudgeProvider,
} from "../schema/graders.ts";
import { gradingJob } from "../schema/grading.ts";
import { gradingPlan } from "../schema/plans.ts";
import { run, simulation } from "../schema/runs.ts";
import { project } from "../schema/tenancy.ts";
import { sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import {
  IdentityConflictError,
  JudgeCredentialInUseError,
  UnprocessableInputError,
  type JudgeCredentialUse,
} from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { plansNeedingCredential } from "./run-plans.ts";
import { within } from "./within.ts";

/**
 * The organization's judge credentials: the keys egma replays to a model
 * provider every time it judges, and the one place any of them is stored.
 *
 * **Write-only, and that is a property of this file rather than a promise each
 * caller keeps.** Nothing exported here can produce a plaintext key. `COLUMNS`
 * below names every column an answer may carry, the sealed envelope is not
 * among them, and there is no argument by which any read could be asked for
 * one. The single door to a plaintext judge key is `resolveJudgeKey` in
 * `judges.ts`, which resolves a *project's* judge and refuses every context
 * that did not come from a grading claim. So an admin can replace a key without
 * ever having read the one they are replacing, which is what "protected keys
 * never return to the browser" means when it is enforced rather than intended.
 *
 * **Rotation replaces the whole envelope.** It is sealed over the whole value,
 * so there is no shape in which one could be edited in place; the identity, the
 * label and every project pointing at it stay exactly where they are, and the
 * old secret never comes back. Pending grading picks the new key up when it
 * claims, because a frozen plan stores the credential's *id* and never its
 * secret.
 *
 * **Archive is deliberately absent.** Removing a credential has to be refused
 * while an active project points at it, while a nonterminal simulation's frozen
 * plan names it, and while a claimed grading job still needs it — and frozen
 * grading plans arrive with the run-planning effort. A door with none of that
 * behind it would strand work mid-flight, so the column exists and nothing
 * opens it yet.
 */

/**
 * The floor under a judge key, so the stored last-four stays a hint rather than
 * most of the secret it hints at. Real provider keys are tens of characters, so
 * anything this short is a paste gone wrong.
 *
 * The same number the project judge's own writer holds, and deliberately the
 * same rule: a key is a key wherever it was typed.
 */
const SHORTEST_KEY = 8;

/** How much of a key a person may see: enough to tell two apart, no more. */
const HINT_CHARACTERS = 4;

/**
 * One credential, as everybody but the grading engine sees it.
 *
 * There is no field here through which a secret could travel, and that is the
 * whole shape of the type: `hint` is four characters chosen so that two keys
 * can be told apart, and `id` names the envelope without being it.
 */
export type JudgeCredential = {
  readonly id: string;
  readonly organizationId: string;
  readonly label: string;
  readonly provider: JudgeProvider;
  /** The last characters of the key. Never enough of it to use. */
  readonly hint: string;
  /** The opaque revision of the live half. Hand back as `expectedRevision`. */
  readonly revision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type NewJudgeCredential = {
  readonly label: string;
  readonly provider: string;
  /** In the clear here and sealed before it touches a row. */
  readonly key: string;
};

/** An answer's columns, and no more — the sealed envelope is not among them. */
const COLUMNS = {
  id: judgeCredential.id,
  organizationId: judgeCredential.organizationId,
  label: judgeCredential.label,
  provider: judgeCredential.provider,
  hint: judgeCredential.credentialsHint,
  revision: judgeCredential.revision,
  createdAt: judgeCredential.createdAt,
  updatedAt: judgeCredential.updatedAt,
} as const;

function answer(row: {
  readonly id: string;
  readonly organizationId: string;
  readonly label: string;
  readonly provider: string;
  readonly hint: string;
  readonly revision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): JudgeCredential {
  return {
    ...row,
    // The column is pinned by a check constraint, so what comes back is one of
    // the words this module writes.
    provider: row.provider as JudgeProvider,
  };
}

function validJudgeProvider(provider: string): JudgeProvider {
  const known = JUDGE_PROVIDERS.find((candidate) => candidate === provider);
  if (known === undefined) {
    throw new UnprocessableInputError(
      `"${provider}" is not a judge provider Egma knows; expected one of ${JUDGE_PROVIDERS.join(", ")}`,
    );
  }
  return known;
}

function validLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError(
      "a judge credential needs a label, because telling two keys apart is the only thing anybody can do with one from the outside",
    );
  }
  return trimmed;
}

/**
 * Trimmed before it is sealed, like every credential this codebase stores: a
 * key pasted with whitespace would pass every check, seal the padding, and fail
 * at the provider with nothing to say the stored value was the problem.
 */
function validKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError("a judge credential needs a key");
  }
  if (trimmed.length < SHORTEST_KEY) {
    throw new UnprocessableInputError(
      `a judge key is at least ${SHORTEST_KEY} characters, and this one is shorter than any provider issues`,
    );
  }
  return trimmed;
}

/** The sealed envelope and the hint beside it, from one key. */
export function sealedJudgeKey(key: string): {
  readonly credentials: string;
  readonly credentialsHint: string;
} {
  const valid = validKey(key);
  return {
    // Sealed under a fresh initialisation vector every time, exactly as a
    // connection's credentials are: two writes of the same key are two
    // different ciphertexts, so the column tells nobody that nothing changed.
    credentials: sealCredentials({ key: valid }),
    credentialsHint: valid.slice(-HINT_CHARACTERS),
  };
}

/** The named credential, alive, inside the caller's own organization. */
function theCredential(auth: AuthContext, id: string) {
  return within(
    auth,
    judgeCredential,
    and(eq(judgeCredential.id, id), isNull(judgeCredential.archivedAt)),
  );
}

/**
 * A new credential, labelled and sealed.
 *
 * **Only an `admin`**, on the row of the permission table that already names
 * provider credentials. Storing a key commits the organization's own account to
 * every conversation it judges from now on, which is a decision of the same
 * kind as retention and billing rather than one of the same kind as writing a
 * test.
 *
 * An organization may hold **as many as it likes, per provider**. Two teams
 * with two accounts is an ordinary arrangement, and forcing one key per
 * organization would make somebody paste the wrong account's key rather than
 * make anything safer.
 */
export async function createJudgeCredential(
  auth: AuthContext,
  input: NewJudgeCredential,
): Promise<JudgeCredential> {
  authorize(auth, "manage_organization", here(auth));

  const label = validLabel(input.label);
  const provider = validJudgeProvider(input.provider);
  const sealed = sealedJudgeKey(input.key);

  const [row] = await db()
    .insert(judgeCredential)
    .values({
      id: newId("jcr"),
      organizationId: auth.organizationId,
      label,
      provider,
      ...sealed,
      revision: newId("rev"),
      createdBy: auth.userId,
    })
    .returning(COLUMNS);

  if (row === undefined) {
    throw new Error("the judge credential was not written");
  }
  return answer(row);
}

/**
 * Every credential the organization holds, oldest first.
 *
 * Readable at every role, because it is the list a judge setting chooses from
 * and a `viewer` reading a project's settings has to be able to see which
 * credential it points at — by its label and its hint, which is all any of this
 * ever answers with.
 */
export async function listJudgeCredentials(
  auth: AuthContext,
): Promise<readonly JudgeCredential[]> {
  authorize(auth, "read", here(auth));

  const rows = await db()
    .select(COLUMNS)
    .from(judgeCredential)
    .where(within(auth, judgeCredential, isNull(judgeCredential.archivedAt)))
    .orderBy(asc(judgeCredential.id));

  return rows.map(answer);
}

export async function getJudgeCredential(
  auth: AuthContext,
  id: string,
): Promise<JudgeCredential | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select(COLUMNS)
    .from(judgeCredential)
    .where(theCredential(auth, id))
    .limit(1);

  return row === undefined ? undefined : answer(row);
}

/**
 * What may be changed about a credential after it exists.
 *
 * **The provider is not here.** A key belongs to one provider's account, so
 * changing the word would be a different credential wearing this one's
 * identity, and every project pointing at it would silently start spending
 * somewhere else. Making a second credential costs one form and says what
 * actually happened.
 */
export type JudgeCredentialChanges = {
  readonly label?: string;
  /**
   * A replacement key, whole. Absent leaves the stored one exactly as it is —
   * which is the ordinary edit, relabelling a credential without touching what
   * it holds.
   */
  readonly key?: string;
};

/**
 * A credential relabelled, or its secret replaced whole, or both.
 *
 * **Nothing is ever read back in order to write.** The caller has the label and
 * the hint, and neither of those is the key; a rotation is a new value arriving
 * rather than an old one being edited. That is why "an admin may replace a
 * judge credential without ever reading the stored value" is true by
 * construction here rather than by anybody's care.
 *
 * The identity survives rotation, deliberately: every project pointing at this
 * credential keeps pointing at it, pending grading claims the new key when it
 * gets there, and nothing anywhere has to be repointed because a key was
 * changed.
 */
export async function editJudgeCredential(
  auth: AuthContext,
  id: string,
  changes: JudgeCredentialChanges,
  expected: { readonly expectedRevision?: string | undefined } = {},
): Promise<JudgeCredential | undefined> {
  authorize(auth, "manage_organization", here(auth));

  const label = changes.label === undefined ? undefined : validLabel(changes.label);
  const sealed = changes.key === undefined ? undefined : sealedJudgeKey(changes.key);

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: judgeCredential.id, revision: judgeCredential.revision })
      .from(judgeCredential)
      .where(theCredential(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;

    if (
      expected.expectedRevision !== undefined &&
      expected.expectedRevision !== locked.revision
    ) {
      throw new IdentityConflictError("Judge credential", locked.id, {
        expected: expected.expectedRevision,
        current: locked.revision,
      });
    }

    if (label === undefined && sealed === undefined) {
      const [unchanged] = await tx
        .select(COLUMNS)
        .from(judgeCredential)
        .where(eq(judgeCredential.id, locked.id))
        .limit(1);
      return unchanged === undefined ? undefined : answer(unchanged);
    }

    // A bare `eq` on an id that just came off the tenancy-checked row locked
    // above, in this same transaction, so it reaches no further than that check
    // already did.
    const [row] = await tx
      .update(judgeCredential)
      .set({
        ...(label === undefined ? {} : { label }),
        ...(sealed ?? {}),
        revision: newId("rev"),
        updatedAt: new Date(),
      })
      .where(eq(judgeCredential.id, locked.id))
      .returning(COLUMNS);

    if (row === undefined) {
      throw new Error("the judge credential was not written");
    }
    return answer(row);
  });
}


/**
 * Every reason this credential cannot go away yet, read in one place so a
 * refusal and a page can never disagree about what is blocking.
 *
 * **Three questions, and each is asked of a different thing.** A project
 * pointing at the credential would lose its judge outright. A run whose frozen
 * plan names it while a conversation is still moving will be graded the moment
 * that conversation lands, against a plan whose key has gone. And a grading job
 * that is `pending` or `claimed` is the work already in flight — the service
 * resolves the current secret when it claims, so archiving under it turns a
 * whole run's judgments into errors nobody can act on.
 *
 * They are asked inside the caller's own transaction, under the lock the
 * credential is already held by, so nothing can start needing it between the
 * question and the write.
 */
async function usesOf(
  on: Queryable,
  auth: AuthContext,
  credentialId: string,
): Promise<readonly JudgeCredentialUse[]> {
  const uses: JudgeCredentialUse[] = [];

  for (const row of await on
    .select({ projectId: judgeConfiguration.projectId })
    .from(judgeConfiguration)
    .innerJoin(project, eq(judgeConfiguration.projectId, project.id))
    .where(
      and(
        eq(judgeConfiguration.organizationId, auth.organizationId),
        eq(judgeConfiguration.credentialId, credentialId),
        isNull(project.deletedAt),
      ),
    )
    .orderBy(asc(judgeConfiguration.projectId))) {
    uses.push({ kind: "project", id: row.projectId });
  }

  // A plan is needed while anything under its run is still moving. Terminal
  // rows have been judged or will never be, and a `skipped` one was never
  // enqueued at all — so a run made entirely of them blocks nothing.
  for (const row of await on
    .selectDistinct({ runId: gradingPlan.runId })
    .from(gradingPlan)
    .innerJoin(simulation, eq(simulation.runId, gradingPlan.runId))
    .where(
      and(
        eq(gradingPlan.organizationId, auth.organizationId),
        plansNeedingCredential(credentialId),
        inArray(simulation.status, ["queued", "claimed", "running"]),
      ),
    )
    .orderBy(asc(gradingPlan.runId))) {
    uses.push({ kind: "run", id: row.runId });
  }

  for (const row of await on
    .selectDistinct({ jobId: gradingJob.id })
    .from(gradingJob)
    .innerJoin(simulation, eq(gradingJob.simulationId, simulation.id))
    .innerJoin(gradingPlan, eq(gradingPlan.runId, simulation.runId))
    .where(
      and(
        eq(gradingJob.organizationId, auth.organizationId),
        inArray(gradingJob.status, ["pending", "claimed"]),
        plansNeedingCredential(credentialId),
      ),
    )
    .orderBy(asc(gradingJob.id))) {
    uses.push({ kind: "grading_job", id: row.jobId });
  }

  return uses;
}

/**
 * Take a credential out of use, once nothing needs it.
 *
 * **Archive rather than delete, and refused rather than cascading.** The row
 * stays, so every frozen plan that ever named it keeps naming something
 * readable and a run from March remains interpretable. What Archive means is
 * only *stop choosing this from now on*: a project settings page will no longer
 * offer it, and `listJudgeCredentials` no longer answers with it.
 *
 * The three blocking uses are `usesOf` above, and the refusal carries them
 * whole. A door with none of that behind it would strand work mid-flight, which
 * is exactly why this verb did not exist until frozen grading plans did — there
 * was no way to ask the second and third questions.
 *
 * Archiving an archived credential is nothing to do and answers with it. A
 * credential this caller cannot see answers `undefined`, the same as one that
 * never existed.
 */
export async function archiveJudgeCredential(
  auth: AuthContext,
  id: string,
  expected: { readonly expectedRevision?: string | undefined } = {},
): Promise<JudgeCredential | undefined> {
  authorize(auth, "manage_organization", here(auth));

  return db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: judgeCredential.id, revision: judgeCredential.revision })
      .from(judgeCredential)
      .where(theCredential(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;

    if (
      expected.expectedRevision !== undefined &&
      expected.expectedRevision !== locked.revision
    ) {
      throw new IdentityConflictError("Judge credential", locked.id, {
        expected: expected.expectedRevision,
        current: locked.revision,
      });
    }

    const uses = await usesOf(tx, auth, locked.id);
    if (uses.length > 0) throw new JudgeCredentialInUseError(locked.id, uses);

    const [row] = await tx
      .update(judgeCredential)
      .set({
        archivedAt: new Date(),
        revision: newId("rev"),
        updatedAt: new Date(),
      })
      .where(eq(judgeCredential.id, locked.id))
      .returning(COLUMNS);

    if (row === undefined) {
      throw new Error("the judge credential was not written");
    }
    return answer(row);
  });
}

/**
 * What is blocking a credential's Archive, asked without attempting one.
 *
 * The same read the refusal is built from, offered on its own so a settings
 * page can say *why* the button will not work before somebody presses it —
 * and so the page and the refusal can never give two different answers.
 */
export async function judgeCredentialUses(
  auth: AuthContext,
  id: string,
): Promise<readonly JudgeCredentialUse[] | undefined> {
  authorize(auth, "read", here(auth));

  const [found] = await db()
    .select({ id: judgeCredential.id })
    .from(judgeCredential)
    .where(theCredential(auth, id))
    .limit(1);

  if (found === undefined) return undefined;
  return usesOf(db(), auth, found.id);
}
