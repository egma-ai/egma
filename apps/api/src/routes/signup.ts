import { instanceIsClaimed } from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { Identity } from "../auth/better-auth.ts";
import { withProvisioningIntent } from "../auth/intent.ts";
import { DEFAULT_PROJECT_NAME } from "../auth/naming.ts";
import {
  providerRefusal,
  sendProviderRefusal,
} from "../http/provider-refusal.ts";

/**
 * Relay identity creation with request-local provisioning intent. Hooks
 * create an organization/project or accept an invitation. Provider identity
 * creation and Egma provisioning use separate transactions.
 */

export type SignupRoutesOptions = {
  readonly identity: Identity;
  /** Where the provider's endpoints live, so the relay can find sign-up. */
  readonly authBasePath: string;
  /** The origin the provider is configured for, and the one it trusts. */
  readonly baseUrl: string;
  readonly singleOrganization: boolean;
  /**
   * Mirror EmailSender.delivers and provider verification configuration so
   * the signup response tells the web app whether email confirmation is required.
   */
  readonly emailVerificationRequired: boolean;
};

type SignupBody = {
  readonly email?: unknown;
  readonly password?: unknown;
  readonly name?: unknown;
  readonly organizationName?: unknown;
  readonly projectName?: unknown;
  /** Present when this signup is completing an invitation. */
  readonly invitationToken?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function signupRoutes(
  app: FastifyInstance,
  options: SignupRoutesOptions,
): Promise<void> {
  /**
   * Whether the signup page should show a form or a note about invitations.
   *
   * The answer is repeated as a refusal at the moment an identity is written,
   * because a page that only hides the form is a page somebody posts past.
   */
  app.get("/api/signup/availability", async (_request, reply) => {
    const claimed = options.singleOrganization && (await instanceIsClaimed());
    return reply.send(
      claimed
        ? {
            open: false,
            reason: "invitation_required",
            message:
              "this Egma instance has been claimed. Ask an admin for an invitation.",
          }
        : { open: true },
    );
  });

  app.post("/api/signup", async (request, reply) => {
    const body = (request.body ?? {}) as SignupBody;

    const email = text(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const invitationToken = text(body.invitationToken);
    const organizationName = text(body.organizationName);
    const projectName = text(body.projectName) || DEFAULT_PROJECT_NAME;

    if (email === "" || password === "") {
      return reply
        .code(400)
        .send({ error: "invalid_request", message: "email and password are required" });
    }
    // An invited person names no organization, because the invitation already
    // did. Asking them for one would be asking them to make a thing they are
    // about to be told they cannot have.
    if (invitationToken === "" && organizationName === "") {
      return reply.code(400).send({
        error: "invalid_request",
        message: "an organization needs a name",
      });
    }

    // The provider requires a name on a person and egma does not ask for one at
    // signup, so the local part stands in until they change it. A name is not
    // worth a field on the shortest path in the product.
    const name = text(body.name) || email.slice(0, email.lastIndexOf("@"));

    const relayed = await withProvisioningIntent(
      invitationToken === ""
        ? { kind: "new_organization", organizationName, projectName }
        : { kind: "invitation", token: invitationToken },
      () =>
        options.identity.handler(
          new Request(`${options.baseUrl}${options.authBasePath}/sign-up/email`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // The provider checks where a state-changing request came from.
              // It came from the origin it is configured for, because that is
              // the only origin egma is served on.
              origin: options.baseUrl,
              // The provider budgets signups per caller, and this header is
              // where it looks for who is calling. The address is the one
              // Fastify already resolved under the proxy setting — never the
              // caller's own claim, which would let anybody pick their own
              // budget. Without it, every relayed signup is one anonymous
              // caller sharing one budget for the whole instance.
              "x-forwarded-for": request.ip,
            },
            body: JSON.stringify({ email, password, name }),
          }),
        ),
    );

    const response = relayed.result;

    if (!response.ok) {
      // Use the shared provider-refusal mapping and omit session cookies on failure.
      return sendProviderRefusal(
        reply,
        await providerRefusal(response, {
          error: "signup_failed",
          message:
            "signing up did not complete. Check the email address and the " +
            "password, then send it again.",
        }),
      );
    }

    for (const cookie of response.headers.getSetCookie()) {
      reply.header("set-cookie", cookie);
    }

    const landing = relayed.landing;
    if (landing === undefined) {
      // The identity was written and the hook that provisions did not run,
      // which no code path produces. Saying so is better than sending back a
      // success with nothing in it.
      throw new Error("an identity was created without landing anywhere");
    }

    // Where they actually landed, rather than what they asked for. The two
    // differ for somebody who followed an invitation: they named neither, and
    // the organization that invited them named both.
    return reply.code(201).send({
      userId: landing.userId,
      organization: { id: landing.organizationId, name: landing.organizationName },
      project: { id: landing.projectId, name: landing.projectName },
      role: landing.role,
      emailVerificationRequired: options.emailVerificationRequired,
    });
  });
}
