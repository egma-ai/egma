import { newId } from "@egma/ids";
import { runMigrations, type AuthContext } from "@egma/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import { seedOrganization } from "../../packages/db/test/support/tenancy.ts";
import { activateBilling, openBillingAccount } from "../src/access/accounts.ts";
import { readBillingLedger } from "../src/access/ledger.ts";
import { seedCloudPlans } from "../src/access/plans.ts";

let database: MigratedDatabase;
const migration = "0010_clickhouse_idle_billing.sql";

beforeAll(async () => {
  database = await createConnectedDatabase("inference_idle_migration");
  await seedCloudPlans();
  await activateBilling(new Date("2026-09-07T12:00:00Z"));
});

afterAll(async () => {
  await database?.drop();
});

async function account(): Promise<AuthContext> {
  const organizationId = newId("org");
  const projectId = newId("prj");
  await seedOrganization(database, organizationId, [{ id: projectId, slug: projectId.toLowerCase() }]);
  await openBillingAccount(organizationId);
  return { organizationId, projectId, userId: "billing-migration", via: "engine", role: "member" };
}

it("schedules existing accounts once while preserving money and leaves new accounts idle", async () => {
  const existing = await account();
  const original = await openBillingAccount(existing.organizationId);
  const ledger = await readBillingLedger(existing);
  // Restore the account shape before this migration in this test database.
  await database.sql("alter table cloud_billing_account drop column inference_usage_version, drop column inference_settled_version");
  await database.sql("delete from egma_meta.migration where name = $1", [migration]);

  expect((await runMigrations(database.url)).applied).toEqual([migration]);
  expect(await openBillingAccount(existing.organizationId)).toEqual(original);
  expect(await readBillingLedger(existing)).toEqual(ledger);
  const created = await account();
  const { rows } = await database.sql<{
    organization_id: string;
    inference_usage_version: string;
    inference_settled_version: string;
  }>("select organization_id, inference_usage_version, inference_settled_version from cloud_billing_account order by organization_id");
  expect(rows).toEqual([
    { organization_id: existing.organizationId, inference_usage_version: "1", inference_settled_version: "0" },
    { organization_id: created.organizationId, inference_usage_version: "0", inference_settled_version: "0" },
  ].sort((one, two) => one.organization_id.localeCompare(two.organization_id)));
  expect(await runMigrations(database.url)).toMatchObject({ applied: [] });
});
