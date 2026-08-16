import {
  AlreadyBelongsToAnOrganizationError,
  authorize,
  changeRole,
  createInvitation,
  deactivateUser,
  LastAdminError,
  listMembers,
  listPendingInvitations,
  NotPermittedError,
  permits,
  readOrganization,
  removeMember,
  ROLES,
  type Invitation,
  type Member,
  type Role,
} from "@egma/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EmailSender } from "../auth/email.ts";
import {
  invitationLink,
  mintInvitationToken,
} from "../auth/invitation.ts";
import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * Who is in this organization, and the four things an admin may do about it:
 * ask somebody to join, change what somebody may do, remove them, and switch
 * an account off.
 *
 * **Every one of them is gated on `manage_members`, which only an `admin`
 * holds.** Reading the list is not: everybody may read anything in the
 * organization, and a `member` who cannot see who their colleagues are cannot
 * work out who to ask for anything.
 *
 * **Inviting never depends on email.** With a transport configured the message
 * is posted; with none, the link comes straight back to the person who created
 * it and they pass it on however they like. Nothing errors and nothing quietly
 * does nothing, which is the failure this route exists to avoid: a self-hosted
 * install is pleasant right up until the second person, and requiring SMTP is
 * where competitors make that the moment it stops being pleasant.
 */

export type MemberRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  readonly emailSender: EmailSender;
  /** The instance's own origin, and where an invitation link points. */
  readonly baseUrl: string;
};

type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function describedMember(member: Member): Record<string, unknown> {
  return {
    user_id: member.userId,
    email: member.email,
    name: member.name,
    role: member.role,
    joined_at: member.joinedAt.toISOString(),
    deactivated_at: member.deactivatedAt?.toISOString() ?? null,
  };
}

/** An invitation as a list may describe it. Never the link; only its hash was kept. */
function describedInvitation(invitation: Invitation): Record<string, unknown> {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expires_at: invitation.expiresAt.toISOString(),
    created_by: invitation.createdBy,
    created_at: invitation.createdAt.toISOString(),
  };
}

export async function memberRoutes(
  app: FastifyInstance,
  options: MemberRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /** Everybody may see who is here. Reading is not what roles are for. */
  app.get("/api/members", async (request, reply) => {
    const { auth } = requesterOf(request);
    const members = await listMembers(auth);
    return reply.send({
      members: members.map(describedMember),
      // So a page can render the actions it is allowed to offer, rather than
      // offering everything and finding out. Deciding what to *show* is
      // `permits`; deciding what to allow is `authorize`, on each route below.
      may_manage_members: permits(auth, "manage_members", {
        organizationId: auth.organizationId,
        projectId: auth.projectId,
      }),
    });
  });

  app.get("/api/invitations", async (request, reply) => {
    const { auth } = requesterOf(request);
    authorize(auth, "manage_members", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const invitations = await listPendingInvitations(auth);
    return reply.send({ invitations: invitations.map(describedInvitation) });
  });

  /**
   * Asking somebody to join.
   *
   * The token is minted here, hashed once, and only the hash is written — so a
   * copy of the database is a pile of expired-looking rows rather than a pile of
   * working links. The plaintext exists for the length of this request and then
   * only in whichever of the two places it went: a message, or this response.
   *
   * The role defaults to `admin`, which is the default for everybody in this
   * version. An organization whose second person cannot invite a third is a
   * two-person product.
   */
  app.post("/api/invitations", async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "manage_members", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const email = text(body.email).toLowerCase();
    if (email === "" || !email.includes("@")) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "an invitation needs an email address to be for",
      });
    }

    const asked = text(body.role) || "admin";
    if (!isRole(asked)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `a role is one of ${ROLES.join(", ")}`,
      });
    }

    const minted = mintInvitationToken();

    let invitation: Invitation;
    try {
      invitation = await createInvitation(auth, {
        email,
        role: asked,
        tokenHash: minted.hash,
        expiresAt: minted.expiresAt,
      });
    } catch (cause) {
      if (cause instanceof AlreadyBelongsToAnOrganizationError) {
        return reply.code(409).send({
          error: cause.here ? "already_a_member_here" : "already_a_member",
          message: cause.here
            ? `${cause.email} is already in this organization.`
            : `${cause.email} already belongs to an organization. One person belongs to one organization in this version, so they cannot be invited into a second.`,
        });
      }
      throw cause;
    }

    const link = invitationLink(options.baseUrl, minted.token);
    const organization = await readOrganization(auth);
    const joining = organization?.name ?? "an organization";

    // Posted if there is anywhere to post it, and handed back if there is not.
    // The link is withheld from the response once it has actually been sent,
    // because at that point the person it names is the one who should hold it.
    await options.emailSender.send({
      to: email,
      subject: `Join ${joining} on Egma`,
      body:
        `You have been invited to ${joining} on Egma.\n\n${link}\n\n` +
        `The link works once, and expires on ${minted.expiresAt.toDateString()}.`,
    });

    return reply
      .code(201)
      .header("cache-control", "no-store")
      .send({
        ...describedInvitation(invitation),
        delivered: options.emailSender.delivers,
        ...(options.emailSender.delivers ? {} : { accept_url: link }),
      });
  });

  /**
   * Somebody's role, changed.
   *
   * Nothing else has to happen afterwards. A key carries no role of its own and
   * re-reads its creator's membership on every request, so this is complete the
   * moment the row is written.
   */
  app.post("/api/members/:userId/role", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { userId } = request.params as { userId: string };
    const body = (request.body ?? {}) as Body;

    authorize(auth, "manage_members", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const asked = text(body.role);
    if (!isRole(asked)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: `a role is one of ${ROLES.join(", ")}`,
      });
    }

    const changed = await changeRole(auth, userId, asked);
    if (changed === undefined) return notHere(reply);
    return reply.send(describedMember(changed));
  });

  /**
   * Somebody removed. Their keys are revoked and everything they authored stays
   * exactly where it is, with their name still on it.
   */
  app.post("/api/members/:userId/remove", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { userId } = request.params as { userId: string };

    authorize(auth, "manage_members", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const removed = await removeMember(auth, userId);
    if (removed === undefined) return notHere(reply);
    return reply.send({
      user_id: removed.userId,
      keys_revoked: removed.keysRevoked,
    });
  });

  /**
   * An account switched off, which is the deprovisioning half rather than the
   * membership half: every key they minted stops working on the very next
   * request, and their membership and their name on what they authored stay.
   */
  app.post("/api/members/:userId/deactivate", async (request, reply) => {
    const { auth } = requesterOf(request);
    const { userId } = request.params as { userId: string };

    authorize(auth, "manage_members", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const deactivated = await deactivateUser(auth, userId);
    if (deactivated === undefined) return notHere(reply);
    return reply.send(describedMember(deactivated));
  });

  /**
   * Refusals decided by the permission model, and the one decided by the shape
   * of an organization, are answers rather than faults. Both carry why, because
   * a refusal a person cannot read is one they work around.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return reply
        .code(403)
        .send({ error: "not_permitted", message: error.message });
    }
    if (error instanceof LastAdminError) {
      return reply.code(409).send({
        error: "last_admin",
        message:
          "this is the organization's last admin, and an organization with " +
          "no admin is one nobody can invite, re-role or remove anybody in " +
          "ever again. Make somebody else an admin first.",
      });
    }
    throw error;
  });
}

/** A person who is not in the caller's organization is a person who is not there. */
function notHere(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({
    error: "no_such_member",
    message: "nobody by that name is in this organization",
  });
}
