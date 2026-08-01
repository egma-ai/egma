import {
  authorize,
  createApiKey,
  membershipsOf,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  recordDeviceAuthorization,
  resolveDeviceAuthorization,
  type AuthContext,
} from "@egma/db";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { mintApiKeySecret } from "../auth/api-key.ts";
import type { Identity } from "../auth/better-auth.ts";
import { DEVICE_CLIENT_ID, normalizeUserCode } from "../auth/device.ts";
import { resolveSession, type Session } from "../auth/session.ts";
import { toWebRequest } from "../http/web-handler.ts";

/**
 * Logging in from a terminal, without a secret ever passing through a chat
 * window.
 *
 * Both approaches to `egma login` end with a key on disk. Only one of them puts
 * that key in the coding agent's transcript on the way there, which is why the
 * terminal never asks a person to paste anything: it shows a short code, a
 * browser opens with that code already in the field, and the person approves it
 * where they can see who they are and what they are approving.
 *
 * **Where the work is split.** The provider owns RFC 8628's mechanics — issuing
 * the pair of codes, claiming one for a signed-in person, the polling interval,
 * and what state a code is in. egma owns the two things the provider has no
 * field for and no opinion about: which organization and project the terminal
 * is being let into, and what the terminal ends up holding. The provider's own
 * token endpoint would hand back a session; egma hands back an API key against
 * egma's own table, so that every request the terminal ever makes afterwards
 * runs no provider code at all.
 *
 * The provider's endpoints are reached by relaying to its HTTP surface, exactly
 * as signup does, rather than by widening the seam. The seam is four calls and
 * a fifth is a decision somebody makes on purpose; approving and denying are
 * not egma asking the provider a question, they are a browser talking to the
 * provider through egma's origin.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type DeviceRoutesOptions = {
  readonly identity: Identity;
  /** Where the provider's endpoints live, so the relay can find them. */
  readonly authBasePath: string;
  /** The origin the provider is configured for, and the one it trusts. */
  readonly baseUrl: string;
};

type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What the provider said, as a code egma can switch on. */
async function refusalCode(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  return typeof body.error === "string" ? body.error : "invalid_request";
}

export async function deviceRoutes(
  app: FastifyInstance,
  options: DeviceRoutesOptions,
): Promise<void> {
  // RFC 8628's token endpoint is form-encoded, and this is egma's own route
  // rather than the provider's, so this scope needs its own parser. Registered
  // here rather than on the server means every other route still gets JSON.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  /** The provider's own surface, reached through egma's origin. */
  async function relay(
    path: string,
    init: { method: string; cookie?: string | undefined; body?: unknown },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The provider checks where a state-changing request came from. It came
      // from the origin it is configured for, because that is the only origin
      // egma is served on.
      origin: options.baseUrl,
    };
    if (init.cookie !== undefined) headers.cookie = init.cookie;

    return options.identity.handler(
      new Request(`${options.baseUrl}${options.authBasePath}${path}`, {
        method: init.method,
        headers,
        ...(init.body === undefined
          ? {}
          : { body: JSON.stringify(init.body) }),
      }),
    );
  }

  /**
   * Claiming a code for the person looking at the page, which is also how the
   * provider answers what state the code is in. The provider refuses to approve
   * a code nobody has claimed, so this runs before approving as well as when
   * the page first loads.
   */
  async function claim(
    userCode: string,
    cookie: string,
  ): Promise<"pending" | "approved" | "denied" | "expired" | "unknown"> {
    const response = await relay(
      `/device?user_code=${encodeURIComponent(userCode)}`,
      { method: "GET", cookie },
    );

    if (!response.ok) {
      return (await refusalCode(response)) === "expired_token"
        ? "expired"
        : "unknown";
    }

    const body = (await response.json().catch(() => ({}))) as {
      status?: unknown;
    };
    const status = text(body.status);
    return status === "approved" || status === "denied" ? status : "pending";
  }

  /**
   * Start. A terminal asks for a pair of codes and the address to send a person
   * to, and that address is this instance's own.
   */
  app.post("/api/device/code", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const clientId = text(body.client_id) || DEVICE_CLIENT_ID;

    const grant =
      await options.identity.provider.startDeviceAuthorization(clientId);

    return reply.header("cache-control", "no-store").send({
      device_code: grant.deviceCode,
      user_code: grant.userCode,
      verification_uri: grant.verificationUri,
      verification_uri_complete: grant.verificationUriComplete,
      expires_in: grant.expiresInSeconds,
      interval: grant.intervalSeconds,
    });
  });

  /**
   * What the approval page needs: whether this code is still worth approving,
   * and what the person would be authorizing the terminal for.
   *
   * A code nobody recognises and a code that sat too long are different
   * answers, because they send a person to different pages — one says check
   * what you typed, the other says the product did not break, it timed out.
   */
  app.get("/api/device/authorization", async (request, reply) => {
    const query = request.query as { user_code?: unknown };
    const userCode = normalizeUserCode(text(query.user_code));
    if (userCode === "") {
      return reply
        .code(400)
        .send({ error: "invalid_request", message: "no code was given" });
    }

    const session = await signedIn(request, reply);
    if (session === null) return reply;

    const status = await claim(userCode, request.headers.cookie ?? "");
    if (status !== "pending") {
      return reply.send({ status });
    }

    const organization = session.organizations[0];
    if (organization === undefined) {
      return reply.code(409).send({
        error: "not_provisioned",
        message: "this account is in no organization, so there is nothing to authorize a terminal for",
      });
    }

    return reply.send({
      status: "pending",
      user_code: userCode,
      organization: { id: organization.id, name: organization.name },
      projects: session.projects.map((project) => ({
        id: project.id,
        name: project.name,
      })),
    });
  });

  /**
   * Approving. The person says yes, and says which project.
   *
   * Gated on `mint_own_api_key`, which every role holds — including `viewer`,
   * deliberately. Login mints a key as its final step, so an admin-only rule
   * here would close the product to everybody who is not an admin.
   *
   * The choice is recorded before the provider is told to approve, and not
   * after: between those two moments the terminal is polling, and a code that
   * is approved but not yet aimed is one the terminal could collect with no
   * project on it.
   */
  app.post("/api/device/approve", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const userCode = normalizeUserCode(text(body.user_code));

    const session = await signedIn(request, reply);
    if (session === null) return reply;

    const auth = session.auth;
    if (auth === undefined) {
      return reply.code(409).send({
        error: "not_provisioned",
        message: "this account is in no organization, so there is nothing to authorize a terminal for",
      });
    }

    authorize(auth, "mint_own_api_key", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const projectId = text(body.project_id) || auth.projectId;

    const cookie = request.headers.cookie ?? "";
    const status = await claim(userCode, cookie);
    if (status !== "pending") return reply.send({ status });

    try {
      const aimed = await recordDeviceAuthorization(auth, {
        userCode,
        projectId,
      });
      if (!aimed) return reply.send({ status: "unknown" });
    } catch (cause) {
      if (cause instanceof ProjectOutsideOrganizationError) {
        return reply.code(403).send({
          error: "project_outside_organization",
          message:
            "that project belongs to a different organization, so a terminal cannot be authorized for it",
        });
      }
      throw cause;
    }

    const approved = await relay("/device/approve", {
      method: "POST",
      cookie,
      body: { userCode },
    });
    if (!approved.ok) {
      return reply.send({ status: await deviceAnswer(approved) });
    }

    return reply.send({ status: "approved" });
  });

  /** Denying. The other answer, and the one a stranger's code should get. */
  app.post("/api/device/deny", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const userCode = normalizeUserCode(text(body.user_code));

    const session = await signedIn(request, reply);
    if (session === null) return reply;

    const cookie = request.headers.cookie ?? "";
    const status = await claim(userCode, cookie);
    if (status !== "pending") return reply.send({ status });

    const denied = await relay("/device/deny", {
      method: "POST",
      cookie,
      body: { userCode },
    });
    if (!denied.ok) {
      return reply.send({ status: await deviceAnswer(denied) });
    }

    return reply.send({ status: "denied" });
  });

  /**
   * Collecting. The terminal exchanges its device code for a key.
   *
   * What is recorded on the authorization has to be read **before** the
   * exchange, because exchanging consumes the row. Everything after that is
   * egma's own: the identity the provider named becomes a membership, the
   * membership becomes a role, and a fresh secret is minted, hashed once and
   * handed over. It is handed over here and nowhere else, ever again.
   *
   * There is no `expires_in` in the answer, and that is the protocol saying
   * what the product means: keys never expire. Rotation is mint, deploy,
   * revoke, so there is no window in which a deployment is unauthenticated and
   * no timer nobody remembers setting.
   */
  app.post("/api/device/token", async (request, reply) => {
    const body = (request.body ?? {}) as Body;

    if (text(body.grant_type) !== DEVICE_GRANT) {
      return oauthError(
        reply,
        400,
        "unsupported_grant_type",
        `this endpoint understands ${DEVICE_GRANT} and nothing else`,
      );
    }

    const deviceCode = text(body.device_code);
    if (deviceCode === "") {
      return oauthError(
        reply,
        400,
        "invalid_request",
        "no device code was given",
      );
    }

    const target = await resolveDeviceAuthorization(deviceCode);

    const polled =
      await options.identity.provider.pollDeviceAuthorization(deviceCode);

    if (typeof polled === "string") {
      return oauthError(reply, 400, WAITING[polled].error, WAITING[polled].said);
    }

    if (target === undefined) {
      return oauthError(
        reply,
        400,
        "invalid_grant",
        "this authorization was approved without naming an organization and a project, so there is nothing to mint a key for. Start again from the terminal.",
      );
    }

    const userId = polled.externalIdentityId;
    const membership = (await membershipsOf(userId)).find(
      (held) => held.organizationId === target.organizationId,
    );
    if (membership === undefined) {
      return oauthError(
        reply,
        400,
        "invalid_grant",
        "the person who approved this is no longer in that organization",
      );
    }

    const auth: AuthContext = {
      userId,
      organizationId: membership.organizationId,
      projectId: target.projectId,
      role: membership.role,
      via: "session",
    };

    // The same gate as the approval page, checked again where the key is
    // actually written. A role can change between approving and collecting, and
    // the answer that counts is the one at the moment of the write.
    authorize(auth, "mint_own_api_key", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const minted = mintApiKeySecret();
    let key;
    try {
      key = await createApiKey(auth, {
        hash: minted.hash,
        prefix: minted.prefix,
        displaySuffix: minted.displaySuffix,
        name: `${DEVICE_CLIENT_ID} login`,
        projectId: target.projectId,
      });
    } catch (cause) {
      // The project went away between approving and collecting. Nothing is
      // minted rather than something minted somewhere else.
      if (cause instanceof ProjectOutsideOrganizationError) {
        return oauthError(
          reply,
          400,
          "invalid_grant",
          "the project this terminal was authorized for is gone. Start again from the terminal.",
        );
      }
      throw cause;
    }

    return reply
      .header("cache-control", "no-store")
      .header("pragma", "no-cache")
      .send({
        access_token: minted.secret,
        token_type: "Bearer",
        api_key_id: key.id,
        organization_id: key.organizationId,
        project_id: key.projectId,
        scope: key.scope,
      });
  });

  /**
   * A refusal decided by the permission model is an answer, not a fault.
   *
   * Nothing reaches this today, because every role may mint a key for itself
   * and that is the only permission the flow checks. It is here so that the day
   * somebody narrows that row, login refuses in a way a person can read rather
   * than reporting that the server broke.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }
    throw error;
  });

  /** The session behind this request, or a 401 already written. */
  async function signedIn(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Session | null> {
    const session = await resolveSession(
      options.identity.provider,
      toWebRequest(request),
    );
    if (session === null) {
      void reply.code(401).send({
        status: "signed_out",
        error: "not_signed_in",
        message: "sign in before approving a terminal",
      });
      return null;
    }
    return session;
  }
}

/** What a poll that is not a person means to the terminal waiting on it. */
const WAITING = {
  pending: {
    error: "authorization_pending",
    said: "nobody has approved this yet",
  },
  slow_down: {
    error: "slow_down",
    said: "polling faster than the interval this authorization was issued with",
  },
  denied: { error: "access_denied", said: "this was denied in the browser" },
  expired: { error: "expired_token", said: "this authorization is over" },
} as const;

/** What the provider's own refusal means to the page that asked. */
async function deviceAnswer(response: Response): Promise<string> {
  const code = await refusalCode(response);
  if (code === "expired_token") return "expired";
  return "unknown";
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description: string,
): FastifyReply {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send({ error, error_description: description });
}
