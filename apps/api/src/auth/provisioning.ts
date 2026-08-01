import {
  acceptInvitation,
  instanceIsClaimed,
  provisionOrganization,
  readInvitation,
  type Acceptance,
} from "@egma/db";

import {
  hashInvitationToken,
  INVITATION_LIFETIME_DAYS,
} from "./invitation.ts";
import { recordLanding } from "./intent.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
  slugify,
} from "./naming.ts";
import {
  SignupClosedError,
  SignupRefusedError,
  type ExternalIdentity,
  type IdentityHooks,
  type Landing,
  type ProvisioningIntent,
} from "./seam.ts";

/**
 * What happens the moment a person exists: they land somewhere, and there are
 * two somewheres.
 *
 * Somebody who came on their own gets an organization and its first project,
 * together, and they are its admin. Somebody following an invitation gets the
 * organization that invited them, at the role it invited them at. Both are one
 * transaction: there is no state in which somebody has an organization and no
 * project, and none in which an invitation is spent without a membership coming
 * out of it.
 *
 * Both refusals are thrown from hooks that run inside the provider's own request
 * handling, which is why they are `SignupRefusedError`s carrying the answer they
 * should become. Put in egma's signup route instead, they would be bypassed by
 * posting straight at the provider's signup endpoint — and on a claimed
 * self-hosted instance that bypass is the whole attack.
 */

/**
 * How many names to try before giving up. A slug is unique across the whole
 * deployment, so two customers both called Acme is an ordinary thing that must
 * not stop the second one — the first gets `acme`, the next `acme-2`. Bounded,
 * because an unbounded retry against a real collision is a hang, and refusing
 * out loud with a name a person can change is better than either.
 */
const SLUG_ATTEMPTS = 5;

/**
 * Whether this person may exist here.
 *
 * An invitation is the thing that gets somebody through a closed door, so it is
 * checked here rather than only where the membership is written — otherwise a
 * claimed instance would refuse an invited person before their identity existed
 * and there would be no way in at all.
 *
 * The link is checked twice: once here, before the identity is written, and
 * again when it is accepted. That is not belt and braces, it is the two
 * questions being different. This one asks *may an account be created for this
 * address*; the other asks *is this link still live at the moment it is spent*,
 * under a lock, which is what makes it single-use.
 */
export function admitIdentity(
  singleOrganization: boolean,
): IdentityHooks["admitIdentity"] {
  return async (email, intent) => {
    if (intent?.kind === "invitation") {
      const invitation = await readInvitation(hashInvitationToken(intent.token));
      if (invitation === undefined) throw new NoSuchInvitationError();
      if (invitation.state === "expired") throw new InvitationExpiredError();
      if (invitation.state === "accepted") {
        throw new InvitationAlreadyAcceptedError();
      }
      if (invitation.email !== email) {
        throw new InvitationForSomebodyElseError(invitation.email);
      }
      return;
    }

    if (!singleOrganization) return;
    if (!(await instanceIsClaimed())) return;
    throw new SignupClosedError(
      "this egma already has an organization, and open signup closed when it " +
        "was claimed. Ask an admin for an invitation.",
    );
  };
}

/** No invitation was ever issued for that link. */
export class NoSuchInvitationError extends SignupRefusedError {
  constructor() {
    super(
      404,
      "no_such_invitation",
      "that invitation link does not name anything. Check it was copied whole, or ask for another.",
    );
    this.name = "NoSuchInvitationError";
  }
}

/**
 * Ran out of time, and said so — rather than sharing one refusal with the link
 * that was already used. They mean opposite things to the person holding one:
 * ask for another, versus you are already in, sign in.
 */
export class InvitationExpiredError extends SignupRefusedError {
  constructor() {
    super(
      409,
      "invitation_expired",
      `that invitation has expired. Ask an admin to send another; they last ${INVITATION_LIFETIME_DAYS} days.`,
    );
    this.name = "InvitationExpiredError";
  }
}

/** Already used. A link is single-use, and this is what that feels like. */
export class InvitationAlreadyAcceptedError extends SignupRefusedError {
  constructor() {
    super(
      409,
      "invitation_already_accepted",
      "that invitation has already been accepted. If it was you, sign in instead.",
    );
    this.name = "InvitationAlreadyAcceptedError";
  }
}

/** The link names one address and the account being made names another. */
export class InvitationForSomebodyElseError extends SignupRefusedError {
  readonly invitedEmail: string;

  constructor(invitedEmail: string) {
    super(
      403,
      "invitation_for_somebody_else",
      `that invitation was sent to ${invitedEmail}, so it is that address it lets in.`,
    );
    this.name = "InvitationForSomebodyElseError";
    this.invitedEmail = invitedEmail;
  }
}

/** Somebody already holds the one organization a person may be in. */
export class AlreadyInAnOrganizationError extends SignupRefusedError {
  constructor() {
    super(
      409,
      "already_a_member",
      "that person already belongs to an organization. Sign in instead.",
    );
    this.name = "AlreadyInAnOrganizationError";
  }
}

/** Every name derived from the one asked for was taken. */
export class OrganizationNameUnavailableError extends SignupRefusedError {
  readonly organizationName: string;

  constructor(organizationName: string) {
    super(
      409,
      "organization_name_unavailable",
      `no address was free for an organization called "${organizationName}". Try another name.`,
    );
    this.name = "OrganizationNameUnavailableError";
    this.organizationName = organizationName;
  }
}

/**
 * The constraint a write broke, if it broke one.
 *
 * Which constraint it was is the difference between "somebody else already has
 * that name, try the next one" and "this person already has an organization,
 * stop" — so it is read rather than guessed at from the message. Drizzle may
 * hand the driver's error back wrapped, so both depths are looked at.
 */
function constraintViolated(error: unknown): string | undefined {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 4; depth += 1) {
    if (typeof at !== "object") break;
    const carrier = at as { constraint?: unknown; cause?: unknown };
    if (typeof carrier.constraint === "string") return carrier.constraint;
    at = carrier.cause;
  }
  return undefined;
}

export function onIdentityCreated(): IdentityHooks["onIdentityCreated"] {
  return async (identity, intent) => {
    recordLanding(
      intent?.kind === "invitation"
        ? await join(identity, intent.token)
        : await provision(identity, intent),
    );
  };
}

/**
 * An invited person, put in the organization that invited them.
 *
 * Nothing is created here: the organization, its projects and its first admin
 * already exist, and what this adds is one membership at the role the
 * invitation named. The default is `admin`, because that is the default for
 * everybody in this version — an organization whose second person cannot invite
 * a third is a two-person product.
 *
 * The refusals below are the same four the door check makes, and they are made
 * again because the door check and the write are not the same moment. Between
 * them a link can be spent by somebody else, which is exactly the race the
 * lock inside `acceptInvitation` exists for.
 */
async function join(
  identity: ExternalIdentity,
  token: string,
): Promise<Landing> {
  const accepted: Acceptance = await acceptInvitation(
    hashInvitationToken(token),
    identity.externalIdentityId,
  );

  switch (accepted.outcome) {
    case "unknown":
      throw new NoSuchInvitationError();
    case "expired":
      throw new InvitationExpiredError();
    case "already_accepted":
      throw new InvitationAlreadyAcceptedError();
    case "for_somebody_else":
      throw new InvitationForSomebodyElseError(accepted.email);
    case "already_in_an_organization":
      throw new AlreadyInAnOrganizationError();
    case "accepted":
      return {
        userId: identity.externalIdentityId,
        organizationId: accepted.organizationId,
        organizationName: accepted.organizationName,
        projectId: accepted.projectId,
        projectName: accepted.projectName,
        role: accepted.role,
      };
  }
}

async function provision(
  identity: ExternalIdentity,
  intent: ProvisioningIntent | undefined,
): Promise<Landing> {
  const named = intent?.kind === "new_organization" ? intent : undefined;
  const organizationName =
    named?.organizationName.trim() || organizationNameFromEmail(identity.email);
  const projectName = named?.projectName.trim() || DEFAULT_PROJECT_NAME;
  const base = slugify(organizationName);

  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    try {
      const provisioned = await provisionOrganization({
        ownerUserId: identity.externalIdentityId,
        organizationName,
        organizationSlug: attempt === 1 ? base : `${base}-${attempt}`,
        projectName,
        projectSlug: slugify(projectName),
      });

      return {
        userId: identity.externalIdentityId,
        organizationId: provisioned.organizationId,
        organizationName,
        projectId: provisioned.projectId,
        projectName,
        role: provisioned.membership.role,
      };
    } catch (cause) {
      const constraint = constraintViolated(cause);
      // One organization per person in v1. The membership is written last, so
      // this refusal takes the organization and the project down with it and
      // the retry below would only make a second orphan.
      if (constraint === "membership_user_id_unique") {
        throw new AlreadyInAnOrganizationError();
      }
      if (constraint !== "organization_slug_unique") throw cause;
    }
  }

  throw new OrganizationNameUnavailableError(organizationName);
}
