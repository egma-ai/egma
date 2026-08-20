import { newId } from "@egma/ids";
import { seedRunningGraders } from "@egma/db";

import type { MigratedDatabase } from "./database.ts";

/**
 * Tenancy fixtures by raw SQL, on purpose: signup provisioning has its own
 * tests, and a test that provisioned its tenants through the module would be
 * asking the module whether the module worked.
 */

export async function seedOrganization(
  database: MigratedDatabase,
  organizationId: string,
  projects: readonly { readonly id: string; readonly slug: string }[],
): Promise<void> {
  await database.sql(
    "insert into organization (id, name, slug) values ($1, $2, $2)",
    [organizationId, organizationId.slice(-8)],
  );
  for (const { id, slug } of projects) {
    await database.sql(
      "insert into project (id, organization_id, name, slug, revision) values ($1, $2, $3, $3, $4)",
      [id, organizationId, slug, newId("rev")],
    );
  }
}

/**
 * The running copy of the expected-behaviors grader that provisioning gives a
 * real project, given to a fixture's raw-SQL one.
 *
 * **A project with no copy is judged by nothing**, and nothing would say so.
 * Before the redesign the expected-behaviors grader was a built-in that was
 * never a row, so a project born by `insert` had it for free; it is a real
 * seeded copy now, written by the transaction that creates a project — which is
 * exactly the transaction these fixtures skip. A plan frozen for a project with
 * no copy carries no expected-behaviors item, and every proof about what a run
 * judges would then be green against an empty plan.
 *
 * **Called by the file that needs it rather than by `seedOrganization`**, and
 * that is a limitation rather than a design. Folding it in would be truer to
 * what a real project is, but it needs the shelf already filled — and
 * `grader-library.test.ts` is deliberately the one harness that starts with an
 * empty shelf, because watching it fill is what that file is about. So it is a
 * separate call, and any fixture whose subject is what a run judges has to make
 * it.
 *
 * It calls the deployment's own start-up backfill rather than writing the two
 * rows here, because that call's whole job is "every project that has never had
 * a copy gets one". A fixture writing its own would be a second description of
 * what a seeded copy is, and the two would drift.
 */
export async function seedGraderCopies(): Promise<void> {
  await seedRunningGraders();
}

export async function seedUser(
  database: MigratedDatabase,
  userId: string,
  email: string,
): Promise<void> {
  await database.sql('insert into "user" (id, email) values ($1, $2)', [
    userId,
    email,
  ]);
}
