import type { FastifyInstance, FastifyReply } from "fastify";

import type { Identity } from "../auth/better-auth.ts";
import {
  openResetLink,
  safeReturnPath,
  RETURN_TO_HEADER,
} from "../auth/password-reset.ts";
import {
  providerRefusal,
  sendProviderRefusal,
} from "../http/provider-refusal.ts";

/**
 * Unauthenticated password-reset routes relay token/password operations to
 * the identity provider. Verify Egma's signed link and expiration before
 * completion; translate provider failures into API refusals.
 */

export type PasswordResetRoutesOptions = {
  readonly identity: Identity;
  /** Where the provider's endpoints live, so the relay can find them. */
  readonly authBasePath: string;
  /** The origin the provider is configured for, and the one it trusts. */
  readonly baseUrl: string;
  /** What a link is sealed under, which is what signs sessions. */
  readonly secret: string;
};

type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function passwordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRoutesOptions,
): Promise<void> {
  /**
   * Return the same accepted response for known and unknown email addresses.
   * Provider background handling keeps SMTP latency off this response path.
   */
  app.post("/api/password-reset", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const email = text(body.email);
    if (email === "") {
      return reply.code(400).send({
        error: "invalid_request",
        message: "an email address is needed to send a reset link to",
      });
    }

    // Where the person was before they came here, if they were anywhere. It is
    // checked at the door rather than left to the page that reads it back, so
    // nothing that is not a path on this instance ever reaches a message.
    const returnTo = safeReturnPath(body.next);

    const response = await options.identity.handler(
      new Request(
        `${options.baseUrl}${options.authBasePath}/request-password-reset`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // The provider checks where a state-changing request came from. It
            // came from the origin it is configured for, because that is the
            // only origin egma is served on.
            origin: options.baseUrl,
            // Who is calling, for the provider's own per-caller budget — the
            // address Fastify resolved under the proxy setting, never the
            // caller's own claim.
            "x-forwarded-for": request.ip,
            ...(returnTo === null ? {} : { [RETURN_TO_HEADER]: returnTo }),
          },
          body: JSON.stringify({ email }),
        },
      ),
    );

    // The provider answers the same way for an address it knows and one it does
    // not, and this route keeps that true. What can still be refused is the
    // shape of what was typed — `not an email address` says nothing about who
    // holds an account — and how often somebody asked, which says nothing about
    // it either: that budget is keyed on where the request came from and never
    // on whose address is in it.
    if (!response.ok) {
      // A provider that could not take the request at all is a fault rather
      // than a refusal — nobody reading it can act on it, and an operator has
      // to see it. Everything a caller *can* act on is answered as an answer.
      if (response.status >= 500) {
        throw new Error(
          `the auth provider could not take a password reset request: ${response.status}`,
        );
      }

      // The one thing a refusal here can be about is the address that was
      // typed, and egma says that in its own words. The provider's sentence for
      // it names its own body parser — `[body.email] Invalid email address` —
      // which describes code rather than the situation a person is in.
      if (response.status === 400) {
        return reply.code(400).send({
          error: "invalid_request",
          message: `${email} is not an email address`,
        });
      }

      // Anything else, and being asked to wait is the one that happens, goes
      // through the same translation the signup door uses.
      return sendProviderRefusal(
        reply,
        await providerRefusal(response, {
          error: "invalid_request",
          message: "that reset could not be asked for",
        }),
      );
    }

    return reply.code(202).header("cache-control", "no-store").send({
      message:
        "if that address has an Egma account, a link to set a new password " +
        "is on its way to it.",
    });
  });

  /**
   * Verify link signature and expiry before asking the provider to reset.
   * Success requires a separate sign-in; this route creates no session.
   */
  app.post("/api/password-reset/complete", async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    const sealed = text(body.token);
    const password = typeof body.password === "string" ? body.password : "";

    if (sealed === "") return noLink(reply);
    if (password === "") {
      return reply.code(400).send({
        error: "invalid_request",
        message: "a new password is needed",
      });
    }

    const link = openResetLink(sealed, options.secret);
    if (link === null) return noLink(reply);

    if (link.expiresAt.getTime() <= Date.now()) return cannotTell(reply);

    const response = await options.identity.handler(
      new Request(`${options.baseUrl}${options.authBasePath}/reset-password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: options.baseUrl,
          "x-forwarded-for": request.ip,
        },
        body: JSON.stringify({ token: link.token, newPassword: password }),
      }),
    );

    if (!response.ok) {
      const refusal = await providerRefusal(response, {
        error: "invalid_request",
        message: "that password could not be set",
      });

      // Map invalid_token before the signed deadline to already-used. This does
      // not prove a password write succeeded: token consumption can precede a
      // failed write, and this route cannot inspect that intermediate state.
      if (refusal.error === "invalid_token") return alreadyUsed(reply);

      // Everything else is about the password that was typed — too short is the
      // one that happens — or about how often somebody asked. Both go back with
      // the provider's own sentence and egma's own code, through the same
      // translation the signup relay uses.
      return sendProviderRefusal(reply, refusal);
    }

    return reply
      .header("cache-control", "no-store")
      .send({ reset: true, message: "that password is set. Sign in with it." });
  });
}

/**
 * A link that names nothing here — never minted by this egma, or edited since
 * it was. Deliberately one answer for both, because to whoever is holding it
 * they are the same thing, and telling them apart would say more about the
 * secret than anybody needs to know.
 */
function noLink(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: "no_such_reset_link",
    message:
      "that reset link does not name anything. Check it was copied whole, or " +
      "ask for another.",
  });
}

/** Checked: the provider has consumed the token, so somebody used the link. */
function alreadyUsed(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error: "reset_link_already_used",
    message:
      "that link has already been used, so the password behind it has been " +
      "set. Sign in with it, or ask for another link if it was not you who " +
      "used it.",
  });
}

/**
 * Past the signed deadline, do not infer whether the token was used earlier.
 * The link contains a readable raw token, so the provider must enforce the
 * same lifetime independently.
 */
function cannotTell(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error: "reset_link_no_longer_works",
    message:
      "that link no longer works, and it is too old now for Egma to say " +
      "whether it was used before it ran out. If you set a password with it, " +
      "sign in with that one. If nothing happened, ask for another link.",
  });
}
