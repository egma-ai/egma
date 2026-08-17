import {
  connectManagedAccess,
  disconnectManagedAccess,
  IdentityConflictError,
  listModelProviderCredentials,
  managedAccessAvailable,
  managedDeployment,
  ManagedAccessBoundElsewhereError,
  ManagedAccessNotConnectedError,
  MODEL_ACCESS_MODES,
  MODEL_JOBS,
  PROVIDER_CATALOG,
  RECOMMENDED_ENTRY,
  readManagedAccessConnection,
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

/**
 * What one content-free validation request answered.
 *
 * Three outcomes rather than two, for the reason the gateway keeps three: a key
 * Egma Cloud could not be asked about is not a bad key, and telling an
 * administrator to check the value they just pasted when Egma Cloud was down
 * would send them looking in the wrong place.
 */
export type ManagedValidation =
  | { readonly outcome: "valid"; readonly organizationId: string }
  | { readonly outcome: "refused" }
  | { readonly outcome: "unreachable" };

const VALIDATION_REFUSAL: Readonly<Record<"refused" | "unreachable", string>> = {
  refused:
    "Egma Cloud does not recognise this inference key. Create one under Inference keys in Egma Cloud and paste the value it shows you; a key that was revoked cannot be connected again.",
  unreachable:
    "Egma Cloud could not be reached, so this key was neither accepted nor refused. Nothing has changed here; try again when it answers.",
};

export type ModelAccessRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /**
   * The one content-free ask, as a seam.
   *
   * A seam rather than a call written inline, because this is the one place the
   * product reaches out of the deployment on a person's behalf — and the
   * deterministic suite has to be able to stand a real Egma Cloud in front of it
   * without a network. What crosses is a key and what comes back is an
   * organization identifier: no simulation, no persona, no model, no payload.
   */
  readonly validate: (key: string) => Promise<ManagedValidation>;
};

/**
 * Hosted Egma has nothing to connect, and says where the answer really lives.
 *
 * A `404` rather than a refusal, for the reason the inference-key routes answer
 * one on a self-hosted deployment: there is nothing at this address here, and a
 * "you may not" would suggest somebody with more authority could.
 */
function managedIsInternal(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: "not_found",
    message:
      "this deployment supplies managed model access internally, so there is no inference key to connect. Managed by Egma is available under Model access.",
  });
}

export const MODEL_ACCESS_PATH = "/api/model-access";
export const MODEL_CATALOG_PATH = "/api/model-catalog";
export const MODEL_PROVIDER_CREDENTIALS_PATH = "/api/model-provider-credentials";
export const MODEL_PROVIDER_CREDENTIAL_PATH =
  "/api/model-provider-credentials/:provider";
export const MANAGED_ACCESS_PATH = "/api/managed-access";

type Body = Record<string, unknown>;

const ACCESS_KEYS = ["mode"] as const;
const CREDENTIAL_KEYS = ["provider", "key", "expected_revision"] as const;
const MANAGED_KEYS = ["key"] as const;

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
    const [access, credentials, connection, available] = await Promise.all([
      readModelAccess(auth),
      listModelProviderCredentials(auth),
      readManagedAccessConnection(auth),
      managedAccessAvailable(auth),
    ]);

    return reply.send({
      mode: access.mode,
      updated_at: access.updatedAt?.toISOString() ?? null,
      modes: MODEL_ACCESS_MODES,
      /**
       * Whether managed access can be chosen at all right now.
       *
       * Always true on hosted Egma, which operates the gateway and signs its
       * own credentials, so there is nothing to connect. On a self-hosted
       * deployment it is true once an inference key is connected. A form that
       * offered the choice otherwise would be offering a setting the server
       * refuses, and the refusal would arrive after somebody had decided.
       */
      managed_available: available,
      /**
       * Which of the two managed stories this deployment tells.
       *
       * A fact about the deployment rather than about the organization, and the
       * screen needs it to know which shape to draw: hosted managed access is a
       * state to read, and self-hosted managed access is a key to connect.
       */
      hosted: managedDeployment().hosted,
      managed: {
        connected: connection.connected,
        hint: connection.hint,
        cloud_organization_id: connection.cloudOrganizationId,
        connected_at: connection.updatedAt?.toISOString() ?? null,
      },
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
   * Connect the inference key this deployment presents at the Egma model
   * gateway, or replace the one it presents now.
   *
   * **One content-free validation request stands between the paste and
   * Connected**, and it is the whole reason this route is not just a write.
   * Egma Cloud is asked whether the key is good and which organization owns it;
   * only then is anything stored, and what is stored includes that answer — so
   * a key belonging to another Egma Cloud organization is refused next time
   * rather than silently moving this deployment's spend onto somebody else's
   * account.
   *
   * **The key is not exchanged for anything.** What comes back is an identifier,
   * not a grant and not a provider credential; the key itself is what every
   * later connection presents. There is no per-simulation round trip here or
   * anywhere else.
   *
   * Hosted Egma answers `404`: it signs its own credentials and has nothing to
   * connect, so a route that accepted a pasted key there would be a second
   * authentication story nobody asked for.
   */
  app.put(MANAGED_ACCESS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (managedDeployment().hosted) return managedIsInternal(reply);
    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "connect managed model access");
    }

    const unknown = unknownKeyIn(body, MANAGED_KEYS, "a managed access connection");
    if (unknown !== undefined) return invalid(reply, unknown);

    const key = given(text(body.key));
    if (key === undefined) {
      return invalid(
        reply,
        "connecting managed access needs the inference key Egma Cloud showed you when you created it",
      );
    }

    const validated = await options.validate(key);
    if (validated.outcome !== "valid") {
      return unprocessable(reply, VALIDATION_REFUSAL[validated.outcome]);
    }

    try {
      const connected = await connectManagedAccess(auth, {
        key,
        cloudOrganizationId: validated.organizationId,
      });
      return reply.send({
        connected: connected.connected,
        hint: connected.hint,
        cloud_organization_id: connected.cloudOrganizationId,
        connected_at: connected.updatedAt?.toISOString() ?? null,
      });
    } catch (refusal) {
      if (refusal instanceof ManagedAccessBoundElsewhereError) {
        return sendRefusal(reply, "conflict", refusal.message);
      }
      if (refusal instanceof UnprocessableInputError) {
        return unprocessable(reply, refusal.message);
      }
      throw refusal;
    }
  });

  /**
   * Disconnect it.
   *
   * The access mode is deliberately left alone. An organization that is on
   * managed access and disconnects lands its next claim as a visible
   * infrastructure error naming what to reconnect, which is a better answer
   * than this route quietly choosing somebody's access mode for them.
   */
  app.delete(MANAGED_ACCESS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);

    if (managedDeployment().hosted) return managedIsInternal(reply);
    if (auth.role !== "admin") {
      return refuseRole(reply, auth, "disconnect managed model access");
    }

    const removed = await disconnectManagedAccess(auth);
    return reply.send({ disconnected: removed });
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
