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
