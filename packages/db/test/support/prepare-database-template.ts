/**
 * Prepare the schema ordinary fast tests clone.
 *
 * The template is a test-run concern, not a deployment path. Migration tests
 * deliberately create empty databases and continue to run every migration for
 * themselves. Everything else keeps the same real-Postgres isolation while
 * paying for the empty-to-current transition once per Vitest run.
 */

import { runMigrations } from "../../src/migrate.ts";
import type { TestProject } from "vitest/node";

import { createEmptyDatabase, holdDatabaseClaim } from "./database.ts";
import { MIGRATED_DATABASE_TEMPLATE_KEY } from "./database-template-context.ts";

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const template = await createEmptyDatabase("migrated_template");
  const releaseClaim = await holdDatabaseClaim(template.name);
  try {
    await runMigrations(template.url);
  } catch (cause) {
    await releaseClaim();
    await template.drop();
    throw cause;
  }

  project.provide(MIGRATED_DATABASE_TEMPLATE_KEY, template.name);

  return async () => {
    await releaseClaim();
    await template.drop();
  };
}
