/**
 * The data-access module.
 *
 * One module owns the Postgres pool, and this is the only way anything reads or
 * writes. The pool is never exported; the package's `exports` map offers this
 * entry point and nothing else; and a lint rule fails the build if any file
 * outside `packages/db/src` imports a datastore driver. A cross-tenant leak
 * therefore takes adding a new export here, rather than forgetting a `WHERE`
 * clause somewhere nobody is looking.
 *
 * Three categories of export, and the third reaches no store at all:
 *
 * **Context-requiring.** Everything that touches a customer's data takes an
 * `AuthContext` as its first argument and the module builds the organization
 * and project predicates from it. No exported function accepts a filter, so
 * none can be widened and none can be omitted.
 *
 * **Context-establishing.** `membershipsOf` and `provisionOrganization`, and
 * only those two. One answers which organizations a person is in — the fact an
 * `AuthContext` is built from — and the other brings a new organization into
 * existence. Neither can return, or reach, a row belonging to anybody else.
 * Anything added to this category is a deliberate act: a test names both and
 * fails when a third appears.
 *
 * **Deciding.** The role list, the action list, and the one function every
 * action in the product passes through. They take an `AuthContext` like
 * everything else and then read nothing: a permission is decided from the role
 * the context already carries, which is what keeps the answer current rather
 * than remembered. They are here, beside the context they read, because the
 * context is the only input they have.
 *
 * The ClickHouse client arrives behind this same boundary on these same terms:
 * a file beside these, taking the same `AuthContext`, injecting the same
 * predicates, with its driver already named in the lint rule's list.
 */

export type { AuthContext, Role, Via } from "./context.ts";
export { ROLES, VIA } from "./context.ts";
export {
  NotPermittedError,
  ProjectOutsideOrganizationError,
} from "./errors.ts";

export {
  ACTIONS,
  authorize,
  permits,
  permitsApiKeyMintedBy,
  type Action,
  type ActionScope,
} from "./permissions.ts";

export { membershipsOf, listMemberships, type Membership } from "./memberships.ts";
export {
  provisionOrganization,
  type NewOrganization,
  type ProvisionedOrganization,
} from "./provisioning.ts";

export {
  readOrganization,
  readOrganizationSettings,
  updateOrganizationSettings,
  type Organization,
  type OrganizationSettings,
  type OrganizationSettingsChanges,
} from "./organizations.ts";

export {
  listProjects,
  readProject,
  createProject,
  type NewProject,
  type Project,
} from "./projects.ts";

export {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  type ApiKey,
  type NewApiKey,
} from "./api-keys.ts";
