import { newId } from "@egma/ids";
import {
  appendSpans,
  provisionOrganization,
  connectClickHouse,
  disconnectClickHouse,
  installBillingPlugIn,
  priceUsageSpans,
  providerUsageSpan,
  upsertRateCard,
  type AuthContext,
  type NewUsageRecord,
} from "@egma/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadCloudBilling } from "../src/load.ts";
import { startInferenceSettlementJob } from "../src/settlement.ts";
import {
  activateBilling,
  openBillingAccount,
  readBillingOverview,
} from "../src/access/accounts.ts";
import {
  readBillingLedger,
  readLedgerBalance,
  settleInferenceForOrganization,
} from "../src/access/ledger.ts";
import { seedCloudPlans } from "../src/access/plans.ts";
import { cloudBillingPlugIn, cloudEntitlementSource } from "../src/adapters.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "../../packages/db/test/support/clickhouse.ts";
import {
  seedOrganization,
  seedUser,
} from "../../packages/db/test/support/tenancy.ts";

let database: MigratedDatabase;
let store: MigratedTraceStore;
const cutoff = new Date("2026-09-07T12:02:00Z");
const older = new Date("2026-01-15T08:00:00Z");
function auth(organizationId: string, projectId: string): AuthContext {
  return {
    organizationId,
    projectId,
    userId: "the-grader",
    via: "engine",
    role: "member",
  };
}
async function customer(createdAt = older) {
  const organizationId = newId("org"),
    projectId = newId("prj");
  await seedOrganization(database, organizationId, [
    { id: projectId, slug: projectId.toLowerCase() },
  ]);
  await database.sql("update organization set created_at = $2 where id = $1", [
    organizationId,
    createdAt,
  ]);
  return auth(organizationId, projectId);
}
async function usage(
  context: AuthContext,
  id: string,
  occurredAt = new Date("2026-09-07T12:03:00Z"),
) {
  const record: NewUsageRecord = {
    identity: { work: "simulation", simulationId: newId("sim"), spanId: id },
    traceId: "11111111111111111111111111111111",
    occurredAt,
    provider: "openai",
    model: "gpt-4o-mini",
    operation: "openai_chat_completions",
    quantities: { input_tokens: 1000, output_tokens: 100 },
    measurement: "provider_reported",
    paymentSource: "platform",
    rawUsage: { prompt_tokens: 1000, completion_tokens: 100 },
  };
  const spans = await priceUsageSpans(context, [providerUsageSpan(record)]);
  await appendSpans(context, spans);
  return spans;
}
beforeAll(async () => {
  database = await createConnectedDatabase("activation_settlement");
  store = await createMigratedTraceStore("activation_settlement");
  connectClickHouse({ clickhouseUrl: store.url });
  await seedCloudPlans();
  await database.sql(
    "update cloud_plan set stripe_payments_ready = true where code = 'hobby'",
  );
  await upsertRateCard();
});
afterAll(async () => {
  await disconnectClickHouse();
  await store?.drop();
  await database?.drop();
});

it("activates existing organizations once, keeps their reset day and preserves their money", async () => {
  const one = await customer(),
    two = await customer();
  await activateBilling(cutoff);
  expect(await openBillingAccount(one.organizationId)).toMatchObject({
    activatedAt: cutoff,
    periodAnchor: older,
    balanceMicros: 5_000_000,
  });
  await database.sql(
    "insert into cloud_ledger_entry (id, organization_id, kind, amount_micros, reference_kind, reference_id, idempotency_key, occurred_at) values ($1,$2,'correction',7000000,'operator','test','retained-credit',$3)",
    [newId("cle"), one.organizationId, cutoff],
  );
  await database.sql(
    "update cloud_billing_account set balance_micros = balance_micros + 7000000 where organization_id = $1",
    [one.organizationId],
  );
  await seedCloudPlans();
  expect(await activateBilling(new Date("2026-10-01"))).toEqual(cutoff);
  expect(await openBillingAccount(one.organizationId)).toMatchObject({
    activatedAt: cutoff,
    periodAnchor: older,
    balanceMicros: 12_000_000,
  });
  expect(await readLedgerBalance(one)).toBe(12_000_000);
  expect((await readBillingLedger(two)).entries).toHaveLength(1);
});

it("collects eligible observed usage once across replicas, late visibility and replay", async () => {
  const one = await customer(),
    two = await customer();
  await activateBilling(cutoff);
  const replay = await usage(one, "0000000000000001");
  await usage(one, "0000000000000002", new Date("2026-09-07T12:01:59Z"));
  await usage(two, "0000000000000003");
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      settleInferenceForOrganization(
        one.organizationId,
        new Date("2026-09-07T12:05:00Z"),
      ),
    ),
  );
  expect(results.reduce((all, row) => all + row.amountMicros, 0)).toBe(210);
  expect(
    (await readBillingLedger(one)).entries.filter(
      (row) => row.kind === "inference_charge",
    ),
  ).toHaveLength(1);
  expect(await readLedgerBalance(two)).toBe(5_000_000);
  await store.command(
    "ALTER TABLE spans MODIFY SETTING non_replicated_deduplication_window = 0",
  );
  await appendSpans(one, replay);
  await usage(one, "0000000000000004");
  expect(
    await settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:10:00Z"),
    ),
  ).toEqual({ charged: 1, amountMicros: 210 });
  expect(
    await settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:15:00Z"),
    ),
  ).toEqual({ charged: 0, amountMicros: 0 });
  expect(await readLedgerBalance(one)).toBe(4_999_580);
});

it("rolls back a failed money transaction, allows work and collects once after repair", async () => {
  const one = await customer();
  await activateBilling(cutoff);
  await usage(one, "0000000000000005");
  await database.sql(
    "create function fail_settlement() returns trigger language plpgsql as $$ begin if NEW.kind = 'inference_charge' then raise exception 'settlement unavailable'; end if; return NEW; end $$",
  );
  await database.sql(
    "create trigger fail_settlement before insert on cloud_ledger_entry for each row execute function fail_settlement()",
  );
  await expect(
    settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:05:00Z"),
    ),
  ).rejects.toThrow();
  expect(await readLedgerBalance(one)).toBe(5_000_000);
  await database.sql(
    "update cloud_billing_account set balance_micros = 0 where organization_id = $1",
    [one.organizationId],
  );
  expect(
    await cloudEntitlementSource().mayPlatformKeyFund({
      organizationId: one.organizationId,
      providers: ["openai"],
    }),
  ).toEqual({ funded: true });
  await database.sql(
    "update cloud_billing_account set balance_micros = 5000000 where organization_id = $1",
    [one.organizationId],
  );
  await database.sql("drop trigger fail_settlement on cloud_ledger_entry");
  await settleInferenceForOrganization(
    one.organizationId,
    new Date("2026-09-07T12:05:00Z"),
  );
  expect(await readLedgerBalance(one)).toBe(4_999_790);
  expect(
    (await openBillingAccount(one.organizationId)).settlementFailedAt,
  ).toBeNull();
});

it("isolates a broken billing hook and repairs eligibility from the organization creation instant", async () => {
  const ownerUserId = newId("usr");
  await seedUser(database, ownerUserId, `${ownerUserId}@example.test`);
  const restore = installBillingPlugIn({
    ...cloudBillingPlugIn(),
    async organizationCreated(on) {
      await on.execute(
        (await import("drizzle-orm"))
          .sql`select * from missing_billing_dependency`,
      );
    },
  });
  let created;
  try {
    created = await provisionOrganization({
      ownerUserId,
      organizationName: "Hook recovery",
      organizationSlug: `org-${ownerUserId.slice(-8).toLowerCase()}`,
      projectName: "Project",
      projectSlug: "project",
    });
  } finally {
    restore();
  }
  const [row] = (
    await database.sql<{ created_at: Date }>(
      "select created_at from organization where id = $1",
      [created.organizationId],
    )
  ).rows;
  expect(row).toBeDefined();
  const context = auth(created.organizationId, created.projectId);
  await usage(
    context,
    "0000000000000006",
    new Date((row?.created_at.getTime() ?? 0) + 1000),
  );
  const account = await openBillingAccount(created.organizationId);
  expect(account.activatedAt).toEqual(row?.created_at);
  await activateBilling(new Date("2027-01-01"));
  expect((await readBillingLedger(context)).entries).toHaveLength(1);
  expect((await readBillingOverview(context)).mayManageBilling).toBe(false);
  const settledAt = new Date((row?.created_at.getTime() ?? 0) + 600_000);
  expect(
    await settleInferenceForOrganization(created.organizationId, settledAt),
  ).toEqual({ charged: 1, amountMicros: 210 });
  expect(
    await settleInferenceForOrganization(
      created.organizationId,
      new Date(settledAt.getTime() + 300_000),
    ),
  ).toEqual({ charged: 0, amountMicros: 0 });
  expect(await readLedgerBalance(context)).toBe(4_999_790);
});

it("does not advance or invent a charge when stored usage falls below past collection", async () => {
  const one = await customer();
  await activateBilling(cutoff);
  const spans = await usage(one, "0000000000000007");
  await settleInferenceForOrganization(
    one.organizationId,
    new Date("2026-09-07T12:05:00Z"),
  );
  // Loss of retained usage is an operational fault, not new customer debt.
  await store.command(
    `ALTER TABLE spans DELETE WHERE organization_id = '${one.organizationId}' SETTINGS mutations_sync = 2`,
  );
  await expect(
    settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:10:00Z"),
    ),
  ).rejects.toThrow("below settled charges");
  expect(
    (await readBillingLedger(one)).entries.filter(
      (entry) => entry.kind === "inference_charge",
    ),
  ).toHaveLength(1);
  expect(
    await cloudEntitlementSource().mayPlatformKeyFund({
      organizationId: one.organizationId,
      providers: ["openai"],
    }),
  ).toEqual({ funded: true });
  await appendSpans(one, spans);
  expect(
    await settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:10:00Z"),
    ),
  ).toEqual({ charged: 0, amountMicros: 0 });
  expect(await readLedgerBalance(one)).toBe(4_999_790);
});

it("rolls back the ledger if updating the cached balance fails", async () => {
  const one = await customer();
  await activateBilling(cutoff);
  await usage(one, "0000000000000008");
  await database.sql(
    "create function fail_balance_update() returns trigger language plpgsql as $$ begin if NEW.balance_micros < OLD.balance_micros then raise exception 'balance unavailable'; end if; return NEW; end $$",
  );
  await database.sql(
    "create trigger fail_balance_update before update on cloud_billing_account for each row execute function fail_balance_update()",
  );
  try {
    await expect(
      settleInferenceForOrganization(
        one.organizationId,
        new Date("2026-09-07T12:05:00Z"),
      ),
    ).rejects.toThrow();
    expect(await readLedgerBalance(one)).toBe(5_000_000);
    expect((await readBillingLedger(one)).entries).toHaveLength(1);
  } finally {
    await database.sql(
      "drop trigger fail_balance_update on cloud_billing_account",
    );
  }
  expect(
    await settleInferenceForOrganization(
      one.organizationId,
      new Date("2026-09-07T12:05:00Z"),
    ),
  ).toEqual({ charged: 1, amountMicros: 210 });
  expect((await openBillingAccount(one.organizationId)).balanceMicros).toBe(
    await readLedgerBalance(one),
  );
});

it("records one cutoff under simultaneous activation and never grants a second welcome credit", async () => {
  const one = await customer(new Date("2026-09-07T12:04:00Z"));
  expect(
    await Promise.all([
      activateBilling(new Date("2027-01-01")),
      activateBilling(new Date("2028-01-01")),
    ]),
  ).toEqual([cutoff, cutoff]);
  expect((await openBillingAccount(one.organizationId)).activatedAt).toEqual(
    new Date("2026-09-07T12:04:00Z"),
  );
  expect((await readBillingLedger(one)).entries).toMatchObject([
    { kind: "welcome_credit", amountMicros: 5_000_000 },
  ]);
});

it("keeps boot and funding available while a billing table is unavailable", async () => {
  const { loadCloudBilling } = await import("../src/load.ts");
  await database.sql("alter table cloud_plan rename to unavailable_cloud_plan");
  try {
    const loaded = await loadCloudBilling();
    expect(
      await loaded.plugIn.entitlements.mayStart({
        organizationId: newId("org"),
        allowances: ["phone_minutes"],
      }),
    ).toEqual({ allowed: true });
    expect(
      await loaded.plugIn.entitlements.mayPlatformKeyFund({
        organizationId: newId("org"),
        providers: ["openai"],
      }),
    ).toEqual({ funded: true });
  } finally {
    await database.sql(
      "alter table unavailable_cloud_plan rename to cloud_plan",
    );
  }
});

for (const path of ["boot", "job"] as const) {
  it(`allows an existing zero balance when ${path} cannot initialize collection and restores the gate after collection`, async () => {
    const one = await customer();
    await activateBilling(cutoff);
    await database.sql(
      "update cloud_billing_account set balance_micros = 0 where organization_id = $1",
      [one.organizationId],
    );
    const source = cloudEntitlementSource();
    const request = {
      organizationId: one.organizationId,
      providers: ["openai"],
    };
    expect((await source.mayPlatformKeyFund(request)).funded).toBe(false);
    await database.sql(
      "create or replace function fail_plan_seed() returns trigger language plpgsql as $$ begin raise exception 'plan seed unavailable'; end $$",
    );
    await database.sql(
      "create trigger fail_plan_seed before insert or update on cloud_plan for each row execute function fail_plan_seed()",
    );
    let job: { stop(): void } | undefined;
    let reported = false;
    try {
      if (path === "boot") {
        await loadCloudBilling();
      } else {
        job = startInferenceSettlementJob({
          info() {},
          error() {
            reported = true;
          },
        });
        await expect.poll(() => reported).toBe(true);
      }
      // The fault affects plan writes. Healthy account reads can still see the stale zero.
      expect((await openBillingAccount(one.organizationId)).balanceMicros).toBe(
        0,
      );
      expect(await source.mayPlatformKeyFund(request)).toEqual({
        funded: true,
      });
    } finally {
      job?.stop();
      await database.sql("drop trigger fail_plan_seed on cloud_plan");
    }
    await seedCloudPlans();
    await activateBilling(cutoff);
    expect(await source.mayPlatformKeyFund(request)).toEqual({ funded: true });
    await settleInferenceForOrganization(one.organizationId);
    expect(
      (await openBillingAccount(one.organizationId)).settlementFailedAt,
    ).toBeNull();
    expect((await source.mayPlatformKeyFund(request)).funded).toBe(false);
  });
}

it("lets members page through every ledger movement with stable boundaries and tenant isolation", async () => {
  const one = await customer(),
    two = await customer();
  await activateBilling(cutoff);
  const at = new Date("2026-09-08T12:00:00Z");
  for (let index = 0; index < 105; index += 1) {
    await database.sql(
      "insert into cloud_ledger_entry (id, organization_id, kind, amount_micros, reference_kind, reference_id, idempotency_key, occurred_at) values ($1,$2,'correction',1,'operator','pagination',$3,$4)",
      [
        newId("cle"),
        one.organizationId,
        `${one.organizationId}:page:${index}`,
        at,
      ],
    );
  }
  await database.sql(
    "update cloud_billing_account set balance_micros = balance_micros + 105 where organization_id = $1",
    [one.organizationId],
  );
  const first = await readBillingLedger(one);
  expect(first.entries).toHaveLength(100);
  expect(first.nextCursor).not.toBeNull();
  const second = await readBillingLedger(one, first.nextCursor ?? undefined);
  expect(second.entries).toHaveLength(6);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.entries, ...second.entries].map((entry) => entry.id))
      .size,
  ).toBe(106);
  expect(
    (await readBillingLedger(two, first.nextCursor ?? undefined)).entries,
  ).toMatchObject([{ kind: "welcome_credit" }]);
  await expect(readBillingLedger(one, "broken-cursor")).rejects.toThrow(
    "Invalid ledger cursor",
  );
});

it("keeps an unresolved Stripe fault after successful inference collection", async () => {
  const one = await customer();
  await activateBilling(cutoff);
  await database.sql(
    "update cloud_billing_account set balance_micros = 0, stripe_failed_at = $2, stripe_failure_version = 1 where organization_id = $1",
    [one.organizationId, cutoff],
  );
  await settleInferenceForOrganization(one.organizationId);
  const { rows } = await database.sql<{
    stripe_failed_at: Date;
    stripe_failure_version: string;
    settlement_failed_at: Date | null;
  }>(
    "select stripe_failed_at, stripe_failure_version, settlement_failed_at from cloud_billing_account where organization_id = $1",
    [one.organizationId],
  );
  expect(rows[0]).toMatchObject({
    stripe_failed_at: cutoff,
    stripe_failure_version: "1",
    settlement_failed_at: null,
  });
  expect(
    await cloudEntitlementSource().mayPlatformKeyFund({
      organizationId: one.organizationId,
      providers: ["openai"],
    }),
  ).toEqual({ funded: true });
});

it("does not enforce an existing zero account when its missing welcome credit cannot be repaired", async () => {
  const one = await customer();
  await activateBilling(cutoff);
  await database.sql(
    "delete from cloud_ledger_entry where organization_id = $1",
    [one.organizationId],
  );
  await database.sql(
    "update cloud_billing_account set balance_micros = 0 where organization_id = $1",
    [one.organizationId],
  );
  await database.sql(
    "create function fail_welcome_repair() returns trigger language plpgsql as $$ begin if NEW.kind = 'welcome_credit' then raise exception 'welcome grant unavailable'; end if; return NEW; end $$",
  );
  await database.sql(
    "create trigger fail_welcome_repair before insert on cloud_ledger_entry for each row execute function fail_welcome_repair()",
  );
  try {
    await activateBilling(cutoff);
    expect(
      await cloudEntitlementSource().mayPlatformKeyFund({
        organizationId: one.organizationId,
        providers: ["openai"],
      }),
    ).toEqual({ funded: true });
    await expect(
      settleInferenceForOrganization(one.organizationId),
    ).rejects.toThrow();
    expect((await readBillingLedger(one)).entries).toHaveLength(0);
  } finally {
    await database.sql(
      "drop trigger fail_welcome_repair on cloud_ledger_entry",
    );
  }
  await settleInferenceForOrganization(one.organizationId);
  await activateBilling(cutoff);
  expect((await readBillingLedger(one)).entries).toMatchObject([
    { kind: "welcome_credit", amountMicros: 5_000_000 },
  ]);
  expect(
    (await openBillingAccount(one.organizationId)).settlementFailedAt,
  ).toBeNull();
  expect(await readLedgerBalance(one)).toBe(5_000_000);
});
