import type { FastifyInstance, FastifyReply } from "fastify";

import type { Identity } from "../auth/better-auth.ts";
import { openResetLink } from "../auth/password-reset.ts";

/**
 * Getting back in, for somebody who cannot sign in to ask.
 *
 * Both routes are deliberately outside the credentialed scope, on the
 * invitation routes' terms and for the invitation routes' reason: whoever is
 * using this has no session — that is the entire point — so there is no
 * `AuthContext` to resolve them into and no organization to key a budget on.
 * **The link is the credential here**, and it names exactly one account.
 *
 * The provider owns the token, the hash and the password. These two own the one
 * thing the provider has no way to say: *which* dead link a person is holding.
 * It consumes a token on the way past, so a spent link and an expired one both
 * come back as one word, `Invalid token` — and "you already did this" and
 * "nothing happened at all" are opposite instructions. Egma carries its own
 * deadline inside the link and reads it here, before the provider is asked.
 *
 * Relaying to the provider's own endpoint rather than calling a method is the
 * signup route's pattern, for the signup route's reason: what egma depends on
 * stays the provider's HTTP surface plus four seam calls, so a different
 * provider is a different implementation of the seam rather than an audit of
 * every route.
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
   * Asking for a link.
   *
   * **The answer never says whether that address holds an account here**, and
   * that is the whole shape of this route. An address nobody signed up with and
   * an address somebody did get one status and one sentence, so a form anybody
   * on the internet can reach is never a way to ask egma who its customers are.
   */
  app.post("/api/password-reset", async (request, reply) => {
    const email = text((request.body as Body | undefined)?.email);
    if (email === "") {
      return reply.code(400).send({
        error: "invalid_request",
        message: "an email address is needed to send a reset link to",
      });
    }

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
          },
          body: JSON.stringify({ email }),
        },
      ),
    );

    // The provider answers the same way for an address it knows and one it does
    // not, and this route keeps that true. What can still be refused is the
    // shape of what was typed — `not an email address` says nothing about who
    // holds an account, and a person who typed it needs to be told.
    if (!response.ok) {
      if (response.status !== 400) {
        throw new Error(
          `the auth provider refused a password reset request with ${response.status}`,
        );
      }
      return reply.code(400).send({
        error: "invalid_request",
        message: `${email} is not an email address`,
      });
    }

    return reply.code(202).header("cache-control", "no-store").send({
      message:
        "if that address has an egma account, a link to set a new password " +
        "is on its way to it.",
    });
  });

  /**
   * Setting the new password, behind the link.
   *
   * The order is what makes each refusal true. A link that will not open is not
   * egma's; one that opens and is past its deadline ran out of time, decided
   * here and never asked of the provider; and only then is the provider asked,
   * where — inside egma's deadline — a refusal can only mean the token was
   * already consumed.
   *
   * Nobody is signed in by this. Setting a password and then using it are two
   * steps a person can see, and the second one is the one that proves the first
   * worked.
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

    if (link.expiresAt.getTime() <= Date.now()) {
      return reply.code(409).send({
        error: "reset_link_expired",
        message:
          "that link ran out of time, so nothing has changed. Ask for another " +
          "one and it will work.",
      });
    }

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
      const refusal = (await response.json().catch(() => ({}))) as {
        code?: unknown;
        message?: unknown;
      };

      // The provider's word for a token it does not know. Egma has already
      // ruled out the other two ways to reach it — a link it never minted, and
      // one past its deadline — so what is left is a link that was used.
      if (refusal.code === "INVALID_TOKEN") {
        return reply.code(409).send({
          error: "reset_link_already_used",
          message:
            "that link has already been used, so the password behind it has " +
            "been set. Sign in with it, or ask for another link if it was not " +
            "you who used it.",
        });
      }

      // Everything else is about the password that was typed — too short is the
      // one that happens — and is passed on in the provider's own words, since
      // it is the provider that holds the rule.
      return reply.code(response.status).send({
        error: "invalid_request",
        message:
          typeof refusal.message === "string"
            ? refusal.message
            : "that password could not be set",
      });
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
