import { instanceIsClaimed, provisionOrganization } from "@egma/db";

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
 * What happens the moment a person exists: they get an organization and its
 * first project, together, and they are its admin.
 *
 * There is no state in which somebody has an organization and no project.
 * `provisionOrganization` writes the organization, the project and the
 * membership in one transaction, so a failure part-way leaves none of the
 * three, and this file never reaches around it.
 */

/**
 * How many names to try before giving up. A slug is unique across the whole
 * deployment, so two customers both called Acme is an ordinary thing that must
 * not stop the second one — the first gets `acme`, the next `acme-2`. Bounded,
 * because an unbounded retry against a real collision is a hang, and refusing
 * out loud with a name a person can change is better than either.
 */
const SLUG_ATTEMPTS = 5;

/** Nobody may sign up here any more; they need an invitation. */
export function admitIdentity(
  singleOrganization: boolean,
): IdentityHooks["admitIdentity"] {
  return async () => {
    if (!singleOrganization) return;
    if (!(await instanceIsClaimed())) return;
    throw new SignupClosedError(
      "this egma already has an organization, and open signup closed when it " +
        "was claimed. Ask an admin for an invitation.",
    );
  };
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
    recordLanding(await provision(identity, intent));
  };
}

async function provision(
  identity: ExternalIdentity,
  intent: ProvisioningIntent | undefined,
): Promise<Landing> {
  const organizationName =
    intent?.organizationName.trim() ||
    organizationNameFromEmail(identity.email);
  const projectName = intent?.projectName.trim() || DEFAULT_PROJECT_NAME;
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
        projectId: provisioned.projectId,
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
