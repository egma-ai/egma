import type { Role } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import { NotPermittedError } from "./errors.ts";

/**
 * What each role may do, and the one function every action passes through.
 *
 * Everybody is an `admin` today, so nobody notices any of this. The machinery
 * is real anyway: shipping admin-only would mean writing the authorization
 * layer twice, once trivially and once properly the first time somebody wants a
 * read-only QA lead — which is a use case egma's own positioning names as
 * first-class. Switching the default later is a setting rather than a project.
 *
 * **A named set with an explicit action map, not an ordered number.** The three
 * roles happen to nest, so a numeric comparison would work today and `role >=
 * ADMIN` would read fine. It is declined because custom roles are
 * non-hierarchical by definition, and a numeric scale forecloses them — it
 * would have to be torn out the moment the first one arrives. An explicit map
 * is also the only form anybody audits: the whole permission model is one table
 * a person can hold in their head.
 *
 * **Nothing here reads the database.** The decision is made from the role the
 * `AuthContext` already carries, and the context was built by the
 * authentication path from a membership read at that moment. That is what makes
 * a key act at its creator's *current* role: the key row records who minted it
 * and nothing about what they may do, so the only way to turn a key into a
 * context is through the membership resolver, and demoting somebody takes
 * effect on their next request with no key row edited.
 */

/**
 * The whole permission model, one row per thing a person may be refused. The
 * roles named on a row are the roles that may take that action, and the gap on
 * the left of a row is every role that may not.
 */
const PERMISSIONS = {
  /** Read anything in the organization. */
  read:                   ["viewer", "member", "admin"],

  /** Create, edit, delete tests, digital humans, graders and test suites. */
  author_definitions:     [          "member", "admin"],

  /** Create, edit, delete agents and connections. */
  configure_agents:       [          "member", "admin"],

  /** Start a run, cancel a run. */
  start_and_cancel_runs:  [          "member", "admin"],

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

/**
 * Where an action is being taken. Both are named on every call.
 *
 * The organization is checked against the caller's own, which is the whole
 * reason it is a parameter: a credential naming one customer cannot act on
 * another's, whatever the role says.
 *
 * **The project is accepted and deliberately ignored.** Every member of an
 * organization holds their organization role on every project in it, so today
 * the project changes no answer. It is taken from the first commit anyway, and
 * this is not an oversight to tidy up later: project-level grants arrive as
 * overrides on top of the organization role, and having the argument already
 * there makes that a change to one function body rather than an audit of every
 * call site in the product.
 *
 * **It can be absent**, because an organization-scoped credential names no
 * project and an action taken for a whole customer is not taken in one. When
 * project-level grants arrive, that is the case that falls back to the
 * organization role rather than to any project's override — which is the
 * answer, not a gap, and stating the absence here is what will make it
 * answerable then.
 */
export type ActionScope = {
  readonly organizationId: string;
  readonly projectId: string | undefined;
};

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
  if (scope.organizationId !== auth.organizationId) return false;

  // scope.projectId is read by nothing, on purpose. See ActionScope.

  const permitted: readonly Role[] = PERMISSIONS[action];
  return permitted.includes(auth.role);
}

/**
 * The one permission function every action in the product passes through.
 *
 * It answers by refusing: a call that returns is a call that was allowed, so
 * there is no result to forget to look at. The decision itself is still made in
 * exactly one place — `permits`, above — and this adds only the refusal.
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
 * Whether the caller may see or revoke one particular API key.
 *
 * The table has a single row for this and the word that carries it is
 * *anyone's*: an `admin` reaches every key in the organization, so responding
 * to a leak never depends on the person who created the key. A key you minted
 * is yours at any role, which is what keeps the product usable for a `viewer` —
 * login mints a key as its final step, and a credential you cannot list or
 * revoke is one you cannot rotate.
 *
 * It lives here rather than as a comparison written out at each call site for
 * the same reason `authorize` does. A rule spread across call sites is a rule
 * nobody can audit.
 */
export function permitsApiKeyMintedBy(
  auth: AuthContext,
  userId: string,
  scope: ActionScope,
): boolean {
  if (scope.organizationId !== auth.organizationId) return false;
  if (userId === auth.userId) return true;
  return permits(auth, "manage_any_api_key", scope);
}
