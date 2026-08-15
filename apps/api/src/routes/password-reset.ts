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
 * Getting back in, for somebody who cannot sign in to ask.
 *
 * Both routes are deliberately outside the credentialed scope, on the
 * invitation routes' terms and for the invitation routes' reason: whoever is
 * using this has no session — that is the entire point — so there is no
 * `AuthContext` to resolve them into and no organization to key a budget on.
 * **The link is the credential here**, and it names exactly one account.
 *
 * The provider owns the token, the hash and the password. These own the one
 * thing the provider has no way to say, for as long as it is knowable at all:
 * *which* dead link a person is holding. It consumes a token on the way past,
 * so a spent link and an expired one both come back as one word,
 * `Invalid token` — and "you already did this" and "nothing happened at all"
 * are opposite instructions.
 *
 * **The rule every refusal here is written to is that egma never names a state
 * it has not checked.** Inside the hour a link states, egma can tell the two
 * apart and says which. Past it, both systems have forgotten the token at the
 * same moment — there is one deadline, deliberately — so egma says that it
 * cannot tell rather than picking the likelier one. A refusal that guessed
 * wrong would tell somebody to go on using a password that no longer signs them
 * in, which is worse than one that admits what it does not know.
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
   * egma's; one that opens and is past its deadline is dead, and dead is the
   * whole of what egma knows about it, because the provider's own record of the
   * token went at the same moment; and inside the deadline the provider is
   * asked to set the password, where a refusal can only mean the token was
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
 * Dead, and egma cannot say which way — the honest answer past the hour.
 *
 * "You already did this" and "nothing happened at all" are worth keeping apart
 * only while both are things egma has checked, and past the deadline neither
 * is: the provider was configured with that same deadline, so its record of the
 * token is gone and there is nothing left to ask. Saying "it ran out" would
 * tell somebody their old password still works when it may not; saying "it was
 * used" would tell them it has changed when it may not have. So this one says
 * both, and what to do either way.
 *
 * **This is the cost of there being one number**, and it is paid deliberately.
 * A second, longer deadline at the provider would leave a record to read past
 * the first — and would also be a second, longer way in for anybody holding the
 * raw token, which is readable straight out of any link.
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
