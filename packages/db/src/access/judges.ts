import { eq, isNull } from "drizzle-orm";

import { db } from "../client.ts";
import {
  judgeConfiguration,
  JUDGE_PROVIDERS,
  type JudgeProvider,
} from "../schema/graders.ts";
import { project } from "../schema/tenancy.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
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
  /** The last characters of the key, so two keys can be told apart. */
  readonly keyHint: string;
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

function validProvider(provider: string): JudgeProvider {
  const known = JUDGE_PROVIDERS.find((candidate) => candidate === provider);
  if (known === undefined) {
    throw new Error(
      `"${provider}" is not a judge provider egma knows; expected one of ${JUDGE_PROVIDERS.join(", ")}`,
    );
  }
  return known;
}

function validModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === "") {
    throw new Error("a judge configuration needs a model to name");
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
    throw new Error("a judge configuration needs a key to speak with");
  }
  if (trimmed.length < SHORTEST_KEY) {
    throw new Error(
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
  credentialsHint: judgeConfiguration.credentialsHint,
  createdAt: judgeConfiguration.createdAt,
  updatedAt: judgeConfiguration.updatedAt,
} as const;

function answer(row: {
  readonly projectId: string;
  readonly provider: string;
  readonly model: string;
  readonly credentialsHint: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): JudgeConfiguration {
  return {
    projectId: row.projectId,
    // The column is pinned by a check constraint, so what comes back is one of
    // the words this module writes.
    provider: row.provider as JudgeProvider,
    model: row.model,
    keyReference: row.projectId,
    keyHint: row.credentialsHint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
  const key = validKey(input.key);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const now = new Date();
  const sealed = sealCredentials({ key });
  const hint = key.slice(-4);

  const [row] = await db()
    .insert(judgeConfiguration)
    .values({
      projectId,
      organizationId: auth.organizationId,
      provider,
      model,
      credentials: sealed,
      credentialsHint: hint,
      createdBy: auth.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: judgeConfiguration.projectId,
      set: {
        provider,
        model,
        // Resealed under a fresh IV every time, exactly as a connection's
        // credentials are: two writes of the same key are two different
        // ciphertexts, so the column tells nobody that nothing changed.
        credentials: sealed,
        credentialsHint: hint,
        updatedAt: now,
      },
    })
    .returning(COLUMNS);

  if (row === undefined) {
    throw new Error("the judge configuration was not written");
  }
  return answer(row);
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

  const [row] = await db()
    .select(COLUMNS)
    .from(judgeConfiguration)
    .where(
      within(auth, judgeConfiguration, eq(judgeConfiguration.projectId, projectId)),
    )
    .limit(1);

  return row === undefined ? undefined : answer(row);
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

  const [row] = await db()
    .select({
      projectId: judgeConfiguration.projectId,
      credentials: judgeConfiguration.credentials,
    })
    .from(judgeConfiguration)
    .where(
      within(auth, judgeConfiguration, eq(judgeConfiguration.projectId, projectId)),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const opened = openCredentials(row.credentials);
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
 * from a different account. So this is safe to run on every boot, and running it
 * on every boot is what makes a project created later get one too.
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
  const provider = validProvider(input.provider);
  const model = validModel(input.model);
  const key = validKey(input.key);

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
  const hint = key.slice(-4);
  await db()
    .insert(judgeConfiguration)
    .values(
      unjudged.map((row) => ({
        projectId: row.id,
        organizationId: row.organizationId,
        provider,
        model,
        // Sealed once per row rather than once for all of them: the envelope
        // carries its own initialisation vector, and reusing one across rows
        // is the mistake this repeats a cheap operation to avoid.
        credentials: sealCredentials({ key }),
        credentialsHint: hint,
        createdBy: row.createdBy,
        updatedAt: now,
      })),
    )
    // A project that gained a judge between the read above and this write kept
    // it. Nothing here is a race worth locking for; the losing side is the
    // deployment's default, which is exactly the side that should lose.
    .onConflictDoNothing({ target: judgeConfiguration.projectId });

  return unjudged.map((row) => row.id);
}
