import type { Role } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import { NotPermittedError } from "./errors.ts";

/**
 * Explicit allowed roles per action. Check the current role from AuthContext
 * without reading the database here. Avoid numeric role ordering so each
 * action's permissions remain visible in one table.
 */

/**
 * The whole permission model, one row per thing a person may be refused. The
 * roles named on a row are the roles that may take that action, and the gap on
 * the left of a row is every role that may not.
 */
const PERMISSIONS = {
  /** Read project data and the caller's basic organization identity. */
  read:                   ["viewer", "member", "admin"],

  /** Read organization settings, members, provider keys and billing. */
  read_organization:      ["viewer", "member", "admin"],

  /** Create, edit, delete tests, personas, graders and test suites. */
  author_definitions:     [          "member", "admin"],

  /** Create, edit, delete agents and connections. */
  configure_agents:       [          "member", "admin"],

  /** Set up or remove production Monitoring for a project. */
  configure_monitoring:   [          "member", "admin"],

  /** Start a run, cancel a run. */
  start_and_cancel_runs:  [          "member", "admin"],

  /**
   * Re-grade a trace: run its whole frozen grader plan again.
   *
   * A `viewer` is refused, and the reviewer of the user story holds `member`.
   * A re-grade appends new grade history and can spend model-provider capacity,
   * so a credential that can ask for one is not read-only.
   */
  regrade:                [          "member", "admin"],

  /**
   * Send an agent's traces through the ingest door. A write like any other,
   * and the row a `viewer` is refused: a read-only credential that could still
   * file spans into the organization would be read-only in name only.
   */
  ingest_traces:          [          "member", "admin"],

  /** Delete runs and trace data. */
  delete_run_data:        [          "member", "admin"],

  /** Mint an API key for themselves. */
  mint_own_api_key:       ["viewer", "member", "admin"],

  /** See and revoke anyone's API key. */
  manage_any_api_key:     [                    "admin"],

  /** Invite people, change roles, remove members. */
  manage_members:         [                    "admin"],

  /** Organization settings, retention, billing, provider credentials. */
  manage_organization:    [                    "admin"],

  /** Create a project, delete a project. */
  manage_projects:        [                    "admin"],

  /** Delete the organization. */
  delete_organization:    [                    "admin"],
} as const satisfies Readonly<Record<string, readonly Role[]>>;

/**
 * Everything a person can be refused. One name per row of the table above,
 * rather than one per verb: the table is the unit that was decided, and a map
 * nobody can hold in their head is a map nobody audits.
 */
export type Action = keyof typeof PERMISSIONS;

export const ACTIONS = Object.keys(PERMISSIONS) as readonly Action[];

/** These actions affect or expose the whole organization, even from a project page. */
const ORGANIZATION_ACTIONS: ReadonlySet<Action> = new Set([
  "read_organization",
  "manage_members",
  "manage_organization",
  "manage_projects",
  "delete_organization",
]);

/**
 * Organization and optional project the action targets. A project API key may
 * target only its project. A session's active project is navigation context;
 * it does not reduce the person's organization role.
 */
export type ActionScope = {
  readonly organizationId: string;
  readonly projectId: string | undefined;
};

/**
 * Where the caller already is: their own organization, and the project they are
 * acting in if they are acting in one.
 *
 * Use this for operations on the caller's current scope. An operation that
 * accepts a different target, such as minting a key, must name that target
 * explicitly so the credential ceiling can check it.
 */
export function here(auth: AuthContext): ActionScope {
  return { organizationId: auth.organizationId, projectId: auth.projectId };
}

function scopeWithinCredential(auth: AuthContext, scope: ActionScope): boolean {
  return (
    scope.organizationId === auth.organizationId &&
    (
      auth.via !== "api_key" ||
      auth.projectId === undefined ||
      scope.projectId === auth.projectId
    )
  );
}

/**
 * Whether the caller may take this action. For deciding what to show — which
 * buttons a page renders, which rows a list offers to revoke.
 *
 * For deciding what to *allow*, call `authorize`, which refuses out loud. A
 * boolean that somebody forgets to read permits everything.
 */
export function permits(
  auth: AuthContext,
  action: Action,
  scope: ActionScope,
): boolean {
  // The credential names the customer. A caller acting for one organization has
  // no role at all in another, so this is refused before the role is consulted.
  if (!scopeWithinCredential(auth, scope)) return false;
  if (
    auth.via === "api_key" &&
    auth.projectId !== undefined &&
    ORGANIZATION_ACTIONS.has(action)
  ) {
    return false;
  }

  const permitted: readonly Role[] = PERMISSIONS[action];
  return permitted.includes(auth.role);
}

/**
 * Throw when permits rejects an action. Enforce at the action boundary, including
 * direct data access entry points; declaring a permission alone does not enforce it.
 */
export function authorize(
  auth: AuthContext,
  action: Action,
  scope: ActionScope,
): void {
  if (!permits(auth, action, scope)) {
    throw new NotPermittedError(auth, action, scope);
  }
}

/**
 * All roles may see and revoke their own keys within the credential's scope.
 * Admins may also manage other members' keys within that same scope.
 */
export function permitsApiKeyMintedBy(
  auth: AuthContext,
  userId: string,
  scope: ActionScope,
): boolean {
  if (!scopeWithinCredential(auth, scope)) return false;
  if (userId === auth.userId) return true;
  return permits(auth, "manage_any_api_key", scope);
}
