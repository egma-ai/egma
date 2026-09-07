import { newId } from "@egma/ids";
import {
  claimGradingJobs,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  entitlementSourceContract,
  installBillingPlugIn,
  recordProviderUsage,
  startRun,
  upsertRateCard,
  usageSinkContract,
  type AuthContext,
  type StoredUsageRecord,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  chargeForStoredUsage,
  cloudEntitlementSource,
  cloudUsageSink,
  inferenceChargeKey,
  openBillingAccount,
  readBillingOverview,
  readEntitlementFacts,
  readLedgerBalance,
  readPlanCatalog,
  seedCloudPlans,
  welcomeCreditKey,
} from "../src/index.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import {
  seedOrganization,
  seedUser,
} from "../../packages/db/test/support/tenancy.ts";

/**
 * The cloud adapter, against real rows and no Stripe at all.
 *
 * **Two organizations throughout.** The first question any of this has to
 * answer correctly is whose plan, whose allowance and whose money — so Acme is
 * on Hobby and Globex is moved to Pro, and every refusal is checked to be
 * about the customer it names.
 *
 * **The facts Stripe would have written are seeded as rows.** A Pro
 * subscription enters this file as the `plan_code` and the anchor on a billing
 * account, because those two columns are the whole of what Egma keeps from
 * Stripe about a subscription. Nothing here calls Stripe and nothing pretends
 * to be it: what is under test is what Egma does with the facts.
 *
 * **The conversations are written with their spans directly**, as ticket 02's
 * usage tests write them: what is under test is the plan and the balance, and
 * a simulator that really spoke for five hundred minutes is not a thing a
 * suite can wait for.
 */

let database: MigratedDatabase;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

/** Both customers were created on the 15th, so their months turn over then. */
const CREATED_AT = new Date("2026-01-15T08:00:00.000Z");
/** The instant every question below is asked at: inside the September period. */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const PERIOD_RESETS = new Date("2026-10-15T08:00:00.000Z");

/** $5.00, as the shipped file states it. */
const WELCOME_CREDIT_MICROS = 5_000_000;

function sessionOf(
  who: typeof acme,
  role: "admin" | "member" | "viewer" = "admin",
): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role,
    via: "session",
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("ee-cloud-billing");
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p-${who.projectId.slice(-6)}`.toLowerCase() },
    ]);
    await seedUser(database, who.userId, `${who.userId.slice(-8)}@example.test`);
    await database.sql("update organization set created_at = $2 where id = $1", [
      who.organizationId,
      CREATED_AT,
    ]);
  }
  await upsertRateCard();
  await seedCloudPlans();
});

afterAll(async () => {
  await database?.drop();
});

/**
 * One run per customer, and a connection of every lane it needs.
 *
 * The run is started through the module so the pins and the tenancy triangle
 * are the real ones; the conversations each test needs are written onto it
 * with the spans the test is about — the same shape ticket 02's usage tests
 * use, and for the same reason.
 */
type Seeded = {
  readonly runId: string;
  readonly agentId: string;
  readonly chatConnectionId: string;
  readonly voiceConnectionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
};

const seeded = new Map<string, Seeded>();

async function seedRun(who: typeof acme): Promise<Seeded> {
  const held = seeded.get(who.organizationId);
  if (held !== undefined) return held;

  const auth = sessionOf(who);
  const label = newId("run").slice(-8).toLowerCase();
  const created = await createAgent(auth, {
    agentPlatform: "retell",
    name: `Front desk ${label}`,
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: `agent_${label}` },
      credentials: { apiKey: `retell-secret-${label}` },
    },
  });
  const chatConnectionId = created.connection?.id ?? "";

  // The voice lane goes in by raw SQL. What is under test is how a minute is
  // counted against a plan, not what the connection registry admits.
  const voiceConnectionId = newId("con");
  await database.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, connection_type,
        access_variant, modality, topology, config)
     values ($1, $2, $3, $4, $5, 'livekit_room',
             'livekit_room.project_credentials', 'voice', 'hosted-broker',
             '{}'::jsonb)`,
    [
      voiceConnectionId,
      who.organizationId,
      who.projectId,
      created.id,
      `livekit-${label}`,
    ],
  );

  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      identityName: "Sam Poole",
      personality: "Speaks plainly and asks one question at a time.",
      language: "en-US",
    })
  ).id;
  const suite = await createTestSuite(auth, { name: `Billing ${label}` });
  await createTest(auth, {
    suiteId: suite.id,
    name: `Reschedules ${label}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
  const started = await startRun(auth, {
    suiteId: suite.id,
    agentId: created.id,
    connectionId: chatConnectionId,
    idempotencyKey: newId("run"),
  });
  const { rows } = await database.sql<{
    persona_version_id: string;
    test_id: string;
    test_version_id: string;
  }>(
    "select persona_version_id, test_id, test_version_id from simulation where run_id = $1 limit 1",
    [started.id],
  );
  const pins = rows[0];
  if (pins === undefined) throw new Error("the run has no simulation");

  const made: Seeded = {
    runId: started.id,
    agentId: created.id,
    chatConnectionId,
    voiceConnectionId,
    personaId,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
  };
  seeded.set(who.organizationId, made);
  return made;
}

let position = 100;

/**
 * Conversations on this run, with the span each is counted from.
 *
 * Written directly rather than conducted: what is under test is the plan and
 * the balance, and a simulator that really spoke for five thousand minutes is
 * not a thing a suite can wait for.
 */
async function conversations(
  who: typeof acme,
  lane: {
    readonly count: number;
    readonly modality: "chat" | "voice";
    readonly connectionType: "retell_chat_api" | "livekit_room" | "phone_number";
    readonly startedAt: Date;
    readonly seconds: number;
  },
): Promise<void> {
  const run = await seedRun(who);
  const from = position + 1;
  position += lane.count;
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at)
     select
       'sim_' || upper(substr(md5(random()::text || n::text || clock_timestamp()::text), 1, 26)),
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       n, $10, $11, 'completed', 'persona_concluded', $12::timestamptz,
       $12::timestamptz + make_interval(secs => $13::double precision)
     from generate_series($14::int, $14::int + $15::int - 1) as n`,
    [
      run.runId,
      who.organizationId,
      who.projectId,
      run.agentId,
      lane.modality === "chat" ? run.chatConnectionId : run.voiceConnectionId,
      run.personaId,
      run.personaVersionId,
      run.testId,
      run.testVersionId,
      lane.modality,
      lane.connectionType,
      lane.startedAt,
      lane.seconds,
      from,
      lane.count,
    ],
  );
}

/** What the account row says, read raw. */
async function accountRow(who: typeof acme): Promise<{
  plan_code: string;
  balance_micros: string;
  period_anchor: Date;
}> {
  const { rows } = await database.sql<{
    plan_code: string;
    balance_micros: string;
    period_anchor: Date;
  }>(
    "select plan_code, balance_micros, period_anchor from cloud_billing_account where organization_id = $1",
    [who.organizationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("no billing account");
  return row;
}

async function ledgerRows(who: typeof acme): Promise<
  { kind: string; amount_micros: string; idempotency_key: string }[]
> {
  const { rows } = await database.sql<{
    kind: string;
    amount_micros: string;
    idempotency_key: string;
  }>(
    "select kind, amount_micros, idempotency_key from cloud_ledger_entry where organization_id = $1 order by id",
    [who.organizationId],
  );
  return rows;
}

describe("the plans the shipped file states", () => {
  it("writes Hobby and Pro with the published fees and allowances", async () => {
    const { rows } = await database.sql<Record<string, string | null>>(
      `select code, name, fee_micros, chat_simulations_allowance,
              web_call_minutes_allowance, phone_minutes_allowance,
              web_call_overage_micros_per_minute,
              phone_overage_micros_per_minute,
              stripe_fee_price_id
       from cloud_plan order by code`,
    );
    expect(rows.map((row) => row.code)).toEqual(["hobby", "pro"]);

    const [hobby, pro] = rows;
    expect(hobby).toMatchObject({
      name: "Hobby",
      fee_micros: "0",
      chat_simulations_allowance: "500",
      web_call_minutes_allowance: "500",
      phone_minutes_allowance: "500",
    });
    expect(pro).toMatchObject({
      name: "Pro",
      // $50 a month.
      fee_micros: "50000000",
      // Unlimited chat: a chat's only marginal cost is inference.
      chat_simulations_allowance: null,
      web_call_minutes_allowance: "5000",
      phone_minutes_allowance: "2000",
      // The two placeholders: $0.01 a web-call minute, $0.05 a phone minute.
      web_call_overage_micros_per_minute: "10000",
      phone_overage_micros_per_minute: "50000",
    });
    // Nothing has created a Stripe object, and the plan row is complete
    // without one: the allowances are enforced from Egma's own rows.
    expect(pro?.stripe_fee_price_id).toBeNull();
  });

  it("states one welcome credit of $5", async () => {
    const catalog = await readPlanCatalog();
    expect(catalog.welcomeCreditMicros).toBe(WELCOME_CREDIT_MICROS);
  });

  it("writes nothing on a boot that changed nothing", async () => {
    expect((await seedCloudPlans()).written).toEqual([]);
  });
});

describe("a welcome credit", () => {
  it("is one ledger row of $5, written when the account is opened", async () => {
    const account = await openBillingAccount(acme.organizationId, NOW);
    expect(account.planCode).toBe("hobby");
    expect(account.balanceMicros).toBe(WELCOME_CREDIT_MICROS);
    // Hobby's period anchor is the organization's own creation date, so the
    // reset day is the customer's and needs no Stripe object to exist.
    expect(account.periodAnchor).toEqual(CREATED_AT);

    const rows = await ledgerRows(acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "welcome_credit",
      amount_micros: String(WELCOME_CREDIT_MICROS),
      idempotency_key: welcomeCreditKey(acme.organizationId),
    });
  });

  it("is written once however many creations race each other", async () => {
    // Globex's account has never been opened. Four questions arrive at the
    // same instant, which is what a customer's first run and its first usage
    // record actually look like.
    const opened = await Promise.all([
      openBillingAccount(globex.organizationId, NOW),
      openBillingAccount(globex.organizationId, NOW),
      openBillingAccount(globex.organizationId, NOW),
      openBillingAccount(globex.organizationId, NOW),
    ]);
    expect(new Set(opened.map((account) => account.id)).size).toBe(1);

    const rows = await ledgerRows(globex);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("welcome_credit");
    expect((await accountRow(globex)).balance_micros).toBe(
      String(WELCOME_CREDIT_MICROS),
    );
  });

  it("belongs to the customer it was written for", async () => {
    const theirs = await ledgerRows(acme);
    const others = await ledgerRows(globex);
    expect(theirs[0]?.idempotency_key).not.toBe(others[0]?.idempotency_key);
  });
});

describe("whether an organization may start a kind of work", () => {
  it("admits a customer who has used nothing", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayStart({
        organizationId: acme.organizationId,
        allowances: ["chat_simulations", "web_call_minutes", "phone_minutes"],
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("pauses Hobby at the published number of chat simulations", async () => {
    // Five hundred is the number the plan row publishes, so five hundred is
    // what this spends. The row is the rule: a founder who changes it changes
    // this answer with no deploy.
    await conversations(acme, {
      count: 500,
      modality: "chat",
      connectionType: "retell_chat_api",
      startedAt: new Date("2026-09-16T09:00:00.000Z"),
      seconds: 4,
    });

    const source = cloudEntitlementSource({ now: () => NOW });
    const decision = await source.mayStart({
      organizationId: acme.organizationId,
      allowances: ["chat_simulations"],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;

    const [refusal] = decision.refusals;
    expect(refusal?.allowance).toBe("chat_simulations");
    expect(refusal?.resetsAt).toEqual(PERIOD_RESETS);
    // The sentence a person meets names what is spent, when it comes back and
    // where to go next.
    expect(refusal?.message).toContain("500");
    expect(refusal?.message).toContain("Hobby");
    expect(refusal?.message).toContain("Oct 15, 2026");
    expect(refusal?.message).toContain("Settings");
  });

  it("refuses one kind and leaves the customer's other kinds alone", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    const decision = await source.mayStart({
      organizationId: acme.organizationId,
      allowances: ["chat_simulations", "phone_minutes"],
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.refusals.map((one) => one.allowance)).toEqual([
      "chat_simulations",
    ]);
  });

  it("says nothing about another customer's month", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayStart({
        organizationId: globex.organizationId,
        allowances: ["chat_simulations"],
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("counts a period the customer is not in as somebody else's month", async () => {
    // The five hundred above were run in September. Asked about November, the
    // month is empty again and the allowance is whole.
    const source = cloudEntitlementSource({
      now: () => new Date("2026-11-20T12:00:00.000Z"),
    });
    await expect(
      source.mayStart({
        organizationId: acme.organizationId,
        allowances: ["chat_simulations"],
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("leaves Pro's chat unlimited and prices its minutes by allowance", async () => {
    // The row a Stripe subscription would have written, seeded directly: the
    // plan code and the anchor are the whole of what Egma keeps from Stripe.
    await database.sql(
      `update cloud_billing_account
         set plan_code = 'pro',
             stripe_customer_id = 'cus_seeded_by_this_test',
             stripe_subscription_id = 'sub_seeded_by_this_test',
             stripe_subscription_status = 'active'
       where organization_id = $1`,
      [globex.organizationId],
    );
    // Five thousand web-call minutes, in one conversation, because the span is
    // what a minute is counted from.
    await conversations(globex, {
      count: 1,
      modality: "voice",
      connectionType: "livekit_room",
      startedAt: new Date("2026-09-16T09:00:00.000Z"),
      seconds: 5_000 * 60,
    });

    const source = cloudEntitlementSource({ now: () => NOW });
    const chat = await source.mayStart({
      organizationId: globex.organizationId,
      allowances: ["chat_simulations"],
    });
    expect(chat).toEqual({ allowed: true });

    const minutes = await source.mayStart({
      organizationId: globex.organizationId,
      allowances: ["web_call_minutes", "phone_minutes"],
    });
    expect(minutes.allowed).toBe(false);
    if (minutes.allowed) return;
    expect(minutes.refusals.map((one) => one.allowance)).toEqual([
      "web_call_minutes",
    ]);
    expect(minutes.refusals[0]?.message).toContain("Pro");
  });

  it("asks about nothing and refuses nothing", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayStart({ organizationId: acme.organizationId, allowances: [] }),
    ).resolves.toEqual({ allowed: true });
  });
});

describe("whether Egma's own key may fund a provider", () => {
  it("funds every provider while the balance is above zero", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayPlatformKeyFund({
        organizationId: acme.organizationId,
        providers: ["openai", "cartesia", "deepgram"],
      }),
    ).resolves.toEqual({ funded: true });
  });

  it("refuses at zero, naming the providers and the next step", async () => {
    // The balance spent, as a correction an operator would write.
    await database.sql(
      `insert into cloud_ledger_entry
         (id, organization_id, kind, amount_micros, reference_kind,
          reference_id, idempotency_key, occurred_at)
       values ($1, $2, 'correction', $3, 'operator', 'this-test',
               'this-test-spends-acme', $4)`,
      [newId("cle"), acme.organizationId, -WELCOME_CREDIT_MICROS, NOW],
    );
    await database.sql(
      "update cloud_billing_account set balance_micros = 0 where organization_id = $1",
      [acme.organizationId],
    );

    const source = cloudEntitlementSource({ now: () => NOW });
    const decision = await source.mayPlatformKeyFund({
      organizationId: acme.organizationId,
      providers: ["openai", "cartesia"],
    });
    expect(decision.funded).toBe(false);
    if (decision.funded) return;
    expect(decision.providers).toEqual(["openai", "cartesia"]);
    expect(decision.message).toContain("openai");
    expect(decision.message).toContain("cartesia");
    expect(decision.message).toContain("$0.00");
    expect(decision.message).toContain("Settings");
  });

  it("charges nothing for a provider the customer holds their own key for", async () => {
    // The seam Naman's provider-keys effort plugs into. Acme's balance is at
    // zero and Deepgram still runs, because Egma is not paying for it.
    const source = cloudEntitlementSource({
      now: () => NOW,
      customerFundedProviders: () => Promise.resolve(["deepgram"]),
    });
    await expect(
      source.mayPlatformKeyFund({
        organizationId: acme.organizationId,
        providers: ["deepgram"],
      }),
    ).resolves.toEqual({ funded: true });

    // And the provider they hold no key for is still refused, by name.
    const mixed = await source.mayPlatformKeyFund({
      organizationId: acme.organizationId,
      providers: ["deepgram", "openai"],
    });
    expect(mixed.funded).toBe(false);
    if (mixed.funded) return;
    expect(mixed.providers).toEqual(["openai"]);
  });

  it("still funds another customer, whose balance is its own", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayPlatformKeyFund({
        organizationId: globex.organizationId,
        providers: ["openai"],
      }),
    ).resolves.toEqual({ funded: true });
  });

  it("funds a request that names no provider", async () => {
    const source = cloudEntitlementSource({ now: () => NOW });
    await expect(
      source.mayPlatformKeyFund({
        organizationId: acme.organizationId,
        providers: [],
      }),
    ).resolves.toEqual({ funded: true });
  });
});

/** A usage record as the store hands one to the sink. */
function storedRecord(
  who: typeof acme,
  id: string,
  overrides: Partial<StoredUsageRecord> = {},
): StoredUsageRecord {
  return {
    id,
    organizationId: who.organizationId,
    projectId: who.projectId,
    occurredAt: new Date("2026-09-18T10:00:00.000Z"),
    provider: "openai",
    model: "gpt-4o-mini",
    paymentSource: "platform",
    amountMicros: 250_000,
    ...overrides,
  };
}

/** A real `usage_record` row, so the ledger's edge into it can be closed. */
async function seedUsageRecord(
  who: typeof acme,
  record: StoredUsageRecord,
): Promise<void> {
  await database.sql(
    `insert into usage_record
       (id, organization_id, project_id, occurred_at, work_kind, grading_job_id,
        provider, model, operation, unit, quantities, measurement,
        payment_source, raw_usage, amount_micros, priced_by, dedupe_key)
     values ($1, $2, $3, $4, 'grading', $5, $6, $7, 'openai_chat_completions',
             'tokens', '{"input_tokens": 1000}'::jsonb, 'provider_reported',
             $8, '{}'::jsonb, $9, '{}'::jsonb, $10)`,
    [
      record.id,
      who.organizationId,
      who.projectId,
      record.occurredAt,
      newId("gjb"),
      record.provider,
      record.model,
      record.paymentSource,
      record.amountMicros,
      `dedupe-${record.id}`,
    ],
  );
}

describe("what the balance is charged for", () => {
  it("writes one charge per record Egma's key paid for, and moves the balance", async () => {
    const before = Number((await accountRow(globex)).balance_micros);
    const records = [
      storedRecord(globex, newId("usg"), { amountMicros: 120_000 }),
      storedRecord(globex, newId("usg"), {
        amountMicros: 80_000,
        provider: "cartesia",
        model: "sonic-2",
      }),
    ];
    for (const record of records) await seedUsageRecord(globex, record);

    const charged = await chargeForStoredUsage(records);
    expect(charged).toEqual({ charged: 2, amountMicros: 200_000 });

    const after = Number((await accountRow(globex)).balance_micros);
    expect(after).toBe(before - 200_000);
    // The materialised balance is a cache of the ledger, and this is the read
    // that proves it.
    expect(await readLedgerBalance(sessionOf(globex))).toBe(after);
  });

  it("charges nothing for a record the customer's own key paid for", async () => {
    const before = Number((await accountRow(globex)).balance_micros);
    const record = storedRecord(globex, newId("usg"), {
      paymentSource: "customer",
      amountMicros: 999_000,
    });
    await seedUsageRecord(globex, record);

    expect(await chargeForStoredUsage([record])).toEqual({
      charged: 0,
      amountMicros: 0,
    });
    expect(Number((await accountRow(globex)).balance_micros)).toBe(before);
  });

  it("charges once however many times the same record arrives", async () => {
    const before = Number((await accountRow(globex)).balance_micros);
    const record = storedRecord(globex, newId("usg"), { amountMicros: 30_000 });
    await seedUsageRecord(globex, record);

    expect((await chargeForStoredUsage([record])).charged).toBe(1);
    expect((await chargeForStoredUsage([record])).charged).toBe(0);
    expect((await chargeForStoredUsage([record, record])).charged).toBe(0);

    expect(Number((await accountRow(globex)).balance_micros)).toBe(
      before - 30_000,
    );
    const keys = (await ledgerRows(globex)).map((row) => row.idempotency_key);
    expect(keys.filter((key) => key === inferenceChargeKey(record.id))).toHaveLength(
      1,
    );
  });

  it("keeps the materialised balance equal to the sum of the ledger", async () => {
    const rows = await ledgerRows(globex);
    const sum = rows.reduce((all, row) => all + Number(row.amount_micros), 0);
    expect(Number((await accountRow(globex)).balance_micros)).toBe(sum);
    expect(await readLedgerBalance(sessionOf(globex))).toBe(sum);
  });

  it("lets in-flight work take the balance below zero, and then refuses more", async () => {
    // Everything already claimed finishes and is charged. The overrun is
    // bounded by what was in flight, which the founders accepted.
    const balance = Number((await accountRow(globex)).balance_micros);
    const record = storedRecord(globex, newId("usg"), {
      amountMicros: balance + 1_000_000,
    });
    await seedUsageRecord(globex, record);
    await chargeForStoredUsage([record]);

    expect(Number((await accountRow(globex)).balance_micros)).toBe(-1_000_000);
    const source = cloudEntitlementSource({ now: () => NOW });
    const decision = await source.mayPlatformKeyFund({
      organizationId: globex.organizationId,
      providers: ["openai"],
    });
    expect(decision.funded).toBe(false);
    if (decision.funded) return;
    expect(decision.message).toContain("-$1.00");
  });

  it("reaches the balance through the seam the product writes usage on", async () => {
    // Not the sink called by hand: the write that stores a usage record hands
    // it to whatever plug-in this process runs on, and this is that path.
    const restore = installBillingPlugIn({
      entitlements: cloudEntitlementSource({ now: () => NOW }),
      usage: cloudUsageSink(),
    });
    try {
      const before = Number((await accountRow(acme)).balance_micros);
      const written = await recordProviderUsage(
        { ...sessionOf(acme), via: "engine" },
        [
          {
            identity: {
              work: "grading",
              gradingJobId: newId("gjb"),
              attempts: 1,
              projectGraderId: newId("grd"),
              assertion: "confirms the new time",
              httpAttempt: 1,
            },
            occurredAt: new Date("2026-09-18T11:00:00.000Z"),
            provider: "openai",
            model: "gpt-4o-mini",
            operation: "openai_chat_completions",
            quantities: { input_tokens: 1_000, output_tokens: 100 },
            measurement: "provider_reported",
            paymentSource: "platform",
            rawUsage: {},
          },
        ],
      );
      expect(written.stored).toBe(1);
      expect(written.amountMicros).toBeGreaterThan(0);

      expect(Number((await accountRow(acme)).balance_micros)).toBe(
        before - written.amountMicros,
      );
    } finally {
      restore();
    }
  });
});

describe("what the Billing section reads", () => {
  it("gives an admin the plan, the balance and this period's charges", async () => {
    const overview = await readBillingOverview(sessionOf(globex, "admin"), NOW);
    expect(overview.plan.code).toBe("pro");
    expect(overview.plan.name).toBe("Pro");
    expect(overview.plan.chatSimulationsAllowance).toBeNull();
    expect(overview.mayManageBilling).toBe(true);
    expect(overview.period.resetsAt).toEqual(PERIOD_RESETS);
    // Every charge is Egma's key paying: a customer-funded record is on the
    // usage page and never here.
    expect(overview.charges.length).toBeGreaterThan(0);
    expect(overview.charges.map((one) => one.provider)).toContain("openai");
    expect(
      overview.charges.reduce((all, one) => all + one.amountMicros, 0),
    ).toBeGreaterThan(0);
  });

  it("gives a member the plan and the balance, and no breakdown", async () => {
    const overview = await readBillingOverview(sessionOf(globex, "member"), NOW);
    expect(overview.plan.code).toBe("pro");
    expect(overview.mayManageBilling).toBe(false);
    expect(overview.charges).toEqual([]);
    expect(overview.account.balanceMicros).toBe(
      Number((await accountRow(globex)).balance_micros),
    );
  });

  it("reads one customer's account and never the other's", async () => {
    const theirs = await readBillingOverview(sessionOf(acme), NOW);
    const others = await readBillingOverview(sessionOf(globex), NOW);
    expect(theirs.account.organizationId).toBe(acme.organizationId);
    expect(others.account.organizationId).toBe(globex.organizationId);
    expect(theirs.plan.code).toBe("hobby");
    expect(others.plan.code).toBe("pro");
  });
});

describe("the port contracts, against the cloud adapters", () => {
  // The same list the open adapters are held to, run against these. Neither
  // can drift from the other, because there is only one list.
  for (const check of entitlementSourceContract(() =>
    cloudEntitlementSource({ now: () => NOW }),
  )) {
    it(`entitlement source: ${check.name}`, async () => {
      await check.run();
    });
  }

  for (const check of usageSinkContract(() => cloudUsageSink())) {
    it(`usage sink: ${check.name}`, async () => {
      await check.run();
    });
  }
});

describe("an organization the adapter has never heard of", () => {
  it("has spent no allowance and holds no balance", async () => {
    // It cannot be a customer of this deployment, so it has run nothing — and
    // the balance it does not have funds nothing. Both answers are true and
    // neither is generous.
    const source = cloudEntitlementSource({ now: () => NOW });
    const nobody = newId("org");
    await expect(
      source.mayStart({ organizationId: nobody, allowances: ["chat_simulations"] }),
    ).resolves.toEqual({ allowed: true });

    const funding = await source.mayPlatformKeyFund({
      organizationId: nobody,
      providers: ["openai"],
    });
    expect(funding.funded).toBe(false);

    // And no row was written for it.
    const { rows } = await database.sql(
      "select 1 from cloud_billing_account where organization_id = $1",
      [nobody],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("the facts the adapter decides from", () => {
  it("names the account, the plan, the period and the month's usage", async () => {
    const facts = await readEntitlementFacts(globex.organizationId, NOW);
    expect(facts.account.planCode).toBe("pro");
    expect(facts.plan.webCallMinutesAllowance).toBe(5_000);
    expect(facts.period.resetsAt).toEqual(PERIOD_RESETS);
    expect(facts.usage.used.web_call_minutes).toBe(5_000);
  });
});

describe("the grading claim, when Egma's key pays for the judge", () => {
  /** One pending production grading job, written where the claim will find it. */
  async function pendingGradingJob(who: typeof acme): Promise<string> {
    const id = newId("gjb");
    await database.sql(
      `insert into grading_job
         (id, organization_id, project_id, source, simulation_id, trace_id,
          trace_started_at, run_id, entries, status)
       values ($1, $2, $3, 'production', null, $4, $5, null,
               '[{"projectGraderId": "grd_x"}]'::jsonb, 'pending')`,
      [id, who.organizationId, who.projectId, `trace-${id}`, NOW],
    );
    return id;
  }

  async function jobRow(id: string): Promise<{ status: string; attempts: number }> {
    const { rows } = await database.sql<{ status: string; attempts: number }>(
      "select status, attempts from grading_job where id = $1",
      [id],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("the grading job is gone");
    return row;
  }

  it("leaves a job unclaimed when the balance cannot fund the judge", async () => {
    // Acme's balance is at zero by this point in the file.
    const id = await pendingGradingJob(acme);
    const restore = installBillingPlugIn({
      entitlements: cloudEntitlementSource({ now: () => NOW }),
      usage: cloudUsageSink(),
    });
    try {
      const claimed = await claimGradingJobs({
        claimant: "grader-in-this-test",
        capacity: 50,
      });
      expect(claimed.map((one) => one.id)).not.toContain(id);
      // Back on the queue, and the attempt uncounted: a job nobody could
      // start is not a job that failed.
      expect(await jobRow(id)).toEqual({ status: "pending", attempts: 0 });
    } finally {
      restore();
      await database.sql("delete from grading_job where id = $1", [id]);
    }
  });

  it("hands the same job out once the balance can pay", async () => {
    const id = await pendingGradingJob(acme);
    const restore = installBillingPlugIn({
      entitlements: cloudEntitlementSource({ now: () => NOW }),
      usage: cloudUsageSink(),
    });
    try {
      // The credit a Checkout session would have written, seeded as the one
      // row Egma keeps from it.
      await database.sql(
        `insert into cloud_ledger_entry
           (id, organization_id, kind, amount_micros, reference_kind,
            reference_id, idempotency_key, occurred_at)
         values ($1, $2, 'purchased_credit', 20000000, 'checkout_session',
                 'cs_seeded_by_this_test', 'purchased:cs_seeded_by_this_test', $3)`,
        [newId("cle"), acme.organizationId, NOW],
      );
      await database.sql(
        "update cloud_billing_account set balance_micros = balance_micros + 20000000 where organization_id = $1",
        [acme.organizationId],
      );

      const claimed = await claimGradingJobs({
        claimant: "grader-in-this-test",
        capacity: 50,
      });
      expect(claimed.map((one) => one.id)).toContain(id);
      expect((await jobRow(id)).status).toBe("claimed");
    } finally {
      restore();
      await database.sql("delete from grading_job where id = $1", [id]);
    }
  });
});
