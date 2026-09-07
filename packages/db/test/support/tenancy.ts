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
 * Give raw-SQL project fixtures their Expected behaviors project grader
 * through catalog reconciliation. Grading fixtures must call this after
 * seeding the catalog; catalog tests may need to start without it.
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
