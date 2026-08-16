/**
 * What the Settings pages read: the organization, the projects in it, the
 * people, and the keys.
 *
 * **The shapes are the API's, spelled once.** Four pages read these and a fifth
 * will; a page that re-declared `{ id, name, slug }` for itself would be a page
 * that keeps working after the API stops sending one of them.
 *
 * Nothing here can hold a secret. An API key's row carries what it looks like
 * and never what it is: the plaintext exists once, in the answer to the request
 * that minted it, and is never readable again from any route.
 */

export type ProjectSettings = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly organization_id: string;
  /** The token an edit has to name. Sent back with every save. */
  readonly revision: string;
  readonly created_at: string;
  /** Present on the single-project read, absent on a row of the list. */
  readonly may_manage_projects?: boolean;
};

export type ProjectList = {
  readonly items: readonly ProjectSettings[];
  readonly may_manage_projects: boolean;
};

export type OrganizationSettings = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly created_at: string;
  readonly may_manage_organization: boolean;
};

export type Member = {
  readonly user_id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly joined_at: string;
  readonly deactivated_at: string | null;
};

export type Roster = {
  readonly members: readonly Member[];
  readonly may_manage_members: boolean;
};

export type Invitation = {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly expires_at: string;
  readonly created_at: string;
};

export type InvitationList = { readonly invitations: readonly Invitation[] };

/**
 * Whether an invitation can still be accepted.
 *
 * **Two states and not one.** The list route answers with every invitation
 * nobody has accepted, and the ones whose day has passed are in it: they read
 * as waiting when nothing is coming. Somebody who cannot tell them apart waits
 * for a person who was never going to be able to accept.
 *
 * `accepted` is the third state a link can be in and is deliberately not here —
 * an accepted invitation is a member, and the roster is where it shows up.
 *
 * The comparison is the one `stateOf` makes on the server, on the same field.
 * A date egma did not send, or sent unreadably, leaves this `pending`: a
 * standing this could not work out is not grounds for calling an invitation
 * dead.
 */
export type InvitationStanding = "pending" | "expired";

export function standingOf(
  invitation: Invitation,
  now: number = Date.now(),
): InvitationStanding {
  return Date.parse(invitation.expires_at) <= now ? "expired" : "pending";
}

export type ApiKey = {
  readonly id: string;
  readonly name: string | null;
  readonly scope: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  /** Enough to tell one key from another, and not enough to be one. */
  readonly looks_like: string;
  readonly created_by_user_id: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
};

/** A key returned by the list route, with a human owner label. */
export type ListedApiKey = ApiKey & {
  readonly created_by_email: string;
};

export type ApiKeyList = { readonly keys: readonly ListedApiKey[] };

/** A minted key, and the one moment its secret exists outside the server. */
export type MintedApiKey = ApiKey & { readonly secret: string };

/**
 * Where a project is made.
 *
 * **Not under `/projects/`**, and that is not a style choice: the shell reads
 * the project out of the address, so `/projects/new` would put the selector on
 * a project called `new` and point the navigation into one.
 */
export const NEW_PROJECT_PATH = "/new-project";

export const PROJECTS_PATH = "/api/projects";
export const ORGANIZATION_PATH = "/api/organization";
export const MEMBERS_PATH = "/api/members";
export const INVITATIONS_PATH = "/api/invitations";
export const API_KEYS_PATH = "/api/keys";

export function projectSettingsPath(projectId: string): string {
  return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}`;
}

export function memberActionPath(
  userId: string,
  action: "role" | "remove" | "deactivate",
): string {
  return `${MEMBERS_PATH}/${encodeURIComponent(userId)}/${action}`;
}

export function revokeApiKeyPath(apiKeyId: string): string {
  return `${API_KEYS_PATH}/${encodeURIComponent(apiKeyId)}/revoke`;
}

/**
 * The roles somebody can be given, in the order the permission table reads
 * them: most able first, so a select does not suggest that `viewer` is the
 * ordinary choice.
 */
export const ASSIGNABLE_ROLES = ["admin", "member", "viewer"] as const;

/**
 * The rows an answer actually carried, and none at all when it carried
 * something these pages cannot read.
 *
 * A read whose shape is not the expected one is a deployment mid-upgrade, a
 * proxy answering for something else, or a write's own reply arriving where a
 * list was asked for. The cost of trusting it is not a wrong list — it is
 * `undefined.map`, which takes the whole settings page down and with it the
 * thing somebody came to change. An empty list renders an honest state; a crash
 * renders nothing at all.
 */
export function rowsIn<T>(rows: readonly T[] | undefined): readonly T[] {
  return Array.isArray(rows) ? rows : [];
}

/**
 * Which keys a page shows this person, and in which group.
 *
 * **Everybody manages their own, at every role**, which is the one control a
 * viewer keeps live: login mints a key as its last step, and a credential you
 * cannot list or revoke is one you cannot rotate. An admin additionally sees
 * everybody else's, because responding to a leak must not depend on who created
 * the key — and the server is what enforces that, not this split.
 */
export function keysOwnedBy<Key extends ApiKey>(
  keys: readonly Key[],
  userId: string | undefined,
): { readonly mine: readonly Key[]; readonly others: readonly Key[] } {
  const mine: Key[] = [];
  const others: Key[] = [];
  for (const key of rowsIn(keys)) {
    if (userId !== undefined && key.created_by_user_id === userId) mine.push(key);
    else others.push(key);
  }
  return { mine, others };
}

/** What a key's scope says on a row: the project it is for, or the whole customer. */
export function scopeOf(
  key: ApiKey,
  projects: readonly { readonly id: string; readonly name: string }[],
): string {
  if (key.project_id === null) return "Whole organization";
  const named = projects.find((project) => project.id === key.project_id);
  return named === undefined ? key.project_id : `Project · ${named.name}`;
}
