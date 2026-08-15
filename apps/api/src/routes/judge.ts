import {
  createJudgeCredential,
  editJudgeCredential,
  getJudgeCredential,
  getProjectJudge,
  IdentityConflictError,
  JudgeProviderMismatchError,
  listJudgeCredentials,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  setProjectJudge,
  UnprocessableInputError,
  JUDGE_PROVIDERS,
  PLATFORM_JUDGE,
  type AuthContext,
  type JudgeCredential,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { Config } from "../config.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  invalid,
  notPermitted,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";

/**
 * The judge: which model decides an LLM judgment here, and which of the
 * organization's keys it is asked with.
 *
 * **No route in this file can answer with a stored key, and that is the whole
 * design rather than a rule anybody follows.** The data-access module's read
 * shape has no field a secret could travel in — there is one door to a
 * plaintext judge key and it refuses every context that did not come from a
 * grading claim — so an admin replaces a credential by sending a new value, and
 * never by reading the old one. What comes back is a label and four characters,
 * which exist for one job: telling two keys apart when deciding which project
 * should spend from which.
 *
 * **The project setting stores a reference, never a copy.** Choosing a judge is
 * picking a provider, a model, and one of two sources — an organization
 * credential, or the deployment's own `platform` judge — and no secret travels
 * in either direction on that request at all. A project that has neither is in
 * `needs_setup`, which is a state the page states plainly rather than an error:
 * LLM grading is unavailable until an admin finishes setup.
 *
 * **Archive is deliberately absent.** Removing a credential has to be refused
 * while an active project points at it, while a nonterminal simulation's frozen
 * plan names it, and while a claimed grading job still needs it — and frozen
 * grading plans arrive with the run-planning effort. Exposing the door before
 * the protection would strand grading work mid-flight.
 */

export type JudgeRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /**
   * The judge this deployment was started with, if it was started with one.
   *
   * It is handed to the choice below rather than looked for on the project's
   * row, because a project that moved to a credential of its own no longer
   * holds the deployment's envelope — and the sentinel has to stay choosable
   * after that, or moving away from it once would be moving away for good.
   */
  readonly defaultJudge?: Config["defaultJudge"];
};

export const JUDGE_CREDENTIALS_PATH = "/api/judge-credentials";
export const JUDGE_CREDENTIAL_PATH = "/api/judge-credentials/:credentialId";
export const PROJECT_JUDGE_PATH = "/api/judge";

type Body = Record<string, unknown>;
type Query = { readonly project?: string };

const CREDENTIAL_KEYS = ["label", "provider", "key", "expected_revision"] as const;
const JUDGE_KEYS = ["provider", "model", "source", "project"] as const;

function unknownKeyIn(
  body: Body,
  allowed: readonly string[],
  what: string,
): string | undefined {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    return `${what} has no key "${key}"; it holds ${allowed.join(", ")}`;
  }
  return undefined;
}

function refuseRole(
  reply: FastifyReply,
  auth: AuthContext,
  action: string,
): FastifyReply {
  return sendRefusal(
    reply,
    "not_permitted",
    REFUSALS.notPermitted(auth.role, action),
  );
}

/**
 * A credential on the wire: what it is called, whose provider it is for, and
 * four characters of it.
 *
 * **The envelope is absent from this shape rather than blanked**, which is what
 * makes leaking one impossible to forget rather than merely unlikely: there is
 * no field to fill in wrongly.
 */
function described(credential: JudgeCredential): Record<string, unknown> {
  return {
    id: credential.id,
    label: credential.label,
    provider: credential.provider,
    hint: credential.hint,
    revision: credential.revision,
    created_at: credential.createdAt.toISOString(),
    updated_at: credential.updatedAt.toISOString(),
  };
}

export async function judgeRoutes(
  app: FastifyInstance,
  options: JudgeRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The providers and the sources this deployment knows about, so a form asks
   * for what egma can actually use.
   *
   * **One registry on the server, exactly as the grader types have one.** A
   * browser that invented a provider would offer somebody a judge egma has no
   * way to speak to, and the failure would arrive as errored verdicts after
   * real calls had been paid for.
   */
  app.get(`${PROJECT_JUDGE_PATH}/registry`, async (_request, reply) => {
    return reply.send({
      providers: JUDGE_PROVIDERS.map((provider) => ({
        provider,
        // Model validation is the provider's registry entry rather than a list
        // frozen into a form: a model released this morning must be nameable
        // without shipping a new browser bundle. What the server holds is the
        // provider and the seam that can speak to it.
        model_is_free_text: true,
      })),
      platform_sentinel: PLATFORM_JUDGE,
      // Whether the sentinel is offered at all. A deployment that named no
      // judge of its own has none to give, and a form that offered it anyway
      // would be offering a setting the server refuses.
      platform_judge_available: options.defaultJudge !== undefined,
    });
  });

  /**
   * Every judge credential the organization holds.
   *
   * Readable at every role: it is the list a project's judge setting chooses
   * from, and somebody reading that setting has to be able to see which
   * credential it names. What they see is a label and a hint.
   */
  app.get(JUDGE_CREDENTIALS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const credentials = await listJudgeCredentials(auth);
    return reply.send({ items: credentials.map(described) });
  });

  app.post(JUDGE_CREDENTIALS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "manage judge credentials");
    }

    const unknown = unknownKeyIn(body, CREDENTIAL_KEYS, "a judge credential");
    if (unknown !== undefined) return invalid(reply, unknown);

    const created = await createJudgeCredential(auth, {
      label: text(body.label),
      provider: text(body.provider),
      key: typeof body.key === "string" ? body.key : "",
    });

    return reply.code(201).send(described(created));
  });

  /**
   * A credential relabelled, its secret replaced whole, or both.
   *
   * **Rotation keeps the identity**, deliberately: every project pointing at
   * this credential keeps pointing at it, pending grading claims the new key
   * when it gets there, and nothing anywhere has to be repointed because a key
   * changed. The old secret never comes back — not to this route, and not to
   * any other.
   */
  app.patch(JUDGE_CREDENTIAL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { credentialId } = request.params as { credentialId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "manage judge credentials");
    }

    const unknown = unknownKeyIn(body, CREDENTIAL_KEYS, "a judge credential");
    if (unknown !== undefined) return invalid(reply, unknown);

    if ("provider" in body) {
      return unprocessable(
        reply,
        "a judge credential's provider is set when it is created and cannot " +
          "be changed: the key belongs to one provider's account, and every " +
          "project pointing at this credential would start spending somewhere " +
          "else. Add a credential for the other provider instead.",
      );
    }

    const edited = await editJudgeCredential(
      auth,
      credentialId,
      {
        ...("label" in body ? { label: text(body.label) } : {}),
        ...("key" in body
          ? { key: typeof body.key === "string" ? body.key : "" }
          : {}),
      },
      {
        ...(given(text(body.expected_revision)) === undefined
          ? {}
          : { expectedRevision: text(body.expected_revision) }),
      },
    );

    if (edited === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        REFUSALS.notFound("judge credential", credentialId),
      );
    }
    return reply.send(described(edited));
  });

  /**
   * A single credential, by its id — a label and a hint, and never a key.
   *
   * It exists so that a page can name the credential a project spends from
   * without listing every credential the organization holds. There is nothing
   * more here than the list answers with, because there is nothing more that
   * may ever be answered.
   */
  app.get(JUDGE_CREDENTIAL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { credentialId } = request.params as { credentialId: string };

    const credential = await getJudgeCredential(auth, credentialId);
    if (credential === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        REFUSALS.notFound("judge credential", credentialId),
      );
    }
    return reply.send(described(credential));
  });

  /** The project's judge as it stands, or the explicit `needs_setup` state. */
  app.get(PROJECT_JUDGE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const judge = await getProjectJudge(acting.auth);
    if (judge.state === "needs_setup") {
      return reply.send({
        state: "needs_setup",
        provider: null,
        model: null,
        source: null,
        credential_id: null,
        hint: null,
      });
    }

    return reply.send({
      state: "configured",
      project_id: judge.judge.projectId,
      provider: judge.judge.provider,
      model: judge.judge.model,
      source: judge.judge.source,
      credential_id: judge.judge.credentialId,
      // Null for the deployment's own judge: the key belongs to whoever runs
      // this platform, and a customer holding it cannot rotate it and has
      // nothing to tell apart.
      hint: judge.judge.keyHint,
      updated_at: judge.judge.updatedAt.toISOString(),
    });
  });

  /**
   * The project's judge, chosen. **No key travels here, in either direction.**
   *
   * Storing a key is a separate act with its own door, so somebody changing
   * which model judges never has to hold a key to do it — and an admin who has
   * only ever rotated credentials has never read one.
   */
  app.put(PROJECT_JUDGE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "change the project judge");
    }

    const unknown = unknownKeyIn(body, JUDGE_KEYS, "a project judge");
    if (unknown !== undefined) return invalid(reply, unknown);

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    await setProjectJudge(acting.auth, {
      provider: text(body.provider),
      model: text(body.model),
      source: text(body.source),
      ...(options.defaultJudge === undefined
        ? {}
        : { platformJudge: options.defaultJudge }),
    });

    const judge = await getProjectJudge(acting.auth);
    if (judge.state === "needs_setup") {
      throw new Error("the project judge was not written");
    }

    return reply.send({
      state: "configured",
      project_id: judge.judge.projectId,
      provider: judge.judge.provider,
      model: judge.judge.model,
      source: judge.judge.source,
      credential_id: judge.judge.credentialId,
      hint: judge.judge.keyHint,
      updated_at: judge.judge.updatedAt.toISOString(),
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof JudgeProviderMismatchError) {
      return sendRefusal(
        reply,
        "judge_credential_provider_mismatch",
        REFUSALS.judgeCredentialProviderMismatch(
          error.credentialId,
          error.credentialProvider,
          error.judgeProvider,
        ),
      );
    }

    if (error instanceof IdentityConflictError) {
      return sendRefusal(
        reply,
        "identity_conflict",
        REFUSALS.identityConflict(error.resource, error.resourceId),
      );
    }

    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    /**
     * Anything else is a fault, and **its message is never relayed.**
     *
     * Every refusal above carries a sentence somebody wrote to be read. What is
     * left is what nobody wrote: a driver error, a constraint name, a query
     * layer's wrapper — and on these routes the query that failed is one that
     * selected a sealed envelope. Echoing it would put ciphertext and SQL into
     * a browser response, and it would do so on exactly the surface that must
     * never hand anything of a key back. So the caller is told what happened in
     * words this file chose, and the detail goes where faults belong.
     */
    request.log.error({ err: error }, "the judge routes could not answer");
    return sendRefusal(
      reply,
      "unavailable",
      "Egma could not complete this judge request. Nothing was changed. " +
        "Try again, and check the API logs if it keeps happening.",
    );
  });
}

/** The grader group's rule, for the same reason: a page always has a project. */
async function namingAProject(auth: AuthContext, named: string | undefined) {
  if (auth.via === "session" && named === undefined) {
    return { refusal: REFUSALS.projectRequired, code: "project_required" as const };
  }
  return actingIn(auth, named);
}
