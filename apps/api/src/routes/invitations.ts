import { acceptInvitation, readInvitation } from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import { hashInvitationToken } from "../auth/invitation.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { resolveSession } from "../auth/session.ts";
import { toIdentityRequest } from "../http/web-handler.ts";

/**
 * Invitation lookup uses the token rather than requiring organization
 * membership. These routes are outside organization rate limits. Accept tokens
 * in request bodies to keep them out of API query-string logs.
 */

export type InvitationRoutesOptions = {
  readonly provider: SessionIdentityProvider;
};

type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function invitationRoutes(
  app: FastifyInstance,
  options: InvitationRoutesOptions,
): Promise<void> {
  /**
   * What a link says: which organization, for whom, at what role, and whether
   * it is still worth following.
   *
   * **An expired invitation and an accepted one are told apart**, because they
   * mean opposite things to the person holding the link. One says ask for
   * another; the other says you are already in, sign in.
   */
  app.post("/api/invitations/lookup", async (request, reply) => {
    const token = text((request.body as Body | undefined)?.token);
    if (token === "") return noToken(reply);

    const invitation = await readInvitation(hashInvitationToken(token));
    if (invitation === undefined) return unknown(reply);

    return reply.header("cache-control", "no-store").send({
      state: invitation.state,
      email: invitation.email,
      role: invitation.role,
      organization: { name: invitation.organizationName },
      expires_at: invitation.expiresAt.toISOString(),
    });
  });

  /**
   * Existing accounts accept with a valid session, without requiring current
   * organization membership. New accounts accept through signup.
   */
  app.post("/api/invitations/accept", async (request, reply) => {
    const token = text((request.body as Body | undefined)?.token);
    if (token === "") return noToken(reply);

    const session = await resolveSession(
      options.provider,
      toIdentityRequest(request),
    );
    if (session === null) {
      return reply.code(401).send({
        error: "not_signed_in",
        message: "sign in, or sign up with this link, to accept an invitation",
      });
    }

    const accepted = await acceptInvitation(
      hashInvitationToken(token),
      session.userId,
    );

    switch (accepted.outcome) {
      case "unknown":
        return unknown(reply);
      case "already_in_an_organization":
        return reply.code(409).send({
          error: "already_a_member",
          message:
            "this account already belongs to an organization, and one person belongs to one organization in this version",
        });
      case "expired":
        return reply.code(409).send({
          error: "invitation_expired",
          message:
            "that invitation has expired. Ask an admin to send another one.",
        });
      case "already_accepted":
        return reply.code(409).send({
          error: "invitation_already_accepted",
          message:
            "that invitation has already been accepted. If it was you, you are already in.",
        });
      case "for_somebody_else":
        return reply.code(403).send({
          error: "invitation_for_somebody_else",
          message: `that invitation was sent to ${accepted.email}, so it is that address it lets in. Sign in as them, or ask for one of your own.`,
        });
      case "accepted":
        return reply.send({
          organization: {
            id: accepted.organizationId,
            name: accepted.organizationName,
          },
          project: { id: accepted.projectId, name: accepted.projectName },
          role: accepted.role,
        });
    }
  });
}

function noToken(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: "invalid_request",
    message: "no invitation link was given",
  });
}

/**
 * A link that names nothing. Deliberately the same answer as a link into
 * somebody else's instance, because to whoever is holding it those are the same
 * thing — and telling them apart would make this an oracle for guessing tokens.
 */
function unknown(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: "no_such_invitation",
    message:
      "that invitation link does not name anything. Check it was copied whole, or ask for another.",
  });
}
