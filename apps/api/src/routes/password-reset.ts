import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Identity } from "../auth/better-auth.ts";
import {
  openResetLink,
  providerRecordSurvives,
  safeReturnPath,
  RETURN_TO_HEADER,
  type ResetLink,
} from "../auth/password-reset.ts";
import {
  providerRefusal,
  sendProviderRefusal,
} from "../http/provider-refusal.ts";
import { notFound } from "../http/refusals.ts";

/**
 * Getting back in, for somebody who cannot sign in to ask.
 *
 * Both routes are deliberately outside the credentialed scope, on the
 * invitation routes' terms and for the invitation routes' reason: whoever is
 * using this has no session — that is the entire point — so there is no
 * `AuthContext` to resolve them into and no organization to key a budget on.
 * **The link is the credential here**, and it names exactly one account.
 *
 * The provider owns the token, the hash and the password. These own the one
 * thing the provider has no way to say: *which* dead link a person is holding.
 * It consumes a token on the way past, so a spent link and an expired one both
 * come back as one word, `Invalid token` — and "you already did this" and
 * "nothing happened at all" are opposite instructions.
 *
 * **The rule every refusal here is written to is that egma never names a state
 * it has not checked.** Where it can tell the two apart it says which; where it
 * cannot it says that, rather than picking the likelier one. A refusal that
 * guesses wrong tells somebody to go on using a password that no longer signs
 * them in, which is worse than one that admits what it does not know.
 *
 * Relaying to the provider's own endpoints rather than calling methods is the
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

/** Where the provider's own lookup is told to land. Nobody ever follows it. */
const RESET_PAGE = "/reset-password";

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
   *
   * That promise is about how long the answer takes as much as about what it
   * says, and the length is decided next door: the handler in
   * `auth/better-auth.ts` is what keeps posting the message off the path the
   * answer travels back along.
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
        "if that address has an egma account, a link to set a new password " +
        "is on its way to it.",
    });
  });

  /**
   * Setting the new password, behind the link.
   *
   * The order is what makes each refusal true. A link that will not open is not
   * egma's; one that opens and is past its deadline is answered by asking the
   * provider what it still holds, which spends nothing; and inside the deadline
   * the provider is asked to set the password, where a refusal can only mean
   * the token was already consumed.
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
      return await pastTheDeadline(request, reply, link);
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
      const refusal = await providerRefusal(response, {
        error: "invalid_request",
        message: "that password could not be set",
      });

      // The provider's word for a token it does not know, in egma's spelling.
      // Egma has already ruled out the other two ways to reach it — a link it
      // never minted, and one past its deadline — so what is left is a link
      // that was used.
      //
      // What that leaves unverified, and it is named rather than hidden: the
      // provider consumes the token before it writes the password, so a failure
      // between the two steps would spend a link and change nothing, and this
      // sentence would then say a password had been set that had not. That is
      // the provider's ordering rather than egma's, egma cannot see between the
      // two steps from out here, and no run has produced it.
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

  /**
   * The provider's own reset endpoint, shut.
   *
   * **Egma's deadline is only egma's deadline while it is the only way in.**
   * The seal on a link is signed and not encrypted — whoever holds one can read
   * the provider's token straight out of it — and the provider's whole surface
   * is served publicly under this instance's origin. Without this, the hour
   * stated in the message, on the page and in the README would be the hour
   * egma's own door honours, while seventy minutes was the hour that actually
   * applied. Stating one and enforcing the other is exactly the kind of untruth
   * the rest of this file exists to prevent.
   *
   * Shutting this door rather than shortening the provider's deadline is what
   * lets the extra minutes go on doing their real job: being the record of
   * whether a link was ever spent, so that a refusal past the deadline can name
   * which of two opposite things happened.
   *
   * It is Fastify's own routing and not a filter — an exact path beats the
   * wildcard the provider's surface is mounted on — and egma's own relay calls
   * the provider's handler directly, so nothing inside these routes is touched.
   */
  app.post(`${options.authBasePath}/reset-password`, async (_request, reply) =>
    notFound(
      reply,
      "egma does not set a password here. Send the token from the reset link " +
        "to POST /api/password-reset/complete instead — that is the door this " +
        "egma answers on, and the one that honours the link's own deadline.",
    ),
  );

  /**
   * A link egma no longer honours, and which of the two things it is.
   *
   * The provider is asked what it still holds, through the one endpoint of its
   * own that reads a reset token **without spending it**. A token it still
   * knows is a token nobody used, so the link truly ran out of time and nothing
   * changed. A token it does not know is a token somebody used — but only while
   * the provider's own record would certainly still be there. Past that, a
   * missing record says nothing, and neither does egma.
   */
  async function pastTheDeadline(
    request: FastifyRequest,
    reply: FastifyReply,
    link: ResetLink,
  ): Promise<FastifyReply> {
    if (!providerRecordSurvives(link, new Date())) return cannotTell(reply);

    const unspent = await stillUnspent(request, link.token);
    if (unspent === true) return ranOutOfTime(reply);
    if (unspent === false) return alreadyUsed(reply);
    return cannotTell(reply);
  }

  /**
   * Whether the provider still holds this token, without consuming it.
   *
   * `undefined` when the answer was neither of the two the provider gives —
   * which is a fault worth an operator's attention, and to the person waiting
   * is simply one more thing egma does not know.
   */
  async function stillUnspent(
    request: FastifyRequest,
    token: string,
  ): Promise<boolean | undefined> {
    try {
      const response = await options.identity.handler(
        new Request(
          `${options.baseUrl}${options.authBasePath}/reset-password/` +
            `${encodeURIComponent(token)}` +
            `?callbackURL=${encodeURIComponent(RESET_PAGE)}`,
          {
            method: "GET",
            headers: {
              origin: options.baseUrl,
              "x-forwarded-for": request.ip,
            },
          },
        ),
      );

      // The provider answers this one by redirecting, carrying either the token
      // it still holds or its word for one it does not.
      const sentTo = response.headers.get("location");
      if (sentTo === null) return undefined;
      const answered = new URL(sentTo, options.baseUrl).searchParams;
      if (answered.get("token") === token) return true;
      if (answered.get("error") === "INVALID_TOKEN") return false;
      return undefined;
    } catch (cause) {
      request.log.error(
        { err: cause },
        "the auth provider could not be asked whether a reset link was spent",
      );
      return undefined;
    }
  }
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

/** Checked: the provider still holds the token, so nobody used the link. */
function ranOutOfTime(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error: "reset_link_expired",
    message:
      "that link ran out of time before anybody used it, so nothing has " +
      "changed and the old password still works. Ask for another link.",
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
 * Dead, and egma cannot say which way — the third answer, and the honest one.
 *
 * The two that mean opposite things are worth keeping apart only while both are
 * things egma has checked. Once the provider's record of the link has expired
 * too, there is no way to know whether the link was used before it ran out, and
 * either of the other sentences would be a guess: one tells somebody their old
 * password still works when it may not, the other tells them it has been
 * changed when it may not have been. So this one says both, and what to do
 * either way.
 */
function cannotTell(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error: "reset_link_no_longer_works",
    message:
      "that link no longer works, and it is too old now for egma to say " +
      "whether it was used before it ran out. If you set a password with it, " +
      "sign in with that one. If nothing happened, ask for another link.",
  });
}
