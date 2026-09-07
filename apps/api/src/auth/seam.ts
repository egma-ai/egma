import type { Role } from "@egma/db";

/**
 * Identity-provider interface for sessions and device authorization.
 * Egma owns organization and project scope, membership, permissions, and
 * API keys. The API-key request path does not invoke this provider.
 */

/**
 * A person, as the provider knows them. The identifier is the provider's, not
 * egma's, and mapping one to the other is egma's job rather than an assumption
 * spread through the codebase.
 */
export type ExternalIdentity = {
  readonly externalIdentityId: string;
  readonly email: string;
};

/** What a terminal is handed at the start of an RFC 8628 device flow. */
export type DeviceGrant = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
};

/**
 * Everything a poll can say other than "here is who it is". `slow_down` is
 * separate from `pending` because a client that ignores it gets rate-limited
 * out of its own login.
 */
export const DEVICE_POLL_OUTCOMES = [
  "pending",
  "slow_down",
  "denied",
  "expired",
] as const;

export type DevicePollOutcome = (typeof DEVICE_POLL_OUTCOMES)[number];

export type IdentityProvider = {
  /** A browser session or a bearer token, turned into a person or nobody. */
  resolveIdentity(request: Request): Promise<ExternalIdentity | null>;

  /** The two halves of the CLI device flow (RFC 8628). */
  startDeviceAuthorization(clientId: string): Promise<DeviceGrant>;
  pollDeviceAuthorization(
    deviceCode: string,
  ): Promise<ExternalIdentity | DevicePollOutcome>;

  revokeSession(token: string): Promise<void>;
};

/**
 * The seam, written out, so that a test can state its width rather than trust
 * it. Four calls. A fifth is a decision somebody makes on purpose.
 */
export const IDENTITY_PROVIDER_SEAM = [
  "resolveIdentity",
  "startDeviceAuthorization",
  "pollDeviceAuthorization",
  "revokeSession",
] as const satisfies readonly (keyof IdentityProvider)[];

/**
 * The half of the seam a browser needs: who is this, and stop being them.
 *
 * The device-flow pair is what a terminal needs, and nothing on the browser
 * path has any business calling it. Asking for the narrow type where the narrow
 * type is enough keeps that true by construction rather than by convention.
 */
export type SessionIdentityProvider = Pick<
  IdentityProvider,
  "resolveIdentity" | "revokeSession"
>;

/**
 * Signup intent selects a new organization or invitation acceptance.
 * Without intent, provisioning derives default names from the email.
 */
export type ProvisioningIntent =
  | {
      readonly kind: "new_organization";
      readonly organizationName: string;
      readonly projectName: string;
    }
  | {
      readonly kind: "invitation";
      /** The string from the link. Only its hash is ever stored. */
      readonly token: string;
    };

/** Where a new person ended up: an organization, a first project, a role. */
export type Landing = {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly role: Role;
};

/**
 * Provider hooks enforce admission and provisioning for identity creation,
 * including requests sent directly to the provider signup endpoint.
 */
export type IdentityHooks = {
  /**
   * May this person exist here at all? Runs before the identity is written and
   * refuses by throwing, so a refusal leaves nothing behind.
   *
   * It is handed the intent as well as the address, because an invitation is
   * exactly what gets somebody through a door that is otherwise closed, and the
   * decision has to be made here rather than after the row exists.
   */
  admitIdentity(
    email: string,
    intent: ProvisioningIntent | undefined,
  ): Promise<void>;

  /** A person now exists. Give them an organization and a first project. */
  onIdentityCreated(
    identity: ExternalIdentity,
    intent: ProvisioningIntent | undefined,
  ): Promise<void>;

  /**
   * Somebody signed in through their employer's identity provider. Map the
   * domain to an egma organization.
   *
   * Named because the seam is the statement of what the provider is for, and
   * leaving it out would make the seam look narrower than the thing it has to
   * survive. It has no implementation until enterprise single sign-on does.
   */
  onSsoLogin(identity: ExternalIdentity, domain: string): Promise<void>;
};

/**
 * The answers a refusal is allowed to be. A subset of the HTTP statuses, so
 * that egma's own vocabulary decides what a refusal means and the provider's
 * transport only carries it.
 *
 * 404 joined the list with invitations: a link that names nothing is genuinely
 * not found, and flattening it into "your request was bad" would tell somebody
 * who mis-copied a URL to go and look at their own request body.
 */
export const REFUSAL_STATUSES = [400, 403, 404, 409] as const;
export type RefusalStatus = (typeof REFUSAL_STATUSES)[number];

/**
 * Signing up was refused for a reason the person can act on.
 *
 * These are thrown from the hooks, which run inside the provider's own request
 * handling, so this carries what the answer should be rather than leaving the
 * provider to guess. Anything else that goes wrong is a fault rather than a
 * refusal, and is left to surface as one.
 */
export class SignupRefusedError extends Error {
  readonly status: RefusalStatus;
  /** egma's name for what happened, which is what the page reads. */
  readonly code: string;

  constructor(status: RefusalStatus, code: string, message: string) {
    super(message);
    this.name = "SignupRefusedError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Nobody else may sign up here. Thrown from the hook that runs ahead of the
 * write, so a refusal leaves nothing behind and cannot be bypassed by posting
 * straight at the provider's own signup endpoint instead of egma's page.
 */
export class SignupClosedError extends SignupRefusedError {
  constructor(message: string) {
    super(403, "invitation_required", message);
    this.name = "SignupClosedError";
  }
}
