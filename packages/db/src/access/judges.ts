import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../client.ts";
import {
  judgeConfiguration,
  judgeCredential,
  JUDGE_PROVIDERS,
  type JudgeProvider,
  type JudgeSource,
} from "../schema/graders.ts";
import { project } from "../schema/tenancy.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { sealedJudgeKey } from "./judge-credentials.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import {
  JudgeProviderMismatchError,
  ProjectOutsideOrganizationError,
  UnprocessableInputError,
} from "./errors.ts";
import { within } from "./within.ts";

/**
 * The project's default judge: which model judges here, and the one key it is
 * asked with. What it *is* is the schema file's story (`schema/graders.ts`);
 * this file is how it is reached.
 *
 * Three calls, and the split between them is the whole design:
 *
 * - **Writing** takes the key in the clear, seals it, and keeps the last four
 *   characters so a person can tell two keys apart.
 * - **Reading** answers the provider, the model, a *reference* to the key and
 *   that hint. It never answers the key, and there is no argument by which it
 *   could be asked to.
 * - **Resolving** is the one door to the plaintext, and egma's own grading
 *   engine is the only thing that may knock.
 *
 * That is ADR-0003's arrangement, unchanged, applied to the second secret egma
 * holds. A judge key cannot be hashed for the reason a connection's credential
 * cannot: egma replays it to the provider every time it judges.
 */

/**
 * The floor under a judge key, so the stored last-four stays a hint rather than
 * most of the secret it hints at. Real provider keys are tens of characters, so
 * anything this short is a paste gone wrong.
 */
const SHORTEST_KEY = 8;

/**
 * The project's judge, as anybody but the engine sees it.
 *
 * `keyReference` is the whole of what a caller may hold: it *names* the sealed
 * key and is never the key. It is the project's own id, because there is one
 * judge configuration per project and its identity is therefore the project's
 * — and because a reference that is already a tenanted identifier cannot be
 * pointed at somebody else's secret by rewriting it.
 */
export type JudgeConfiguration = {
  readonly projectId: string;
  readonly provider: JudgeProvider;
  readonly model: string;
  /** Names the sealed key. Handed to `resolveJudgeKey`, and to nothing else. */
  readonly keyReference: string;
  /**
   * The last characters of the key, so two keys can be told apart — and `null`
   * for the deployment's own `platform` judge, which is not the customer's to
   * see, to rotate, or to be hinted at.
   */
  readonly keyHint: string | null;
  /** Where the key comes from: an organization credential, or the platform. */
  readonly source: JudgeSource;
  /** The credential this project spends from, or null for the platform's. */
  readonly credentialId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** The judge as a caller writes one down, key and all. */
export type NewJudgeConfiguration = {
  readonly provider: string;
  readonly model: string;
  /** In the clear here and sealed before it touches a row. */
  readonly key: string;
};

/**
 * The three write-door checks below refuse with `UnprocessableInputError`
 * rather than a plain one, and the distinction is what the layer above needs:
 * a sentence a caller can act on, told apart from a fault. Nothing else in this
 * file changes shape — "the row was not written" stays a plain error, because
 * it is egma being broken rather than anybody's request being wrong.
 */
function validProvider(provider: string): JudgeProvider {
  const known = JUDGE_PROVIDERS.find((candidate) => candidate === provider);
  if (known === undefined) {
    throw new UnprocessableInputError(
      `"${provider}" is not a judge provider egma knows; expected one of ${JUDGE_PROVIDERS.join(", ")}`,
    );
  }
  return known;
}

function validModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError(
      "a judge configuration needs a model to name",
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
    throw new UnprocessableInputError(
      "a judge configuration needs a key to speak with",
    );
  }
  if (trimmed.length < SHORTEST_KEY) {
    throw new UnprocessableInputError(
      `a judge key is at least ${SHORTEST_KEY} characters, and this one is shorter than any provider issues`,
    );
  }
  return trimmed;
}

/** An answer's columns, and no more — the sealed envelope is not among them. */
const COLUMNS = {
  projectId: judgeConfiguration.projectId,
  provider: judgeConfiguration.provider,
  model: judgeConfiguration.model,
  source: judgeConfiguration.source,
  credentialId: judgeConfiguration.credentialId,
  createdAt: judgeConfiguration.createdAt,
  updatedAt: judgeConfiguration.updatedAt,
} as const;

/**
 * The hint a caller may see, which is the *credential's* and never the
 * platform's.
 *
 * A `platform` judge belongs to whoever runs the deployment. Hinting at its key
 * would be handing a customer four characters of an operator's secret to no
 * purpose: they cannot rotate it, cannot choose which one it is, and have
 * nothing to tell apart.
 */
const HINT = judgeCredential.credentialsHint;

function answer(row: {
  readonly projectId: string;
  readonly provider: string;
  readonly model: string;
  readonly source: string;
  readonly credentialId: string | null;
  readonly credentialHint: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): JudgeConfiguration {
  return {
    projectId: row.projectId,
    // The columns are pinned by check constraints, so what comes back is one of
    // the words this module writes.
    provider: row.provider as JudgeProvider,
    model: row.model,
    keyReference: row.projectId,
    keyHint: row.credentialHint,
    source: row.source as JudgeSource,
    credentialId: row.credentialId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The setting joined to the credential it names, so one read answers both.
 *
 * A left join because the platform's own judge names none, and that absence is
 * an ordinary state rather than a broken row.
 */
function selectWithCredential() {
  return db()
    .select({ ...COLUMNS, credentialHint: HINT })
    .from(judgeConfiguration)
    .leftJoin(
      judgeCredential,
      eq(judgeConfiguration.credentialId, judgeCredential.id),
    );
}

/**
 * The project's judge, set or replaced. One row per project, so writing it is an
 * upsert keyed on the project from the context — there is no project to name and
 * therefore none to name wrongly.
 *
 * **Only an `admin` writes it**, on the row of the permission table that already
 * names provider credentials. Setting a judge spends the customer's own account
 * on every conversation the project judges from now on, which is a decision of
 * the same kind as retention and billing rather than one of the same kind as
 * writing a test.
 *
 * The key replaces whole or is left alone; there is no shape in which one could
 * be edited in place, because the envelope is sealed over the whole value. A
 * write that names no key keeps the sealed one and changes the model beside it,
 * which is the ordinary act — moving a project from a cheap judge to a stronger
 * one on the same account.
 */
export async function setJudgeConfiguration(
  auth: AuthContext,
  input: NewJudgeConfiguration,
): Promise<JudgeConfiguration> {
  authorize(auth, "manage_organization", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a judge belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the project-membership read below.
  const provider = validProvider(input.provider);
  const model = validModel(input.model);
  const sealed = sealedJudgeKey(input.key);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const now = new Date();
  const label = await labelForProject(projectId);

  await db().transaction(async (tx) => {
    // Locked on its own, without the credential join: a row on the nullable
    // side of an outer join cannot be locked, and the lock this needs is on the
    // project's setting rather than on whatever it happens to point at.
    const [existing] = await tx
      .select({
        source: judgeConfiguration.source,
        credentialId: judgeConfiguration.credentialId,
      })
      .from(judgeConfiguration)
      .where(
        within(
          auth,
          judgeConfiguration,
          eq(judgeConfiguration.projectId, projectId),
        ),
      )
      .limit(1)
      .for("update");

    const [pointedAt] =
      existing?.credentialId == null
        ? []
        : await tx
            .select({ provider: judgeCredential.provider })
            .from(judgeCredential)
            .where(eq(judgeCredential.id, existing.credentialId))
            .limit(1);

    /**
     * **One credential per project setting, rotated rather than multiplied.**
     * A project that already spends from a credential of this provider has that
     * credential's secret replaced whole; anything else — no setting at all, the
     * deployment's own judge, or a move to a different provider — mints a new
     * credential and points the project at it.
     *
     * That rule is what keeps distinct keys distinct. Two projects of one
     * organization that were configured with two different keys keep two
     * credentials, and neither is quietly merged into the other's account.
     */
    const reuse =
      existing?.credentialId != null && pointedAt?.provider === provider
        ? existing.credentialId
        : undefined;

    let credentialId = reuse;
    if (credentialId === undefined) {
      credentialId = newId("jcr");
      await tx.insert(judgeCredential).values({
        id: credentialId,
        organizationId: auth.organizationId,
        label,
        provider,
        ...sealed,
        revision: newId("rev"),
        createdBy: auth.userId,
      });
    } else {
      await tx
        .update(judgeCredential)
        .set({ ...sealed, revision: newId("rev"), updatedAt: now })
        .where(eq(judgeCredential.id, credentialId));
    }

    await tx
      .insert(judgeConfiguration)
      .values({
        projectId,
        organizationId: auth.organizationId,
        provider,
        model,
        source: "credential",
        credentialId,
        credentials: null,
        credentialsHint: null,
        createdBy: auth.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: judgeConfiguration.projectId,
        set: {
          provider,
          model,
          source: "credential",
          credentialId,
          // The deployment's own envelope goes when a project chooses a key of
          // its own: two secrets on one row with no rule saying which is spent
          // is exactly what the row's check constraint forbids.
          credentials: null,
          credentialsHint: null,
          updatedAt: now,
        },
      });
  });

  const configured = await getJudgeConfiguration(auth);
  if (configured === undefined) {
    throw new Error("the judge configuration was not written");
  }
  return configured;
}

/**
 * What a credential written on a project's behalf is called.
 *
 * The project's slug, because that is the word a person already uses for the
 * product area whose key this was — and because the alternative, an
 * unlabelled credential, would leave an organization with several of them and
 * no way to tell which is which but four characters of ciphertext.
 */
async function labelForProject(projectId: string): Promise<string> {
  const [row] = await db()
    .select({ slug: project.slug })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1);
  return `${row?.slug ?? projectId} judge key`;
}

/**
 * The project's judge, chosen from what the organization already holds — and
 * **never a key**.
 *
 * This is the door the browser uses, and the difference from
 * `setJudgeConfiguration` above is the whole point of the credential table
 * existing: an admin picks a provider, a model, and one of two sources, and no
 * secret travels in either direction. Storing a key is a separate act with its
 * own door, so a person changing which model judges never has to hold a key to
 * do it.
 *
 * Two sources and no third:
 *
 * - **an organization credential**, which must be one of this organization's,
 *   active, and *of the same provider as the judge*. A key issued by one
 *   provider cannot answer for a judge configured to ask another, and the
 *   refusal names both rather than failing later at the provider.
 * - **the platform's own judge**, which exists only where the deployment
 *   configured one. Choosing it when the deployment has none would leave a
 *   project reading as judged and unable to judge, so it is refused.
 */
export type ProjectJudgeChoice = {
  readonly provider: string;
  readonly model: string;
  /** A `jcr_` credential of this organization, or the `platform` sentinel. */
  readonly source: string;
  /**
   * The deployment's own judge, as this process was configured with it —
   * absent on a deployment that named none.
   *
   * **Handed in rather than read off the project's row, and that is the whole
   * of what makes the sentinel a choice rather than a one-way door.** A project
   * that moves to a credential of its own stops holding the deployment's
   * envelope, because a row may hold exactly one key source. If choosing
   * `platform` again meant finding that envelope still on the row, then the
   * first move away from it would be the last — and the refusal on the way back
   * would say the deployment has no judge while the deployment plainly has one.
   *
   * So the deployment's judge comes from where it actually lives: the
   * configuration this process started with. Re-selecting it seals it onto the
   * row again, which also means a deployment that rotated its own key hands the
   * current one to the next project that asks for it.
   */
  readonly platformJudge?:
    | {
        readonly provider: string;
        readonly model: string;
        readonly key: string;
      }
    | undefined;
};

/** The word a project uses to name the deployment's own judge. */
export const PLATFORM_JUDGE = "platform";

export async function setProjectJudge(
  auth: AuthContext,
  choice: ProjectJudgeChoice,
): Promise<JudgeConfiguration> {
  authorize(auth, "manage_organization", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a judge belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  const provider = validProvider(choice.provider);
  const model = validModel(choice.model);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const now = new Date();

  if (choice.source === PLATFORM_JUDGE) {
    const { platformJudge } = choice;

    // The one true reason the sentinel can be unavailable: this deployment
    // never named a judge of its own. Nothing about the project's own history
    // can produce this answer, which is what stops the sentence being a lie
    // told to somebody whose deployment plainly has one.
    if (platformJudge === undefined) {
      throw new UnprocessableInputError(
        "this deployment configured no judge of its own, so there is no platform judge to choose. Add an organization judge credential and select it instead.",
      );
    }

    // The deployment's key belongs to one provider's account, so a judge
    // configured to ask somebody else could never be answered by it. Refused
    // here, naming both, rather than left to fail at the provider.
    if (platformJudge.provider !== provider) {
      throw new UnprocessableInputError(
        `this deployment's own judge is for ${platformJudge.provider}, and this project's judge uses ${provider}. Choose ${platformJudge.provider}, or point the project at an organization credential for ${provider}.`,
      );
    }

    // Sealed onto the row again from the deployment's own configuration. A
    // project moving back from a credential of its own holds no envelope at
    // that moment, so this is a write rather than a read — and it is what makes
    // moving away from the sentinel a reversible decision.
    const sealed = platformJudgeRow({
      projectId,
      organizationId: auth.organizationId,
      createdBy: auth.userId,
      provider: platformJudge.provider,
      model,
      key: platformJudge.key,
      now,
    });

    await db()
      .insert(judgeConfiguration)
      .values(sealed)
      .onConflictDoUpdate({
        target: judgeConfiguration.projectId,
        set: {
          provider: sealed.provider,
          model: sealed.model,
          source: PLATFORM_JUDGE,
          // The credential this project used to spend from is released, not
          // deleted: it stays in the organization for another project to point
          // at, and the row's own check forbids holding both at once.
          credentialId: null,
          credentials: sealed.credentials,
          credentialsHint: sealed.credentialsHint,
          updatedAt: now,
        },
      });

    const configured = await getJudgeConfiguration(auth);
    if (configured === undefined) {
      throw new Error("the judge configuration was not written");
    }
    return configured;
  }

  const [credential] = await db()
    .select({ id: judgeCredential.id, provider: judgeCredential.provider })
    .from(judgeCredential)
    .where(
      within(
        auth,
        judgeCredential,
        and(
          eq(judgeCredential.id, choice.source),
          isNull(judgeCredential.archivedAt),
        ),
      ),
    )
    .limit(1);

  if (credential === undefined) {
    throw new UnprocessableInputError(
      `there is no active judge credential ${choice.source} in this organization. Choose one from organization settings, or add one.`,
    );
  }
  if (credential.provider !== provider) {
    throw new JudgeProviderMismatchError(
      credential.id,
      credential.provider,
      provider,
    );
  }

  await db()
    .insert(judgeConfiguration)
    .values({
      projectId,
      organizationId: auth.organizationId,
      provider,
      model,
      source: "credential",
      credentialId: credential.id,
      credentials: null,
      credentialsHint: null,
      createdBy: auth.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: judgeConfiguration.projectId,
      set: {
        provider,
        model,
        source: "credential",
        credentialId: credential.id,
        credentials: null,
        credentialsHint: null,
        updatedAt: now,
      },
    });

  const configured = await getJudgeConfiguration(auth);
  if (configured === undefined) {
    throw new Error("the judge configuration was not written");
  }
  return configured;
}

/**
 * The project's judge as it stands, or nothing when the project has configured
 * none — which is an ordinary case rather than a fault. A project with no judge
 * still runs every deterministic grader it has; what it cannot do is ask a model
 * anything, and the graders that would have are `errored` and say so.
 *
 * A credential acting in no project reads no judge: the answer belongs to one
 * project, and a credential for the whole customer is acting in none.
 */
export async function getJudgeConfiguration(
  auth: AuthContext,
): Promise<JudgeConfiguration | undefined> {
  authorize(auth, "read", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) return undefined;

  const [row] = await selectWithCredential()
    .where(
      within(auth, judgeConfiguration, eq(judgeConfiguration.projectId, projectId)),
    )
    .limit(1);

  return row === undefined ? undefined : answer(row);
}

/**
 * The project's judge as a settings page reads it: configured, or the explicit
 * `needs_setup` state.
 *
 * **An absent row is a state and not a fault.** A project with no judge still
 * runs every grader it has that is computed rather than judged; what it cannot
 * do is ask a model anything — so the predefined expected-behaviors copy, which
 * every project is created holding, cannot judge, and a run carrying it would
 * produce `errored` verdicts after real calls had been paid for. Saying
 * `needs_setup` out loud is what lets a page tell somebody that LLM grading is
 * unavailable until an admin finishes setup, and what lets the run door refuse
 * before the money is spent. A project that deleted every grader asking a model
 * is in this state too, and runs perfectly well in it.
 *
 * The two are one type rather than an optional value so that no caller can read
 * "no judge" as "the read failed", and so that adding a third state later is a
 * new tag rather than a new nullable field.
 */
export type ProjectJudge =
  | { readonly state: "needs_setup" }
  | { readonly state: "configured"; readonly judge: JudgeConfiguration };

export async function getProjectJudge(auth: AuthContext): Promise<ProjectJudge> {
  const configured = await getJudgeConfiguration(auth);
  return configured === undefined
    ? { state: "needs_setup" }
    : { state: "configured", judge: configured };
}

/**
 * The one door to the judge key's plaintext, and **egma's own grading engine is
 * the only thing that may knock.**
 *
 * The gate is narrower than a role, on purpose: the only thing egma ever does
 * with a judge key is judge, and the only thing that judges is the grading
 * service. So the check is on how the caller came to exist rather than on what
 * their role permits: a context built from a grading claim says `engine` on its
 * face, and every other context in the product — a person's session, an API
 * key, a `viewer` and an `admin` alike — is refused. There is no product
 * surface that hands a customer their own key back, and this is what keeps it
 * that way while roles move around. The other secret egma replays — a
 * connection's credentials, on the dispatch path — sits behind
 * `resolveSimulationConnection`, the same shape of door demanding `simulator`
 * for the same reason.
 *
 * The reference is checked against the project the context is already narrowed
 * to, so a claim for one project cannot resolve another's key even if something
 * handed it the wrong reference.
 *
 * `undefined` for a project that has configured no judge, which the caller must
 * answer for — a judged grader with no judge behind it is `errored`, and saying
 * so is the difference between a check egma could not make and a check that
 * passed.
 */
export async function resolveJudgeKey(
  auth: AuthContext,
  keyReference: string,
): Promise<string | undefined> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "engine") {
    throw new Error(
      "a judge key is resolved by egma's grading engine and by nothing else, because judging is the only thing egma does with one",
    );
  }

  const { projectId } = auth;
  if (projectId === undefined || keyReference !== projectId) {
    throw new Error(
      "a judge key is resolved inside the project that holds it, and this reference names another",
    );
  }

  /**
   * One read, both sources. The envelope is whichever of the two the setting's
   * source says: the organization's credential for a key the customer stored,
   * and the row's own for the deployment's judge. Neither is ever selected by
   * any other function in this module.
   */
  const [row] = await db()
    .select({
      projectId: judgeConfiguration.projectId,
      source: judgeConfiguration.source,
      onTheProject: judgeConfiguration.credentials,
      onTheCredential: judgeCredential.credentials,
    })
    .from(judgeConfiguration)
    .leftJoin(
      judgeCredential,
      eq(judgeConfiguration.credentialId, judgeCredential.id),
    )
    .where(
      within(auth, judgeConfiguration, eq(judgeConfiguration.projectId, projectId)),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const sealed =
    row.source === PLATFORM_JUDGE ? row.onTheProject : row.onTheCredential;
  if (sealed === null) {
    throw new Error(
      `the judge configuration for project ${row.projectId} names a ${row.source} key that is not there; the row needs repairing before anybody can judge with it`,
    );
  }

  const opened = openCredentials(sealed);
  const key =
    typeof opened === "object" && opened !== null && !Array.isArray(opened)
      ? (opened as Record<string, unknown>)["key"]
      : undefined;

  if (typeof key !== "string" || key === "") {
    throw new Error(
      `the judge configuration for project ${row.projectId} holds a key in a shape egma never writes; the row needs repairing before anybody can judge with it`,
    );
  }
  return key;
}

/**
 * One judge row, validated and sealed, ready to insert.
 *
 * Shared by the two places the platform's own judge is written — the boot-time
 * backfill below and the provisioning transaction that gives a brand-new
 * project one — so that a key is validated and sealed identically on both, and
 * a rule added here cannot apply to only one of them.
 */
export function platformJudgeRow(input: {
  readonly projectId: string;
  readonly organizationId: string;
  /** Nullable, because a project can be created by nobody — a seeded one. */
  readonly createdBy: string | null;
  readonly provider: string;
  readonly model: string;
  readonly key: string;
  readonly now: Date;
}) {
  const key = validKey(input.key);
  return {
    projectId: input.projectId,
    organizationId: input.organizationId,
    provider: validProvider(input.provider),
    model: validModel(input.model),
    /**
     * `platform`, always — this function writes the *deployment's* judge and
     * nothing else, and the word is what tells every reader afterwards whose
     * account is being spent. Nothing customer-facing offers its hint or a way
     * to rotate it; a customer who wants their own key adds an organization
     * credential and points the project at that, which replaces this whole
     * arrangement in one write.
     */
    source: "platform" as const,
    credentialId: null,
    // Sealed per row rather than once for many: the envelope carries its own
    // initialisation vector, and reusing one across rows is the mistake this
    // repeats a cheap operation to avoid.
    credentials: sealCredentials({ key }),
    credentialsHint: key.slice(-4),
    createdBy: input.createdBy,
    updatedAt: input.now,
  };
}

/**
 * Give every project that has configured no judge the platform's own.
 *
 * **Why this exists, and why it is not a container-wide key.** A self-hoster
 * supplies one OpenAI key when they set their platform up, and it is meant to
 * cover the persona's brain, its voice, its ears and the default judge — asking
 * the same person for the same key a second time, in a second place, on a
 * laptop where they are also the only project's admin, buys nothing but a step
 * to forget. What it must *not* become is a key on the grader: a judge
 * configured per container is a judge no project chose, spent on conversations
 * belonging to customers who agreed to neither.
 *
 * So this writes the ordinary row. Sealed with the deployment's own encryption
 * key, opened by the grading engine through the one door that opens it, and
 * indistinguishable afterwards from a judge the project set for itself. What is
 * different is only who filled the form in.
 *
 * **It never overwrites.** A project that has chosen a judge has chosen it, and
 * a platform restart is not an occasion to change somebody's model or spend
 * from a different account. So this is safe to run on every boot.
 *
 * **This is the backfill, not the whole mechanism.** It catches the projects
 * that existed before the platform was given a judge — a self-hoster who runs
 * `egma self-host setup` on a deployment they had already signed up on.
 * A project created *while* the platform is running is given its judge in the
 * transaction that creates it (see `provisionOrganization`), because a project
 * that had to wait for the next restart to become gradable would produce
 * errored verdicts in between, and a grading failure is an operational failure
 * rather than anything the agent under test did.
 *
 * Not authorized against an `AuthContext` on purpose: there is no user here.
 * This is the deployment acting on its own configuration, in the same breath as
 * applying its migrations, and there is no session it could be doing it under.
 */
export async function seedDefaultJudge(input: {
  readonly provider: string;
  readonly model: string;
  readonly key: string;
}): Promise<readonly string[]> {
  const unjudged = await db()
    .select({
      id: project.id,
      organizationId: project.organizationId,
      createdBy: project.createdBy,
    })
    .from(project)
    .leftJoin(judgeConfiguration, eq(judgeConfiguration.projectId, project.id))
    .where(isNull(judgeConfiguration.projectId));

  if (unjudged.length === 0) return [];

  const now = new Date();
  await db()
    .insert(judgeConfiguration)
    .values(
      unjudged.map((row) =>
        platformJudgeRow({
          projectId: row.id,
          organizationId: row.organizationId,
          createdBy: row.createdBy,
          provider: input.provider,
          model: input.model,
          key: input.key,
          now,
        }),
      ),
    )
    // A project that gained a judge between the read above and this write kept
    // it. Nothing here is a race worth locking for; the losing side is the
    // deployment's default, which is exactly the side that should lose.
    .onConflictDoNothing({ target: judgeConfiguration.projectId });

  return unjudged.map((row) => row.id);
}
