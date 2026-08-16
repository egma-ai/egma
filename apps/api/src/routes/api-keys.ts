import {
  authorize,
  createApiKey,
  listApiKeys,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  revokeApiKey,
  type ApiKey,
  type ListedApiKey,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import { mintApiKeySecret } from "../auth/api-key.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * Working with keys: see the ones you may see, mint one, retire one.
 *
 * These are the first routes in egma that a key can be used on, which is what
 * makes the end of `egma login` verifiable rather than asserted. They take
 * either credential — a browser session or a key — and neither is privileged
 * over the other, because a key already resolves to the same context a session
 * would.
 *
 * **The list is filtered, not gated.** An `admin` sees every key in the
 * organization; everybody else sees the keys they minted. Refusing the whole
 * call would leave a `viewer` holding a key they could never see or rotate,
 * which is a worse outcome than either reading of the permission table. The
 * filtering itself lives in the data-access module, so no route can forget it.
 */

export type ApiKeyRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A key as a list is allowed to describe it. Never the secret. */
function described(key: ApiKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    scope: key.scope,
    organization_id: key.organizationId,
    project_id: key.projectId,
    // Enough to tell one key from another, and not enough to be one.
    looks_like: `${key.prefix}…${key.displaySuffix}`,
    created_by_user_id: key.createdByUserId,
    created_at: key.createdAt.toISOString(),
    last_used_at: key.lastUsedAt?.toISOString() ?? null,
    revoked_at: key.revokedAt?.toISOString() ?? null,
  };
}

/** A listed key also names its creator in a form a person can recognize. */
function describedForList(key: ListedApiKey): Record<string, unknown> {
  return {
    ...described(key),
    created_by_email: key.createdByEmail,
  };
}

export async function apiKeyRoutes(
  app: FastifyInstance,
  options: ApiKeyRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  app.get("/api/keys", async (request, reply) => {
    const { auth } = requesterOf(request);
    const keys = await listApiKeys(auth);
    return reply.send({ keys: keys.map(describedForList) });
  });

  /**
   * Minting. Gated on `mint_own_api_key`, which every role holds.
   *
   * The organization is the credential's, always. A body that names one is not
   * refused and is not obeyed — it is simply not consulted, because the whole
   * point of resolving the customer from the credential is that nothing a
   * client sends can move a request into somebody else's account.
   */
  app.post("/api/keys", async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    // body.organization_id is read by nothing, on purpose. See above.

    authorize(auth, "mint_own_api_key", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const projectId = text(body.project_id) || null;
    const minted = mintApiKeySecret();

    let key: ApiKey;
    try {
      key = await createApiKey(auth, {
        hash: minted.hash,
        prefix: minted.prefix,
        displaySuffix: minted.displaySuffix,
        name: text(body.name) || null,
        projectId,
      });
    } catch (cause) {
      if (cause instanceof ProjectOutsideOrganizationError) {
        return reply.code(403).send({
          error: "project_outside_organization",
          message:
            "that project belongs to a different organization, and the organization on a key comes from the credential rather than from the request",
        });
      }
      throw cause;
    }

    // The one time this string exists outside the terminal that will hold it.
    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({ ...described(key), secret: minted.secret });
  });

  /**
   * Retiring one. It stops working on the very next request, because
   * verification reads the row rather than a cache.
   *
   * A key that is not yours and not visible to you is answered the same way as
   * a key that does not exist, because to you those are the same thing.
   */
  app.post("/api/keys/:apiKeyId/revoke", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { apiKeyId } = request.params as { apiKeyId: string };

    const revoked = await revokeApiKey(auth, apiKeyId);
    if (revoked === undefined) {
      return reply.code(404).send({
        error: "no_such_key",
        message: "no key of yours by that name is still live",
      });
    }

    return reply.send(described(revoked));
  });

  /**
   * A refusal decided by the permission model is an answer, not a fault. It
   * carries who was refused what, because a permission failure a developer
   * cannot read is one they work around rather than fix.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }
    throw error;
  });
}
