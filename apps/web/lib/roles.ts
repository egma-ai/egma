/**
 * Organization roles control which actions the UI offers across projects.
 * Unknown roles use viewer permissions. These helpers do not authorize
 * requests; the server enforces access.
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
