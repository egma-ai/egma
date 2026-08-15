import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { organization, project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";

/**
 * The tenancy predicates, written once, here.
 *
 * Nothing in `access/` composes a `where` clause without starting from one of
 * these, and none of them is exported from the package: the injection point is
 * internal to the module, so no caller can reach it to widen or replace what it
 * produced. An exported function may narrow a predicate — it is handed to
 * `and()` — and has no way to loosen one.
 *
 * The tenancy tables carry their tenancy in their own primary key rather than
 * in an `organization_id` column, which is why `theOrganization` and
 * `theProject` exist alongside the general case.
 */

/** Any table below the tenancy tables. Every one of them carries the customer. */
export type OrganizationScoped = PgTable & {
  readonly organizationId: AnyPgColumn;
};

/** Any table that also labels its rows with the product area they belong to. */
export type ProjectScoped = PgTable & {
  readonly projectId: AnyPgColumn;
};

function all(...conditions: readonly SQL[]): SQL {
  const combined = and(...conditions);
  if (combined === undefined) {
    throw new Error("a tenancy predicate can never be empty");
  }
  return combined;
}

/**
 * Rows of `table` belonging to the caller's customer, and no other.
 *
 * Every table this pass builds is scoped by the organization alone. `api_key`
 * carries a project column and is still organization-scoped, because an
 * organization-scoped key names no project and an owner must be able to see
 * every key in the organization. A table that is genuinely scoped to one
 * project — all of the product and execution tables, when they arrive with
 * their first caller — narrows by the project too, taken from the context on
 * the same terms as the organization is.
 *
 * **When that arrives, a context with no project is the whole organization and
 * not a project.** An organization-scoped credential names none, so the project
 * predicate is simply absent for it and the organization one still holds. The
 * shape of `AuthContext.projectId` is what forces that decision to be made out
 * loud rather than by whatever a missing value happens to do.
 */
export function within(
  auth: AuthContext,
  table: OrganizationScoped,
  narrower?: SQL,
): SQL {
  const tenancy = eq(table.organizationId, auth.organizationId);
  return narrower === undefined ? tenancy : all(tenancy, narrower);
}

/**
 * The narrowing that rides beside the tenancy one: acting in a project narrows
 * to it, and acting in none reaches the whole customer.
 *
 * **It is `undefined` rather than a predicate for a context with no project**,
 * because an organization-scoped credential names none and the honest answer is
 * that there is nothing to narrow by — `and()` drops it, and the organization
 * predicate still holds. That absence is the decision `AuthContext.projectId`
 * being optional forces somebody to make out loud, and it is made here once.
 *
 * It is here beside `within` rather than copied into each factory because it is
 * half of the same `where` clause and belongs to the same rule: nothing in
 * `access/` composes a predicate without starting from this file. (Several
 * factories still hold their own private copy from before this was lifted.
 * Each is identical; they come here as their modules are next touched, rather
 * than in one sweep across files other work is in the middle of.)
 */
export function inActingProject(
  auth: AuthContext,
  table: ProjectScoped,
): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(table.projectId, auth.projectId);
}

/** The caller's own customer row. */
export function theOrganization(auth: AuthContext): SQL {
  return eq(organization.id, auth.organizationId);
}

/**
 * The project the caller is acting in. Both predicates, and the organization is
 * the context's, so naming a project of another customer's matches nothing.
 *
 * The project is passed rather than read off the context because a context can
 * name none, and there is no project predicate for a credential that is for a
 * whole customer. Taking it as an argument makes the caller narrow first, which
 * is the point of `projectId` being able to be absent at all.
 */
export function theProject(auth: AuthContext, projectId: string): SQL {
  return all(
    eq(project.id, projectId),
    eq(project.organizationId, auth.organizationId),
  );
}
