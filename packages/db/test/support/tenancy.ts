import { newId } from "@egma/ids";
import { reconcileGraderCatalog } from "@egma/db";

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
 * The Expected behaviors project grader that provisioning gives a real
 * project, given to a fixture's raw-SQL one.
 *
 * A project with no project grader has no expected-behavior item in its frozen
 * grading plans. A real project receives this row in its creation transaction;
 * raw-SQL project fixtures skip that transaction and must request the same
 * catalog reconciliation before they test grading.
 *
 * **Called by the file that needs it rather than by `seedOrganization`**, and
 * that is a limitation rather than a design. Folding it in would be truer to
 * what a real project is, but it needs the shelf already filled — and
 * some catalog tests deliberately start before reconciliation. So it is a
 * separate call, and any fixture whose subject is grading has to make it.
 *
 * It calls the deployment's own start-up backfill rather than writing the two
 * rows here, because that call's whole job is to give every project the current
 * predefined catalog and its Expected behaviors project grader. A fixture
 * writing its own would be a second definition able to drift.
 */
export async function seedProjectGraders(): Promise<void> {
  await reconcileGraderCatalog();
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
