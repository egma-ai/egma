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
 * Settings types from the generated API contract. Listed API keys contain
 * metadata; only the creation response includes the new secret.
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
 * Unaccepted invitations are pending or expired. Invalid dates remain pending;
 * accepted invitations are omitted by the list route.
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
 * Fall back to an empty array for an absent or malformed list value. This
 * prevents a render error but does not distinguish invalid data from no rows.
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
