import type { Role } from "@egma/db";

/**
 * Everything egma asks of an auth provider, and nothing wider.
 *
 * The provider answers one question — who is this person, and are they logged
 * in — and everything past the front door is egma's. Organizations, projects,
 * membership, invitations, API keys and every permission check are egma's own
 * tables with egma's own foreign keys, so swapping the provider changes what
 * fills two nullable columns and leaves every product row untouched.
 *
 * That only stays true while this file is the whole of the dependency. A build
 * rule holds it there: the provider's package may be named in the file that
 * implements this seam and in the one that binds it to the identity tables, and
 * nowhere else. Anything wider than these four calls and two hooks is porting
 * cost, paid later, by somebody who did not choose it.
 *
 * The provider is on the login path always, and on the authenticated-request
 * path for browser sessions, because turning a session cookie into an identity
 * is exactly `resolveIdentity`. It is absent from the API-key path entirely:
 * egma mints, hashes and verifies those against its own table, and that is the
 * high-volume path a swap must not be able to reach.
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
 * What a new identity should land in, when egma's own signup page asked for
 * particular names. Absent when the identity was created some other way, in
 * which case provisioning falls back to its own defaults.
 */
export type ProvisioningIntent = {
  readonly organizationName: string;
  readonly projectName: string;
};

/** Where a new person ended up: an organization, a first project, a role. */
export type Landing = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly role: Role;
};

/**
 * The hooks egma registers rather than calls. They are the reason signup is not
 * a provider call: the provider creates the identity through its own endpoint,
 * and egma is told about it.
 *
 * A hook is not porting cost the way a call is — the body is egma's own code
 * and only the registration changes with the provider — which is why the
 * refusal below is a hook rather than a check in egma's signup route. Put in
 * the route, it would be bypassed by posting straight at the provider's signup
 * endpoint, and on a self-hosted instance that bypass is the whole attack:
 * everyone defaults to `admin`, so joining the only organization is
 * administering it.
 */
export type IdentityHooks = {
  /**
   * May this person exist here at all? Runs before the identity is written and
   * refuses by throwing, so a refusal leaves nothing behind.
   */
  admitIdentity(email: string): Promise<void>;

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
 */
export const REFUSAL_STATUSES = [400, 403, 409] as const;
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
