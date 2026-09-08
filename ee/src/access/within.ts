import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import type { AuthContext } from "@egma/db";

/**
 * The tenancy predicates for the cloud tables, written once, here.
 *
 * **A second copy of the shared module's, and deliberately so.** The predicate
 * factory in `packages/db/src/access/within.ts` is not exported from that
 * package, on purpose: the injection point is internal to the module so no
 * caller can reach it to widen what it produced. This package is the second
 * fenced home of the same boundary, so it holds its own — four lines, the same
 * shape, applied to tables that live only here. Importing the first would have
 * meant exporting it, which would have handed every package in the repository
 * the ability to compose its own `where` clause.
 *
 * Every `cloud_` table carries `organization_id`, so the general case is the
 * only case and there is no project narrowing: an account, a balance and a
 * ledger belong to the customer and never to one product area.
 */

/** Any cloud table. Every one of them carries the customer. */
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

/** Rows of `table` belonging to the caller's customer, and no other. */
export function within(
  auth: AuthContext,
  table: OrganizationScoped,
  narrower?: SQL,
): SQL {
  return ofOrganization(table, auth.organizationId, narrower);
}

/**
 * The same predicate for the two ports, which are handed an organization
 * rather than a context.
 *
 * **It is not a way around `within`.** The ports are Egma asking itself a
 * question about money — a run start, a claim batch, a usage record Egma has
 * just written — and the organization on each of those comes from a claim, a
 * caller's own resolved context or a row Egma wrote, never from a request
 * payload. The predicate is the same one either way, so no read here can reach
 * a second customer whichever door asked.
 */
export function ofOrganization(
  table: OrganizationScoped,
  organizationId: string,
  narrower?: SQL,
): SQL {
  const tenancy = eq(table.organizationId, organizationId);
  return narrower === undefined ? tenancy : all(tenancy, narrower);
}
