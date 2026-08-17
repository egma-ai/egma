import {
  IdentityConflictError,
  listModelProviderCredentials,
  ManagedAccessNotConnectedError,
  MODEL_ACCESS_MODES,
  MODEL_JOBS,
  PROVIDER_CATALOG,
  RECOMMENDED_ENTRY,
  readModelAccess,
  removeModelProviderCredential,
  RESERVED_PROVIDER_JOBS,
  setModelAccess,
  storeModelProviderCredential,
  UnprocessableInputError,
  type AuthContext,
  type ModelProviderCredential,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  invalid,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";

/**
 * Model providers: who supplies the keys this organization's model traffic
 * spends, and — where the organization supplies them — the keys themselves.
 *
 * **No route in this file can answer with a stored key, and that is the shape
 * rather than a rule anybody follows.** The data-access module's read shape has
 * no field a secret could travel in; the one door to a plaintext key refuses
 * every context that did not come from a simulation or a grading claim. So an
 * admin replaces a key by sending a new value and never by reading the old one,
 * and what comes back is a provider and four characters — enough to tell two
 * keys apart and no part of either.
 *
 * **Nothing here calls a provider.** Saving a key seals it and stops. A
 * validation request would make saving depend on the provider being up, would
 * spend on the customer's account to answer a question nobody asked, and would
 * still not be true a minute later. Wrong permissions and expired keys are
 * reported when the provider is used, where the report can name the simulation
 * it stopped.
 *
 * **Nothing here scans for completeness.** Changing the access mode does not
 * walk the organization's personas and graders looking for a provider whose key
 * is missing, and is not refused because one is. A checklist standing between
 * an admin and a setting they can plainly see is the blocked feeling this whole
 * effort removes; the honest report arrives per simulation instead, naming the
 * provider it could not open.
 */

export type ModelAccessRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const MODEL_ACCESS_PATH = "/api/model-access";
export const MODEL_CATALOG_PATH = "/api/model-catalog";
export const MODEL_PROVIDER_CREDENTIALS_PATH = "/api/model-provider-credentials";
export const MODEL_PROVIDER_CREDENTIAL_PATH =
  "/api/model-provider-credentials/:provider";

type Body = Record<string, unknown>;

const ACCESS_KEYS = ["mode"] as const;
const CREDENTIAL_KEYS = ["provider", "key", "expected_revision"] as const;

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
 * A credential on the wire: whose provider it is for, four characters of it,
 * and when it last changed.
 *
 * **The envelope is absent from this shape rather than blanked**, which is what
 * makes leaking one impossible to forget rather than merely unlikely: there is
 * no field to fill in wrongly.
 */
function described(credential: ModelProviderCredential): Record<string, unknown> {
  return {
    provider: credential.provider,
    hint: credential.hint,
    revision: credential.revision,
    updated_at: credential.updatedAt.toISOString(),
  };
}

export async function modelAccessRoutes(
  app: FastifyInstance,
  options: ModelAccessRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The provider catalog: which providers do which model job, and the model a
   * release proved for each.
   *
   * **Server-owned, and the browser keeps no second copy.** A page that
   * maintained its own list would be a list that can disagree with this one,
   * and the disagreement is a provider somebody can select and nothing can
   * execute. Readable at every role, because a persona author picking a model
   * needs it and none of it is a secret.
   */
  app.get(MODEL_CATALOG_PATH, async (_request, reply) => {
    return reply.send({
      jobs: MODEL_JOBS,
      providers: PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        job: entry.job,
        label: entry.label,
        recommended_model: entry.recommendedModel,
        ...(entry.recommendedVoiceId === undefined
          ? {}
          : { recommended_voice_id: entry.recommendedVoiceId }),
        // What a form fills in before anybody types, so a first persona starts
        // from a choice a release actually proved.
        recommended: RECOMMENDED_ENTRY[entry.job].provider === entry.provider,
        // Model and voice ids are never allowlisted: a release proves one
        // default per entry and a user may enter any id the shipped adapter
        // accepts. Egma keeping a list of every model a provider has would be a
        // list that is wrong the week after it ships.
        model_is_free_text: true,
      })),
      // The provider-job pairs the product intends and this release has not
      // proved. Named so the shape of the finished catalog is visible; none of
      // them is selectable, because none has an entry above.
      reserved: RESERVED_PROVIDER_JOBS.map((one) => ({
        provider: one.provider,
        job: one.job,
      })),
    });
  });

  /**
   * Which of the two access modes this organization is on, and the keys it
   * holds.
   *
   * One read rather than two, because the screen draws them together: what the
   * mode is decides whether the credential rows below it are what pays for
   * anything. Readable at every role — neither the word nor a hint is a secret,
   * and a `viewer` looking at a persona's Models form has to be able to see who
   * supplies the key behind it.
   */
  app.get(MODEL_ACCESS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const [access, credentials] = await Promise.all([
      readModelAccess(auth),
      listModelProviderCredentials(auth),
    ]);

    return reply.send({
      mode: access.mode,
      updated_at: access.updatedAt?.toISOString() ?? null,
      modes: MODEL_ACCESS_MODES,
      /**
       * Whether managed access can be chosen at all on this deployment.
       *
       * `false` while nothing is connected to Egma's own provider accounts,
       * which is every deployment today. A form that offered the choice anyway
       * would be offering a setting the server refuses, and the refusal would
       * arrive after somebody had already decided.
       */
      managed_available: false,
      credentials: credentials.map(described),
    });
  });

  app.put(MODEL_ACCESS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "change model access");
    }

    const unknown = unknownKeyIn(body, ACCESS_KEYS, "a model access choice");
    if (unknown !== undefined) return invalid(reply, unknown);

    const mode = given(text(body.mode));
    if (mode === undefined) {
      return invalid(
        reply,
        `a model access choice names a mode: ${MODEL_ACCESS_MODES.join(" or ")}`,
      );
    }

    try {
      const chosen = await setModelAccess(auth, mode);
      return reply.send({
        mode: chosen.mode,
        updated_at: chosen.updatedAt?.toISOString() ?? null,
      });
    } catch (refusal) {
      if (refusal instanceof ManagedAccessNotConnectedError) {
        return unprocessable(reply, refusal.message);
      }
      if (refusal instanceof UnprocessableInputError) {
        return unprocessable(reply, refusal.message);
      }
      throw refusal;
    }
  });

  /**
   * Every model-provider credential the organization holds.
   *
   * Readable at every role, because it is what a Models form reads to say which
   * providers are configured. What comes back is a provider and a hint.
   */
  app.get(MODEL_PROVIDER_CREDENTIALS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const credentials = await listModelProviderCredentials(auth);
    return reply.send({ items: credentials.map(described) });
  });

  /**
   * Store this organization's key for one provider, adding it or replacing it.
   *
   * **One verb for both**, because there is one credential per provider by
   * construction: "add" and "replace" are the same request with the same
   * effect, and two doors would differ only in which of them refuses when the
   * caller guessed wrong about what is already stored.
   */
  app.put(MODEL_PROVIDER_CREDENTIALS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "manage model-provider credentials");
    }

    const unknown = unknownKeyIn(
      body,
      CREDENTIAL_KEYS,
      "a model-provider credential",
    );
    if (unknown !== undefined) return invalid(reply, unknown);

    const provider = given(text(body.provider));
    const key = given(text(body.key));
    if (provider === undefined) {
      return invalid(reply, "a model-provider credential names its provider");
    }
    if (key === undefined) {
      return invalid(reply, "a model-provider credential needs a key");
    }

    try {
      const stored = await storeModelProviderCredential(auth, {
        provider,
        key,
        // Absent skips the check, which is what an admin adding a provider's
        // first key means. Present is a replacement written against a read,
        // and a stale one is told the stored key moved rather than silently
        // landing on top of somebody else's rotation.
        expectedRevision: given(text(body.expected_revision)),
      });
      return reply.send(described(stored));
    } catch (refusal) {
      if (refusal instanceof IdentityConflictError) {
        return sendRefusal(reply, "conflict", refusal.message);
      }
      if (refusal instanceof UnprocessableInputError) {
        return unprocessable(reply, refusal.message);
      }
      throw refusal;
    }
  });

  /**
   * Take the organization's key for one provider away.
   *
   * Nothing is scanned first: no frozen plan and no pinned version names this
   * row — a persona and a grader name the *provider* — so there is no work to
   * strand and no history to make unreadable. A simulation that then needs one
   * lands as an infrastructure error naming the provider, which is a better
   * answer than a credential nobody meant to keep.
   */
  app.delete(MODEL_PROVIDER_CREDENTIAL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { provider } = request.params as { provider: string };

    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "manage model-provider credentials");
    }

    try {
      const removed = await removeModelProviderCredential(auth, provider);
      // Removing one the organization never held is the same outcome, said
      // without pretending a row existed.
      return reply.send({ removed: removed !== undefined, provider });
    } catch (refusal) {
      if (refusal instanceof UnprocessableInputError) {
        return unprocessable(reply, refusal.message);
      }
      throw refusal;
    }
  });
}
