import { newId } from "@egma/ids";
import {
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  startRun,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyStripeEvent } from "../src/access/stripe.ts";
import { seedCloudPlans } from "../src/access/plans.ts";
import {
  visitMeterAccounts,
  type MeterPeriodFact,
  type MeterProgress,
  type NextMeterReport,
  type PendingMeterReport,
} from "../src/access/meter.ts";
import { hourAround } from "../src/stripe/facts.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "../../packages/db/test/support/database.ts";
import {
  seedOrganization,
  seedUser,
} from "../../packages/db/test/support/tenancy.ts";

let database: MigratedDatabase;
const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
  customerId: "cus_meter_acme",
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
  customerId: "cus_meter_globex",
};
const START = new Date("2026-09-20T13:30:00Z");
const END = new Date("2026-10-20T13:30:00Z");
const AT = new Date("2026-09-20T17:00:00Z");
const latest = hourAround(new Date("2026-09-20T16:00:00Z"));
const period: MeterPeriodFact = {
  stripeSubscriptionId: "sub_meter",
  periodStartedAt: START,
  periodEndsAt: END,
  channel: "web_call_minutes",
  meterId: "meter_web",
  eventName: "egma_web_call_minutes",
  priceId: "price_web",
  invoiceId: null,
  acceptingUsage: true,
};
function sessionOf(who: typeof acme): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role: "admin",
    via: "session",
  };
}
beforeAll(async () => {
  database = await createConnectedDatabase("ee-meter-progress");
  await seedCloudPlans();
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p-${who.projectId.slice(-6)}`.toLowerCase() },
    ]);
    await seedUser(
      database,
      who.userId,
      `${who.userId.slice(-8)}@example.test`,
    );
    await database.sql(
      `insert into cloud_billing_account (id, organization_id, plan_code, period_anchor, activated_at, stripe_customer_id)
      values ($1, $2, 'hobby', $3, $3, $4)`,
      [newId("cba"), who.organizationId, START, who.customerId],
    );
    await seedRun(who);
  }
});
afterAll(async () => {
  await database?.drop();
});
beforeEach(async () => {
  await database.sql("delete from cloud_meter_period");
  await database.sql(
    "update cloud_billing_account set stripe_failed_at = null, stripe_failure_version = 0, plan_code = 'hobby'",
  );
  await database.sql("delete from simulation where position >= 501");
});
async function visit(
  body: (progress: MeterProgress) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  await visitMeterAccounts(
    async (account, progress) => {
      if (account.organizationId === acme.organizationId) await body(progress);
    },
    (_, fault) => {
      failures.push(fault);
    },
  );
  if (failures.length > 0) throw failures[0];
}
function pending(next: NextMeterReport): PendingMeterReport {
  if (next.kind !== "send")
    throw new Error(`expected pending report, got ${next.kind}`);
  return next.report;
}
async function row(channel = "web_call_minutes") {
  const { rows } = await database.sql(
    "select * from cloud_meter_period where organization_id = $1 and channel = $2",
    [acme.organizationId, channel],
  );
  return rows[0];
}
type SeededRun = {
  readonly runId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
};

const runs = new Map<string, SeededRun>();

async function seedRun(who: typeof acme): Promise<SeededRun> {
  const held = runs.get(who.organizationId);
  if (held !== undefined) return held;

  const auth = sessionOf(who);
  const label = newId("run").slice(-8).toLowerCase();
  const agent = await createAgent(auth, {
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
  const chatConnectionId = agent.connection?.id ?? "";

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
      agent.id,
      `lk-${label}`,
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
  const suite = await createTestSuite(auth, { name: `Metering ${label}` });
  await createTest(auth, {
    suiteId: suite.id,
    name: `Reschedules ${label}`,
    scenario: "Their cleaning has to move to any afternoon next week.",
    expectedBehaviors: ["confirms the new time back before finishing"],
    personaIds: [personaId],
  });
  const started = await startRun(auth, {
    suiteId: suite.id,
    agentId: agent.id,
    connectionId: chatConnectionId,
  });
  const { rows } = await database.sql<{
    persona_version_id: string;
    test_id: string;
    test_version_id: string;
  }>(
    `select persona_version_id, test_id, test_version_id from simulation
     where run_id = $1 limit 1`,
    [started.id],
  );
  const pins = rows[0];
  if (pins === undefined) throw new Error("the run has no simulation");

  const made: SeededRun = {
    runId: started.id,
    agentId: agent.id,
    connectionId: voiceConnectionId,
    personaId,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
  };
  runs.set(who.organizationId, made);
  return made;
}

let position = 500;

/** One voice conversation of exactly this many seconds, ending at this instant. */
async function conversation(
  who: typeof acme,
  lane: {
    readonly connectionType: "livekit_room" | "phone_number";
    readonly endedAt: Date;
    readonly seconds: number;
  },
): Promise<void> {
  const run = await seedRun(who);
  position += 1;
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at, persona_parameter_values)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'voice', $12,
             'completed', 'persona_concluded',
             $13::timestamptz - make_interval(secs => $14::double precision),
             $13::timestamptz,
             (select persona_parameter_values from simulation where run_id = $2 limit 1))`,
    [
      newId("sim"),
      run.runId,
      who.organizationId,
      who.projectId,
      run.agentId,
      run.connectionId,
      run.personaId,
      run.personaVersionId,
      run.testId,
      run.testVersionId,
      position,
      lane.connectionType,
      lane.endedAt,
      lane.seconds,
    ],
  );
}

describe("durable period meter progress", () => {
  it("keeps fractional minutes, the ten-second minimum, and the activation floor", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:05Z"),
      seconds: 5,
    });
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:30:30Z"),
      seconds: 60,
    });
    await conversation(globex, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      const send = pending(await progress.next(period, latest, AT));
      expect(send.seconds).toBe(10);
      expect(send.value).toBe("0.166666666667");
      expect(send.timestamp).toEqual(START);
      await progress.finish(send, "accepted", AT);
    });
    expect(Number((await row())?.accepted_seconds)).toBe(10);
  });
  it("commits a frozen first report before the outer visitor or network fails", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 30,
    });
    let frozen: PendingMeterReport | undefined;
    await expect(
      visit(async (progress) => {
        frozen = pending(await progress.next(period, latest, AT));
        throw new Error("network uncertain");
      }),
    ).rejects.toThrow("network uncertain");
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:45:00Z"),
      seconds: 30,
    });
    await visit(async (progress) => {
      expect(
        pending(
          await progress.next(period, latest, new Date(AT.getTime() + 3600000)),
        ),
      ).toEqual(frozen);
      if (frozen === undefined) throw new Error("missing frozen report");
      await progress.finish(frozen, "accepted", AT);
      const next = pending(await progress.next(period, latest, AT));
      expect(next.seconds).toBe(30);
      expect(next.value).toBe("0.500000000000");
      expect(next.identifier).not.toBe(frozen.identifier);
    });
  });
  it("uses a safe offset for an uncertain send and retains only new known usage", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:10Z"),
      seconds: 10,
    });
    await visit(async (progress) => {
      const first = pending(await progress.next(period, latest, AT));
      await progress.finish(first, "uncertain", AT);
      await conversation(acme, {
        connectionType: "livekit_room",
        endedAt: new Date("2026-09-20T13:50:10Z"),
        seconds: 10,
      });
      const next = pending(await progress.next(period, latest, AT));
      expect(next.seconds).toBe(10);
      expect(next.value).toBe("0.166666666666");
      await progress.finish(next, "accepted", AT);
      await progress.finish(next, "accepted", AT);
    });
    expect(Number((await row())?.accepted_seconds)).toBe(10);
    expect(Number((await row())?.uncertain_seconds)).toBe(10);
  });
  it("catches every missed hour independently for each channel", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 30,
    });
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T15:40:00Z"),
      seconds: 60,
    });
    await conversation(acme, {
      connectionType: "phone_number",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 90,
    });
    await visit(async (progress) => {
      for (let i = 0; i < 4; i += 1) {
        const next = await progress.next(period, latest, AT);
        if (next.kind === "send")
          await progress.finish(next.report, "accepted", AT);
        else expect(next.kind).toBe("advanced");
      }
      expect((await progress.next(period, latest, AT)).kind).toBe("idle");
      const phone = {
        ...period,
        channel: "phone_minutes" as const,
        meterId: "meter_phone",
        eventName: "egma_phone_minutes",
        priceId: "price_phone",
      };
      expect(pending(await progress.next(phone, latest, AT)).seconds).toBe(90);
    });
    expect(Number((await row())?.accepted_seconds)).toBe(90);
    expect(Number((await row("phone_minutes"))?.accepted_seconds)).toBe(0);
  });
  it("collects a whole call in its starting period when it completes after reset or cancellation", async () => {
    const ended = new Date("2026-09-20T14:30:00Z");
    const old = {
      ...period,
      periodEndsAt: ended,
      invoiceId: "in_draft_cycle",
      acceptingUsage: true,
    };
    await visit(async (progress) => {
      expect((await progress.next(old, latest, AT)).kind).toBe("advanced");
      expect((await progress.next(old, latest, AT)).kind).toBe("advanced");
      expect((await progress.next(old, latest, AT)).kind).toBe("advanced");
    });
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T14:31:00Z"),
      seconds: 120,
    });
    await visit(async (progress) => {
      const send = pending(
        await progress.next(
          old,
          hourAround(AT),
          new Date("2026-09-20T18:00:00Z"),
        ),
      );
      expect(send.seconds).toBe(120);
      expect(send.timestamp).toEqual(new Date("2026-09-20T14:29:59Z"));
      await progress.finish(send, "accepted", AT);
    });
  });
  it("retains known usage that a finalized invoice cannot accept", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      expect(
        await progress.next(
          { ...period, acceptingUsage: false, invoiceId: "in_paid" },
          latest,
          AT,
        ),
      ).toEqual({ kind: "attention", reason: "invoice_closed", seconds: 60 });
    });
    expect(await row()).toMatchObject({
      state: "needs_attention",
      pending_identifier: null,
      accepted_seconds: "0",
      uncertain_seconds: "0",
      last_observed_seconds: "60",
    });
  });
  it("retains pending original-period evidence after its invoice closes", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      const first = pending(await progress.next(period, latest, AT));
      const held = pending(
        await progress.next(
          { ...period, acceptingUsage: false, invoiceId: "in_paid" },
          latest,
          AT,
        ),
      );
      expect(held.identifier).toBe(first.identifier);
      expect(held.value).toBe(first.value);
      expect(await row()).toMatchObject({
        state: "needs_attention",
        pending_identifier: first.identifier,
      });
      const remembered = await progress.periods();
      expect(remembered).toHaveLength(1);
      expect(remembered[0]).toMatchObject({
        priceId: period.priceId,
        acceptingUsage: false,
      });
    });
  });
  it("does not discard known usage outside Stripe's event timestamp window", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      expect(
        await progress.next(period, latest, new Date("2026-11-01T00:00:00Z")),
      ).toEqual({
        kind: "attention",
        reason: "timestamp_expired",
        seconds: 60,
      });
    });
    expect(await row()).toMatchObject({
      last_observed_seconds: "60",
      accepted_seconds: "0",
      uncertain_seconds: "0",
    });
  });
  it("uses the committed pending quantity even if a caller holds altered fields", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      const first = pending(await progress.next(period, latest, AT));
      await progress.finish(
        { ...first, seconds: 999999, hour: new Date("2027-01-01T00:00:00Z") },
        "accepted",
        AT,
      );
    });
    expect(await row()).toMatchObject({
      accepted_seconds: "60",
      observed_through_hour: new Date("2026-09-20T13:00:00Z"),
    });
  });
  it("refuses changed collection objects or decreasing observed totals", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      const first = pending(await progress.next(period, latest, AT));
      await expect(
        progress.next({ ...period, priceId: "price_changed" }, latest, AT),
      ).rejects.toThrow("collection objects");
      await progress.finish(first, "accepted", AT);
      await database.sql("delete from simulation where position >= 501");
      await expect(progress.next(period, latest, AT)).rejects.toThrow(
        "nondecreasing",
      );
    });
    expect(Number((await row())?.accepted_seconds)).toBe(60);
  });
  it("requires every field of a pending payload and an in-period timestamp", async () => {
    await visit(async (progress) => {
      await progress.next(period, latest, AT);
    });
    await expect(
      database.sql(
        "update cloud_meter_period set pending_identifier = 'partial'",
      ),
    ).rejects.toThrow();
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T14:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      await progress.next(period, latest, AT);
    });
    await expect(
      database.sql(
        "update cloud_meter_period set pending_timestamp = period_ends_at",
      ),
    ).rejects.toThrow();
  });

  it("does not clear a credit failure after an unrelated successful subscription refresh", async () => {
    await visit(async (progress) => {
      await progress.failed();
      const version = await progress.failureVersion();
      await applyStripeEvent(
        {
          id: "evt_subscription_health",
          type: "customer.subscription.updated",
          fact: { kind: "subscription", customerId: acme.customerId },
        },
        AT,
        async () => ({
          subscriptionId: null,
          status: null,
          periodAnchor: null,
          periodStartedAt: null,
          periodEndsAt: null,
          hobbyStartedAt: null,
        }),
      );
      expect(await progress.recovered(version, latest, AT)).toBe(false);
      const { rows } = await database.sql(
        "select stripe_failed_at from cloud_billing_account where organization_id = $1",
        [acme.organizationId],
      );
      expect(rows[0]?.stripe_failed_at).not.toBeNull();
    });
  });
  it("recovers all paid credit identities once and keeps a concurrent newer failure", async () => {
    const credit = {
      kind: "purchased_credit" as const,
      customerId: acme.customerId,
      sessionId: "cs_reconciliation",
      organizationId: acme.organizationId,
      amountMicros: 25000000,
      occurredAt: AT,
    };
    const facts = {
      credits: [credit],
      subscription: {
        subscriptionId: null,
        status: null,
        periodAnchor: null,
        periodStartedAt: null,
        periodEndsAt: null,
        hobbyStartedAt: null,
      },
    };
    await visit(async (progress) => {
      await progress.failed();
      const before = await progress.failureVersion();
      await progress.reconcile(async () => facts, AT);
      await progress.failed();
      expect(await progress.recovered(before, latest, AT)).toBe(false);
      const after = await progress.failureVersion();
      await progress.reconcile(async () => facts, AT);
      expect(await progress.recovered(after, latest, AT)).toBe(true);
      const { rows } = await database.sql(
        "select count(*)::int as entries from cloud_ledger_entry where reference_id = $1",
        [credit.sessionId],
      );
      expect(rows[0]?.entries).toBe(1);
      const account = await database.sql(
        "select stripe_failed_at from cloud_billing_account where organization_id = $1",
        [acme.organizationId],
      );
      expect(account.rows[0]?.stripe_failed_at).toBeNull();
    });
  });
  it("does not call a finalized-invoice shortfall healthy after credit and plan reconciliation", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    await visit(async (progress) => {
      await progress.failed();
      const version = await progress.failureVersion();
      await progress.next({ ...period, acceptingUsage: false }, latest, AT);
      await progress.reconcile(
        async () => ({
          credits: [],
          subscription: {
            subscriptionId: null,
            status: null,
            periodAnchor: null,
            periodStartedAt: null,
            periodEndsAt: null,
            hobbyStartedAt: null,
          },
        }),
        AT,
      );
      expect(await progress.recovered(version, latest, AT)).toBe(false);
    });
  });

  it("serializes competing workers while preserving one frozen payload", async () => {
    await conversation(acme, {
      connectionType: "livekit_room",
      endedAt: new Date("2026-09-20T13:40:00Z"),
      seconds: 60,
    });
    const reports: PendingMeterReport[] = [];
    await Promise.all([
      visit(async (progress) => {
        reports.push(pending(await progress.next(period, latest, AT)));
      }),
      visit(async (progress) => {
        reports.push(pending(await progress.next(period, latest, AT)));
      }),
    ]);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toEqual(reports[1]);
  });
});
