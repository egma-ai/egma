import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import { organization, project } from "../schema/tenancy.ts";
import type { AuthContext } from "./context.ts";

/**
 * Internal predicates for organization isolation and optional project scope.
 * Combine narrower conditions with AND. Organization/project identity tables
 * use their own IDs through theOrganization and theProject.
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
 * Apply organization isolation and an optional narrower predicate. This helper
 * does not apply project scope; project-scoped callers must add it explicitly.
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
 * Return a project predicate when AuthContext names a project, otherwise undefined.
 * Combine with within so an omitted project still retains organization isolation.
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
 * Match the supplied project ID inside the caller's organization. This does
 * not compare the ID with auth.projectId; callers enforce that request scope.
 */
export function theProject(auth: AuthContext, projectId: string): SQL {
  return all(
    eq(project.id, projectId),
    eq(project.organizationId, auth.organizationId),
  );
}
