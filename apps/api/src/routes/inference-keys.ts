import {
  createInferenceKey,
  listInferenceKeys,
  managedDeployment,
  NotPermittedError,
  resolveInferenceKey,
  revokeInferenceKey,
  UnprocessableInputError,
  type AuthContext,
  type InferenceKey,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  hashInferenceKeySecret,
  INFERENCE_KEY_HEADER,
  inferenceKeySecretOn,
  mintInferenceKeySecret,
} from "../auth/inference-key.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { invalid, sendRefusal, unprocessable, REFUSALS } from "../http/refusals.ts";

/**
 * Inference keys: the credentials a self-hosted deployment presents at the Egma
 * model gateway, minted here and stored as a hash.
 *
 * **Two doors that look alike and are nothing like each other.** The management
 * routes are ordinary product routes: a person's session or a product key opens
 * them, only an `admin` may use them, and no route can answer with a stored key
 * because the store has none to answer with. The validation route below is the
 * *only* door in Egma an inference key itself opens, and it answers one fact —
 * which organization the key belongs to.
 *
 * **These routes exist on hosted Egma and nowhere else.** Egma operates the
 * gateway and keeps the provider accounts behind it, so Egma is the only
 * deployment that can say what an inference key means. A self-hosted
 * installation answers `404` here, which is the honest shape: there is nothing
 * at this address on that deployment rather than something an administrator is
 * failing to reach.
 */

export type InferenceKeyRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const INFERENCE_KEYS_PATH = "/api/inference-keys";
export const INFERENCE_KEY_PATH = "/api/inference-keys/:inferenceKeyId";
export const INFERENCE_KEY_VALIDATION_PATH = "/v1/inference-keys/validation";

type Body = Record<string, unknown>;

/** A key as a list is allowed to describe it. Never the secret. */
function described(key: InferenceKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    // Enough to tell one key from another, and not enough to be one.
    looks_like: key.looksLike,
    created_at: key.createdAt.toISOString(),
    created_by_user_id: key.createdByUserId,
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

function refuseRole(
  reply: FastifyReply,
  auth: AuthContext,
  action: string,
): FastifyReply {
  return sendRefusal(reply, "not_permitted", REFUSALS.notPermitted(auth.role, action));
}

/**
 * Not here on this deployment.
 *
 * A `404` rather than a refusal, because a refusal would say "you may not do
 * this" about something nobody on a self-hosted deployment could ever do. The
 * sentence says where the thing actually is.
 */
function notHosted(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: "not_found",
    message:
      "inference keys are created in Egma Cloud, which operates the Egma model gateway and the provider accounts behind it. This deployment connects one; it does not mint them.",
  });
}

export async function inferenceKeyRoutes(
  app: FastifyInstance,
  options: InferenceKeyRoutesOptions,
): Promise<void> {
  /**
   * The one door an inference key opens, and the reason it is registered before
   * the credentialed hook rather than inside it.
   *
   * **An inference key is refused by every normal Egma product interface**, and
   * that is a property of where secrets are looked up rather than a rule a door
   * remembers: the product's resolver reads the `api_key` table, and an
   * inference key is not in it. This route reads the other table, answers one
   * fact, and establishes no context at all — there is no `AuthContext` here for
   * anything to widen.
   *
   * **Content-free.** No body is read and none is expected. What comes back is
   * an organization identifier and a key identifier: enough for a self-hosted
   * deployment to bind itself and for the gateway to know whose connection this
   * is, and nothing about anybody's simulations, personas or models.
   *
   * The budget is keyed on where the request came from rather than on an
   * organization, because a request that fails to resolve one has no
   * organization to charge. It bounds guessing without letting a stranger spend
   * a customer's allowance.
   */
  app.post(INFERENCE_KEY_VALIDATION_PATH, async (request, reply) => {
    if (!managedDeployment().hosted) return notHosted(reply);

    const verdict = options.rateLimit.reached(`inference-validation:${request.ip}`);
    if (!verdict.allowed) {
      return reply
        .code(429)
        .header("retry-after", String(verdict.retryAfterSeconds))
        .send({
          error: "too_many_requests",
          message: "too many inference-key validations from this address",
        });
    }

    const secret = inferenceKeySecretOn(request.headers);
    if (secret === null) {
      return reply.code(401).send({
        error: "no_inference_key",
        message: `this request carried no inference key; send it as ${INFERENCE_KEY_HEADER}`,
      });
    }

    const resolved = await resolveInferenceKey(hashInferenceKeySecret(secret));
    if (resolved === undefined) {
      // One sentence for "never existed" and "revoked" alike. Which of the two
      // it is would tell somebody holding a guessed key that they had guessed
      // one that once existed.
      return reply.code(401).send({
        error: "inference_key_refused",
        message: "this inference key does not authorize managed model access",
      });
    }

    return reply.send({
      organization_id: resolved.organizationId,
      inference_key_id: resolved.inferenceKeyId,
    });
  });

  /**
   * The management routes, inside their own scope.
   *
   * Encapsulated rather than registered beside the validation route above,
   * because `credentialed` is a hook on a scope: a route in the same scope
   * would be behind it whatever order it was declared in. The validation door
   * takes no session and no product key, so it has to be outside — and a scope
   * is what makes "outside" a structural fact rather than a line ordering
   * somebody could move.
   */
  void app.register(async (scope) => {
    credentialed(scope, {
      provider: options.provider,
      rateLimit: options.rateLimit,
    });
    await managementRoutes(scope, options);
  });
}

async function managementRoutes(
  app: FastifyInstance,
  options: InferenceKeyRoutesOptions,
): Promise<void> {
  app.get(INFERENCE_KEYS_PATH, async (request, reply) => {
    if (!managedDeployment().hosted) return notHosted(reply);
    const { auth } = requesterOf(request);

    try {
      const keys = await listInferenceKeys(auth);
      return reply.send({ keys: keys.map(described) });
    } catch (refusal) {
      if (refusal instanceof NotPermittedError) {
        return refuseRole(reply, auth, "see this organization's inference keys");
      }
      throw refusal;
    }
  });

  /**
   * Mint one. **The plaintext is in this response and in no other, ever.**
   *
   * There is no route that reads it back and no column it could be read out of:
   * the store is handed a hash, a prefix and four characters, and never the
   * secret itself. An administrator who loses it creates another and revokes
   * this one, which is also how rotation works.
   */
  app.post(INFERENCE_KEYS_PATH, async (request, reply) => {
    if (!managedDeployment().hosted) return notHosted(reply);
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "create an inference key");
    }

    const name = given(text(body.name));
    if (name === undefined) {
      return invalid(
        reply,
        "an inference key needs a name — which installation it is for — so that a list of several says which one to revoke",
      );
    }

    const minted = mintInferenceKeySecret();
    try {
      const created = await createInferenceKey(auth, {
        name,
        hash: minted.hash,
        prefix: minted.prefix,
        displaySuffix: minted.displaySuffix,
      });
      return reply.code(201).send({
        ...described(created),
        // Shown once, here, and nowhere again.
        key: minted.secret,
      });
    } catch (refusal) {
      if (refusal instanceof UnprocessableInputError) {
        return unprocessable(reply, refusal.message);
      }
      throw refusal;
    }
  });

  /**
   * Retire one, effective on the next connection the gateway opens.
   *
   * Not a replacement: create the new key first, connect it where it is needed,
   * and revoke this one afterwards. That order is what makes rotation overlap
   * safely, and it is why an organization may hold several active keys at once.
   */
  app.delete(INFERENCE_KEY_PATH, async (request, reply) => {
    if (!managedDeployment().hosted) return notHosted(reply);
    const { auth } = requesterOf(request);
    const { inferenceKeyId } = request.params as { inferenceKeyId: string };

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "revoke an inference key");
    }

    const revoked = await revokeInferenceKey(auth, inferenceKeyId);
    if (revoked === undefined) {
      // One answer for a key that was never here, one that belongs to somebody
      // else, and one already revoked. Telling them apart would answer a
      // question about another customer's account.
      return reply.code(404).send({
        error: "not_found",
        message: "no active inference key of that identifier is in this organization",
      });
    }
    return reply.send(described(revoked));
  });
}
