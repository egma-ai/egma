import {
  checkpointRetellMonitoringPage,
  claimDueRetellMonitoringAgent,
  claimRetellIngestionFailureReplay,
  claimProductionTrace,
  configureRetellMonitoring,
  failRetellIngestionFailureReplay,
  failRetellMonitoringTarget,
  finishRetellMonitoringScan,
  listMonitoringSetups,
  NotPermittedError,
  recordRetellIngestionFailure,
  recordRetellMonitoringReceived,
  releaseRetellIngestionFailureReplay,
  resolveRetellIngestionFailureReplay,
  renewRetellMonitoringLease,
  yieldRetellMonitoringLease,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");
const RETELL_KEY = "key_live_retell_monitoring_secret_QRST";
const SETUP_TIME = new Date("2026-08-20T08:00:00.000Z");

function at(
  customer: typeof acme,
  userId: string,
  role: "admin" | "member" | "viewer" = "admin",
): AuthContext {
  return {
    userId,
    organizationId: customer.organization,
    projectId: customer.project,
    role,
    via: "session",
  };
}

function selected() {
  return [
    {
      providerAgentId: "agent_retell_voice_1",
      providerAgentName: "Front desk",
    },
  ] as const;
}

beforeAll(async () => {
  database = await createConnectedDatabase("production_monitoring");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, gene, "gene@globex.example");
});

beforeEach(async () => {
  await database.sql(
    "truncate retell_ingestion_failure, production_trace_claim, " +
      "retell_monitored_agent, monitoring_setup cascade",
  );
});

afterAll(async () => {
  await database.drop();
});

describe("Retell Monitoring setup", () => {
  it("stores one sealed key and gives each selected agent a fixed 30-day import", async () => {
    const configured = await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });

    expect(configured).toMatchObject({
      agentPlatform: "retell",
      strategy: "retell_api_polling",
      credentialsHint: "QRST",
      agents: [
        {
          providerAgentId: "agent_retell_voice_1",
          providerAgentName: "Front desk",
          state: "importing",
          scanKind: "historical_import",
        },
      ],
    });
    expect(JSON.stringify(configured)).not.toContain(RETELL_KEY);

    const setup = await database.sql<{ credentials: string }>(
      "select credentials from monitoring_setup",
    );
    expect(setup.rows[0]?.credentials).not.toContain(RETELL_KEY);
    expect(setup.rows[0]?.credentials.startsWith("v1.")).toBe(true);

    const importState = await database.sql<{
      scan_from: Date;
      scan_through: Date;
      pagination_trail: string;
    }>(
      "select scan_from, scan_through, pagination_trail " +
        "from retell_monitored_agent",
    );
    expect(importState.rows[0]).toEqual({
      scan_from: new Date("2026-07-21T08:00:00.000Z"),
      scan_through: SETUP_TIME,
      pagination_trail: "[]",
    });
  });

  it("lets only one replica claim one due selected agent", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });

    const [first, second] = await Promise.all([
      claimDueRetellMonitoringAgent({ now: SETUP_TIME }),
      claimDueRetellMonitoringAgent({ now: SETUP_TIME }),
    ]);
    const held = [first, second].filter(
      (target): target is NonNullable<typeof target> => target !== undefined,
    );

    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      providerAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      scanKind: "historical_import",
      seenPaginationKeys: [],
      auth: {
        organizationId: acme.organization,
        projectId: acme.project,
        via: "monitoring",
      },
    });
  });

  it("stops an already leased agent when another agent sets the key-wide gate", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        ...selected(),
        {
          providerAgentId: "agent_retell_voice_2",
          providerAgentName: "Overflow desk",
        },
      ],
      now: SETUP_TIME,
    });
    const first = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    const alreadyLeased = await claimDueRetellMonitoringAgent({
      now: SETUP_TIME,
    });
    expect(first).toBeDefined();
    expect(alreadyLeased).toBeDefined();
    if (first === undefined || alreadyLeased === undefined) return;

    const retryAt = new Date(SETUP_TIME.getTime() + 60_000);
    await failRetellMonitoringTarget(first.auth, first, {
      kind: "rate_limited",
      retryAt,
      now: SETUP_TIME,
    });

    expect(
      await renewRetellMonitoringLease(
        alreadyLeased.auth,
        alreadyLeased,
        { now: new Date(SETUP_TIME.getTime() + 1_000) },
      ),
    ).toBe(false);
  });

  it("keeps the provider cursor and fixed window when bounded work yields", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const first = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(first).toBeDefined();
    if (first === undefined) return;

    expect(
      await checkpointRetellMonitoringPage(first.auth, first, {
        paginationKey: "opaque/page-2",
        seenPaginationKeys: ["opaque/page-2"],
      }),
    ).toBe(true);
    const resumeAt = new Date(SETUP_TIME.getTime() + 1_000);
    expect(
      await yieldRetellMonitoringLease(first.auth, first, {
        retryAt: resumeAt,
        now: SETUP_TIME,
      }),
    ).toBe(true);

    const resumed = await claimDueRetellMonitoringAgent({ now: resumeAt });
    expect(resumed).toMatchObject({
      scanKind: "historical_import",
      scanFrom: new Date("2026-07-21T08:00:00.000Z"),
      scanThrough: SETUP_TIME,
      paginationKey: "opaque/page-2",
      seenPaginationKeys: ["opaque/page-2"],
    });
    if (resumed === undefined) return;
    expect(
      await checkpointRetellMonitoringPage(at(globex, gene), resumed, {
        paginationKey: "opaque/cross-tenant",
        seenPaginationKeys: ["opaque/cross-tenant"],
      }),
    ).toBe(false);
  });

  it("runs a current scan between bounded pages of a large reconciliation", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const historical = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(historical).toBeDefined();
    if (historical === undefined) return;
    expect(
      await finishRetellMonitoringScan(historical.auth, historical, {
        now: SETUP_TIME,
      }),
    ).toBe(true);

    const reconciliationAt = new Date("2026-08-21T08:00:00.000Z");
    const nextRegularAt = new Date(reconciliationAt.getTime() + 30_000);
    await database.sql(
      "update retell_monitored_agent " +
        "set next_poll_at = $1, next_reconciliation_at = $1, " +
        "next_regular_poll_at = $2",
      [reconciliationAt, nextRegularAt],
    );
    const reconciliation = await claimDueRetellMonitoringAgent({
      now: reconciliationAt,
    });
    expect(reconciliation).toMatchObject({
      scanKind: "reconciliation",
      scanFrom: new Date("2026-07-22T08:00:00.000Z"),
      scanThrough: reconciliationAt,
      paginationKey: null,
    });
    if (reconciliation === undefined) return;
    expect(
      await checkpointRetellMonitoringPage(
        reconciliation.auth,
        reconciliation,
        {
          paginationKey: "opaque/reconciliation-page-2",
          seenPaginationKeys: ["opaque/reconciliation-page-2"],
        },
      ),
    ).toBe(true);

    const boundedAt = new Date(reconciliationAt.getTime() + 20_000);
    expect(
      await yieldRetellMonitoringLease(
        reconciliation.auth,
        reconciliation,
        {
          retryAt: new Date(boundedAt.getTime() + 30_000),
          now: boundedAt,
        },
      ),
    ).toBe(true);

    expect(
      await claimDueRetellMonitoringAgent({
        now: new Date(nextRegularAt.getTime() - 1),
      }),
    ).toBeUndefined();
    const regular = await claimDueRetellMonitoringAgent({ now: nextRegularAt });
    expect(regular).toMatchObject({
      scanKind: "regular",
      scanFrom: new Date(SETUP_TIME.getTime() - 5 * 60_000),
      scanThrough: nextRegularAt,
      paginationKey: null,
      seenPaginationKeys: [],
    });
    if (regular === undefined) return;
    expect(
      await finishRetellMonitoringScan(regular.auth, regular, {
        now: nextRegularAt,
      }),
    ).toBe(true);

    const resumed = await claimDueRetellMonitoringAgent({ now: nextRegularAt });
    expect(resumed).toMatchObject({
      scanKind: "reconciliation",
      scanFrom: new Date("2026-07-22T08:00:00.000Z"),
      scanThrough: reconciliationAt,
      paginationKey: "opaque/reconciliation-page-2",
      seenPaginationKeys: ["opaque/reconciliation-page-2"],
    });
  });

  it("keeps an agent degraded after the rest of its scan finishes", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;

    expect(
      await recordRetellIngestionFailure(target.auth, target, {
        providerCallId: "call_missing_1",
        errorKind: "call_not_found",
        safePayload: '{"call_id":"call_missing_1"}',
        now: SETUP_TIME,
      }),
    ).toEqual({ changed: true });
    expect(
      await recordRetellIngestionFailure(target.auth, target, {
        providerCallId: "call_missing_1",
        errorKind: "call_not_found",
        now: SETUP_TIME,
      }),
    ).toEqual({ changed: false });

    expect(
      await finishRetellMonitoringScan(target.auth, target, {
        now: SETUP_TIME,
      }),
    ).toBe(true);
    const [setup] = await listMonitoringSetups(target.auth);
    expect(setup?.agents[0]).toMatchObject({
      state: "degraded",
      scanKind: null,
      lastErrorKind: "call_not_found",
      failures: [
        {
          providerCallId: "call_missing_1",
          errorKind: "call_not_found",
          attempts: 2,
          status: "open",
        },
      ],
    });
  });

  it("leases one exact failed call for replay and keeps tenancy explicit", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;
    await recordRetellIngestionFailure(target.auth, target, {
      providerCallId: "call_exact_replay",
      errorKind: "provider_call_not_found",
      now: SETUP_TIME,
    });
    const [setup] = await listMonitoringSetups(auth);
    const failureId = setup?.agents[0]?.failures[0]?.id;
    expect(failureId).toBeDefined();
    if (failureId === undefined) return;

    const first = await claimRetellIngestionFailureReplay(auth, failureId, {
      now: SETUP_TIME,
    });
    expect(first).toMatchObject({
      kind: "claimed",
      target: {
        failureId,
        providerCallId: "call_exact_replay",
        providerAgentId: "agent_retell_voice_1",
        providerAgentName: "Front desk",
        apiKey: RETELL_KEY,
        auth: {
          organizationId: acme.organization,
          projectId: acme.project,
          via: "monitoring",
        },
      },
    });
    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: SETUP_TIME,
      }),
    ).toMatchObject({ kind: "busy" });
    expect(
      await claimRetellIngestionFailureReplay(
        at(globex, gene),
        failureId,
        { now: SETUP_TIME },
      ),
    ).toEqual({ kind: "not_found" });

    if (first.kind !== "claimed") return;
    expect(
      await releaseRetellIngestionFailureReplay(
        first.target.auth,
        first.target,
        {
          errorKind: "provider_call_not_found",
          now: SETUP_TIME,
        },
      ),
    ).toBe(true);
    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: SETUP_TIME,
      }),
    ).toMatchObject({ kind: "claimed" });
  });

  it("keeps manual replay behind the setup-wide Retry-After gate", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;
    await recordRetellIngestionFailure(target.auth, target, {
      providerCallId: "call_rate_limited_replay",
      errorKind: "provider_call_not_found",
      now: SETUP_TIME,
    });
    const failureId = (await listMonitoringSetups(auth))[0]?.agents[0]
      ?.failures[0]?.id;
    expect(failureId).toBeDefined();
    if (failureId === undefined) return;

    const first = await claimRetellIngestionFailureReplay(auth, failureId, {
      now: SETUP_TIME,
    });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    const retryAt = new Date(SETUP_TIME.getTime() + 60_000);
    expect(
      await failRetellIngestionFailureReplay(first.target.auth, first.target, {
        kind: "rate_limited",
        retryAt,
        now: SETUP_TIME,
      }),
    ).toMatchObject({ recorded: true, changed: true });

    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: new Date(SETUP_TIME.getTime() + 1_000),
      }),
    ).toEqual({
      kind: "busy",
      reason: "rate_limited",
      retryAt,
    });
    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: retryAt,
      }),
    ).toMatchObject({ kind: "claimed" });
  });

  it("clears degraded state only after every failed call is resolved", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;
    for (const providerCallId of ["call_replay_one", "call_replay_two"]) {
      await recordRetellIngestionFailure(target.auth, target, {
        providerCallId,
        errorKind: "provider_call_not_found",
        now: SETUP_TIME,
      });
    }
    await finishRetellMonitoringScan(target.auth, target, { now: SETUP_TIME });
    const [before] = await listMonitoringSetups(auth);
    const failures = before?.agents[0]?.failures ?? [];
    expect(failures).toHaveLength(2);

    const first = await claimRetellIngestionFailureReplay(auth, failures[0]!.id, {
      now: SETUP_TIME,
    });
    expect(first.kind).toBe("claimed");
    if (first.kind !== "claimed") return;
    expect(
      await resolveRetellIngestionFailureReplay(
        first.target.auth,
        first.target,
        { now: SETUP_TIME },
      ),
    ).toEqual({ resolved: true, agentRecovered: false });
    expect((await listMonitoringSetups(auth))[0]?.agents[0]).toMatchObject({
      state: "degraded",
      failures: [{ providerCallId: "call_replay_two" }],
    });

    const second = await claimRetellIngestionFailureReplay(
      auth,
      failures[1]!.id,
      { now: SETUP_TIME },
    );
    expect(second.kind).toBe("claimed");
    if (second.kind !== "claimed") return;
    expect(
      await resolveRetellIngestionFailureReplay(
        second.target.auth,
        second.target,
        { now: SETUP_TIME },
      ),
    ).toEqual({ resolved: true, agentRecovered: true });
    expect((await listMonitoringSetups(auth))[0]?.agents[0]).toMatchObject({
      state: "active",
      failures: [],
    });
  });

  it("keeps one Retell call claim across setup recreation", async () => {
    const auth = at(acme, ada);
    const offer = {
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      providerCallId: "call_one_visible_trace",
      providerAgentId: "agent_retell_voice_1",
      providerAgentName: "Front desk",
      providerAgentVersion: "7",
      payload: '{"call_id":"call_one_visible_trace"}',
      endedAt: SETUP_TIME,
    };

    expect(await claimProductionTrace(auth, offer)).toMatchObject(offer);
    expect(await claimProductionTrace(auth, offer)).toBeUndefined();
  });

  it("restores selected-agent progress when a stale trace claim replays", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const replayedAt = new Date("2026-08-20T08:03:00.000Z");

    await recordRetellMonitoringReceived(auth, {
      providerAgentId: selected()[0].providerAgentId,
      receivedAt: replayedAt,
    });

    const [setup] = await listMonitoringSetups(auth);
    expect(setup).toMatchObject({
      lastReceivedAt: replayedAt,
      agents: [{ lastCallReceivedAt: replayedAt }],
    });
  });

  it("refuses a viewer before it stores the key", async () => {
    await expect(
      configureRetellMonitoring(at(acme, ada, "viewer"), {
        apiKey: RETELL_KEY,
        agents: selected(),
        now: SETUP_TIME,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
    const stored = await database.sql<{ count: string }>(
      "select count(*) as count from monitoring_setup",
    );
    expect(stored.rows[0]?.count).toBe("0");
  });
});
