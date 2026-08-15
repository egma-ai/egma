import { newId } from "@egma/ids";
import { setJudgeConfiguration, type AuthContext } from "@egma/db";

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

/**
 * A judge for a seeded project, because every run needs one.
 *
 * These fixtures build their tenants by raw SQL rather than through signup
 * provisioning, so they skip the transaction that gives a real project its
 * judge. Run creation refuses a project in `needs_setup` — every run carries the
 * judge-backed expected-behaviors built-in — so a fixture that wants to start a
 * run has to do what provisioning would have done.
 *
 * It goes through the module's own door rather than by raw SQL, so the key is
 * sealed the way a real one is and nothing here has to know the envelope's
 * shape. The key is nonsense: nothing in these tests ever asks a model
 * anything, and the one door to a plaintext judge key opens only for the
 * grading engine.
 */
export async function seedJudge(auth: AuthContext): Promise<void> {
  await setJudgeConfiguration(auth, {
    provider: "openai",
    model: "gpt-4o-mini",
    key: "sk-fixture-judge-key",
  });
}
