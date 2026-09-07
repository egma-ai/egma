import { ROLES, type Role } from "../schema/columns.ts";

/**
 * Verified identity, organization isolation, project scope, and current role for
 * customer data access. Build this context from credentials or internal work claims,
 * then apply its scope in database predicates.
 */
export type AuthContext = {
  /** egma's own user id. */
  readonly userId: string;
  readonly organizationId: string;
  /**
   * An explicit project scope, or undefined for organization-wide access.
   * Do not replace undefined with a default project.
   */
  readonly projectId: string | undefined;
  readonly role: Role;
  readonly via: Via;
};

/**
 * How the context was established: a session, API key, or internal work claim.
 * engine writes grades; simulator resolves simulation credentials; monitoring
 * handles production ingestion. Internal contexts derive organization and project
 * from stored work, not from customer identifiers supplied by a service.
 * Keep service identities distinct so their permissions cannot be interchanged.
 */
export const VIA = [
  "session",
  "api_key",
  "engine",
  "simulator",
  "monitoring",
] as const;
export type Via = (typeof VIA)[number];

/**
 * Roles and permission rules are defined in schema/columns.ts and permissions.ts.
 * Resolve a person's current role from membership when building their context.
 */
export { ROLES };
export type { Role };
