import type {
  CreateApiKeyResponse,
  CreateProjectResponse,
  GetOrganizationResponse,
  GetProjectResponse,
  ListApiKeysResponse,
  ListInvitationsResponse,
  ListMembersResponse,
  ListProjectsResponse,
} from "@egma/platform-api/client";

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

export type ProjectSettings = CreateProjectResponse &
  Partial<Pick<GetProjectResponse, "mayManageProjects">>;

export type ProjectList = ListProjectsResponse;

export type OrganizationSettings = GetOrganizationResponse;

export type Member = ListMembersResponse["members"][number];

export type Roster = ListMembersResponse;

export type Invitation = ListInvitationsResponse["invitations"][number];

export type InvitationList = ListInvitationsResponse;

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
  return Date.parse(invitation.expiresAt) <= now ? "expired" : "pending";
}

export type ApiKey = ListApiKeysResponse["keys"][number];

/** A key returned by the list route, with a human owner label. */
export type ListedApiKey = ApiKey;

export type ApiKeyList = ListApiKeysResponse;

/** A minted key, and the one moment its secret exists outside the server. */
export type MintedApiKey = CreateApiKeyResponse;

/**
 * Where a project is made.
 *
 * **Not under `/projects/`**, and that is not a style choice: the shell reads
 * the project out of the address, so `/projects/new` would put the selector on
 * a project called `new` and point the navigation into one.
 */
export const NEW_PROJECT_PATH = "/new-project";

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
    if (userId !== undefined && key.createdByUserId === userId) mine.push(key);
    else others.push(key);
  }
  return { mine, others };
}

/** What a key's scope says on a row: the project it is for, or the whole customer. */
export function scopeOf(
  key: ApiKey,
  projects: readonly { readonly id: string; readonly name: string }[],
): string {
  if (key.projectId === null) return "Whole organization";
  const named = projects.find((project) => project.id === key.projectId);
  return named === undefined ? key.projectId : `Project · ${named.name}`;
}
