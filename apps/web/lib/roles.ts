/**
 * What the role somebody holds in their organization lets them do, as the
 * pages read it.
 *
 * **Hiding a control is not authorization.** Every one of these answers is
 * about what is worth showing somebody; the server checks the same permission
 * again on every request and is the only thing standing between a viewer and a
 * write. That is why an unrecognized role reads as `viewer` here: the worst a
 * wrong guess can do is show too little, and showing too much is the failure
 * that would matter.
 *
 * A membership is held in the organization and applies to every project in it,
 * so none of these takes a project. Selecting a project never grants access.
 */

export const ROLES = ["admin", "member", "viewer"] as const;

export type Role = (typeof ROLES)[number];

/** The role a session read named, or the least of them. */
export function roleFrom(value: string | null | undefined): Role {
  return ROLES.find((role) => role === value) ?? "viewer";
}

/**
 * May author product resources — agents, connections, tests, personas,
 * graders — and start work with them. Members and admins; never a viewer.
 */
export function canAuthor(role: Role): boolean {
  return role === "member" || role === "admin";
}

/**
 * The badge a read-only member sees. Small, and worn by the person rather than
 * by each control, so a page is not filled with disabled buttons explaining
 * themselves one at a time.
 */
export const VIEW_ONLY = "View only";
