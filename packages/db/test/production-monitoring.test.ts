import {
  checkpointRetellMonitoringPage,
  claimDueRetellMonitoringAgent,
  claimRetellIngestionFailureReplay,
  claimProductionTrace,
  configureLiveKitMonitoring,
  configureRetellMonitoring,
  failRetellIngestionFailureReplay,
  failRetellMonitoringTarget,
  finishRetellMonitoringScan,
  finishProductionTrace,
  listMonitoringSetups,
  NotPermittedError,
  recordProductionEvidenceReceived,
  recordRetellIngestionFailure,
  recoverRetellMonitoringSetup,
  releaseRetellIngestionFailureReplay,
  releaseRetellMonitoringLease,
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
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const acmeOther = { organization: acme.organization, project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");
const RETELL_KEY = "key_live_retell_monitoring_secret_QRST";
const ROTATED_RETELL_KEY = "key_live_retell_monitoring_rotated_WXYZ";
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
      platformAgentId: "agent_retell_voice_1",
      platformAgentName: "Front desk",
    },
  ] as const;
}

beforeAll(async () => {
  database = await createConnectedDatabase("production_monitoring");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acmeOther.project, slug: "other" },
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
          platformAgentId: "agent_retell_voice_1",
          platformAgentName: "Front desk",
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

  it("lets two first saves share one Retell Monitoring setup", async () => {
    const auth = at(acme, ada);
    await database.sql(`
      create function pause_first_monitoring_setup_insert()
      returns trigger language plpgsql as $$
      begin
        perform pg_sleep(0.15);
        return new;
      end
      $$
    `);
    await database.sql(`
      create trigger pause_first_monitoring_setup_insert
      before insert on monitoring_setup
      for each row execute function pause_first_monitoring_setup_insert()
    `);
    try {
      const [first, second] = await Promise.all([
        configureRetellMonitoring(auth, {
          apiKey: RETELL_KEY,
          agents: selected(),
          now: SETUP_TIME,
        }),
        configureRetellMonitoring(auth, {
          apiKey: RETELL_KEY,
          agents: selected(),
          now: SETUP_TIME,
        }),
      ]);

      expect(first.id).toBe(second.id);
      expect(
        await database.sql<{ count: string }>(
          "select count(*) from monitoring_setup where project_id = $1 " +
            "and agent_platform = 'retell'",
          [acme.project],
        ),
      ).toMatchObject({ rows: [{ count: "1" }] });
    } finally {
      await database.sql(
        "drop trigger pause_first_monitoring_setup_insert on monitoring_setup",
      );
      await database.sql("drop function pause_first_monitoring_setup_insert()");
    }
  });

  it("lists Monitoring setup only inside the acting project", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });

    expect(await listMonitoringSetups(at(acmeOther, ada))).toEqual([]);
  });

  it("records received production evidence only in the acting project", async () => {
    const acmeAuth = at(acme, ada);
    const otherAuth = at(acmeOther, ada);
    for (const auth of [acmeAuth, otherAuth]) {
      await configureRetellMonitoring(auth, {
        apiKey: RETELL_KEY,
        agents: selected(),
        now: SETUP_TIME,
      });
      await configureLiveKitMonitoring(auth);
    }

    const retellReceivedAt = new Date("2026-08-20T08:01:00.000Z");
    const liveKitReceivedAt = new Date("2026-08-20T08:02:00.000Z");
    await recordProductionEvidenceReceived(acmeAuth, {
      agentPlatform: "retell",
      platformAgentId: selected()[0].platformAgentId,
      receivedAt: retellReceivedAt,
    });
    await recordProductionEvidenceReceived(acmeAuth, {
      agentPlatform: "livekit_agents",
      receivedAt: liveKitReceivedAt,
    });

    const acmeSetups = await listMonitoringSetups(acmeAuth);
    expect(
      acmeSetups.find((setup) => setup.agentPlatform === "retell"),
    ).toMatchObject({
      lastReceivedAt: retellReceivedAt,
      agents: [{ lastCallReceivedAt: retellReceivedAt }],
    });
    expect(
      acmeSetups.find((setup) => setup.agentPlatform === "livekit_agents"),
    ).toMatchObject({ lastReceivedAt: liveKitReceivedAt });

    const otherSetups = await listMonitoringSetups(otherAuth);
    expect(
      otherSetups.find((setup) => setup.agentPlatform === "retell"),
    ).toMatchObject({
      lastReceivedAt: null,
      agents: [{ lastCallReceivedAt: null }],
    });
    expect(
      otherSetups.find((setup) => setup.agentPlatform === "livekit_agents"),
    ).toMatchObject({ lastReceivedAt: null });
  });

  it("rejects a selected agent that pairs another tenant with the setup key", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const setup = await database.sql<{ id: string }>(
      "select id from monitoring_setup",
    );

    await expect(
      database.sql(
        `insert into retell_monitored_agent
           (id, monitoring_setup_id, organization_id, project_id,
            platform_agent_id, platform_agent_name, next_regular_poll_at,
            next_poll_at, next_reconciliation_at)
         values ($1, $2, $3, $4, 'agent_cross_tenant', 'Cross tenant',
                 $5, $5, $5)`,
        [
          newId("rma"),
          setup.rows[0]?.id,
          globex.organization,
          globex.project,
          SETUP_TIME,
        ],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("rejects a failed call that pairs another tenant with the selected agent", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const monitored = await database.sql<{ id: string }>(
      "select id from retell_monitored_agent",
    );

    await expect(
      database.sql(
        `insert into retell_ingestion_failure
           (id, organization_id, project_id, retell_monitored_agent_id,
            provider_call_id, error_kind, last_attempt_at)
         values ($1, $2, $3, $4, 'call_cross_tenant', 'invalid_document', $5)`,
        [
          newId("rif"),
          globex.organization,
          globex.project,
          monitored.rows[0]?.id,
          SETUP_TIME,
        ],
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
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
      platformAgentId: "agent_retell_voice_1",
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

  it("keeps a retained agent's active lease when setup is saved", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const active = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(active).toBeDefined();
    if (active === undefined) return;

    const savedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: savedAt,
    });

    expect(
      await claimDueRetellMonitoringAgent({ now: savedAt }),
    ).toBeUndefined();
    expect(
      await renewRetellMonitoringLease(active.auth, active, { now: savedAt }),
    ).toBe(true);
  });

  it("ignores a provider failure from a lease that used the previous key", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const stale = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(stale).toBeDefined();
    if (stale === undefined) return;

    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: ROTATED_RETELL_KEY,
      agents: selected(),
      now: rotatedAt,
    });
    await failRetellMonitoringTarget(stale.auth, stale, {
      kind: "invalid_credential",
      retryAt: new Date("9999-12-31T23:59:59.999Z"),
      now: rotatedAt,
    });

    expect((await listMonitoringSetups(auth))[0]).toMatchObject({
      healthState: "healthy",
      blockedUntil: null,
      consecutiveFailures: 0,
    });
    expect(
      await claimDueRetellMonitoringAgent({ now: rotatedAt }),
    ).toMatchObject({ apiKey: ROTATED_RETELL_KEY });
  });

  it("ignores a provider failure after the target lost its lease", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const stale = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(stale).toBeDefined();
    if (stale === undefined) return;
    await yieldRetellMonitoringLease(stale.auth, stale, {
      retryAt: new Date(SETUP_TIME.getTime() + 30_000),
      now: SETUP_TIME,
    });

    await failRetellMonitoringTarget(stale.auth, stale, {
      kind: "invalid_credential",
      retryAt: new Date("9999-12-31T23:59:59.999Z"),
      now: SETUP_TIME,
    });

    expect((await listMonitoringSetups(auth))[0]).toMatchObject({
      healthState: "healthy",
      blockedUntil: null,
      consecutiveFailures: 0,
    });
  });

  it("ignores a permanent call failure from the previous key", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const stale = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(stale).toBeDefined();
    if (stale === undefined) return;

    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: ROTATED_RETELL_KEY,
      agents: selected(),
      now: rotatedAt,
    });

    expect(
      await recordRetellIngestionFailure(stale.auth, stale, {
        providerCallId: "call_from_previous_key",
        errorKind: "provider_call_not_found",
        now: rotatedAt,
      }),
    ).toEqual({ recorded: false, changed: false });
    expect((await listMonitoringSetups(auth))[0]?.agents[0]).toMatchObject({
      state: "importing",
      failures: [],
    });
  });

  it("ignores a permanent call failure after its lease is reassigned", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const stale = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(stale).toBeDefined();
    if (stale === undefined) return;

    const reassignedAt = new Date(SETUP_TIME.getTime() + 30_000);
    expect(
      await yieldRetellMonitoringLease(stale.auth, stale, {
        retryAt: reassignedAt,
        now: SETUP_TIME,
      }),
    ).toBe(true);
    const current = await claimDueRetellMonitoringAgent({ now: reassignedAt });
    expect(current).toBeDefined();
    if (current === undefined) return;
    expect(current.leaseOwner).not.toBe(stale.leaseOwner);

    expect(
      await recordRetellIngestionFailure(stale.auth, stale, {
        providerCallId: "call_from_previous_lease",
        errorKind: "provider_call_not_found",
        now: reassignedAt,
      }),
    ).toEqual({ recorded: false, changed: false });
    expect(
      await renewRetellMonitoringLease(current.auth, current, {
        now: reassignedAt,
      }),
    ).toBe(true);
    expect((await listMonitoringSetups(auth))[0]?.agents[0]).toMatchObject({
      state: "importing",
      failures: [],
    });
  });

  it("releases an old-key target without attaching its contract error", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const stale = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(stale).toBeDefined();
    if (stale === undefined) return;

    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: ROTATED_RETELL_KEY,
      agents: selected(),
      now: rotatedAt,
    });
    await releaseRetellMonitoringLease(stale.auth, stale, {
      retryAt: new Date(rotatedAt.getTime() + 30_000),
      errorKind: "provider_contract",
      now: rotatedAt,
    });

    expect((await listMonitoringSetups(auth))[0]?.agents[0]).toMatchObject({
      lastErrorKind: null,
      consecutiveFailures: 0,
    });
    expect(
      await claimDueRetellMonitoringAgent({ now: rotatedAt }),
    ).toMatchObject({ apiKey: ROTATED_RETELL_KEY });
  });

  it("does not release a selected agent through another setup id", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const liveKit = await configureLiveKitMonitoring(auth);
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;

    await failRetellMonitoringTarget(
      target.auth,
      { ...target, setupId: liveKit.id },
      {
        kind: "provider_unavailable",
        retryAt: new Date(SETUP_TIME.getTime() + 30_000),
        now: SETUP_TIME,
      },
    );

    expect(
      await renewRetellMonitoringLease(target.auth, target, {
        now: SETUP_TIME,
      }),
    ).toBe(true);
  });

  /**
   * **A replay is not news.**
   *
   * Evidence becomes durable in one order and is drained in another, so an
   * older segment can perfectly well be written after a newer one — a
   * ClickHouse outage, a retained object repaired a day later, a restart that
   * found a backlog. Each of those carries the instant its evidence was
   * received rather than the instant it is being replayed at, and a plain
   * assignment would answer a customer's "last production conversation" by
   * winding it back to a call from an hour ago. The merge is `greatest`, so the
   * later fact stands whichever order the two arrive in.
   */
  it("never winds a customer's last-received state backwards", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });

    const newer = new Date("2026-08-20T09:00:00.000Z");
    const older = new Date("2026-08-20T08:00:00.000Z");
    for (const receivedAt of [newer, older]) {
      await recordProductionEvidenceReceived(auth, {
        agentPlatform: "retell",
        platformAgentId: selected()[0].platformAgentId,
        receivedAt,
      });
    }

    const [setup] = await listMonitoringSetups(auth);
    expect(setup).toMatchObject({
      lastReceivedAt: newer,
      agents: [{ lastCallReceivedAt: newer }],
    });

    // And the same instant twice is a no-op rather than a step of any kind,
    // which is what a rediscovered object does.
    await recordProductionEvidenceReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: selected()[0].platformAgentId,
      receivedAt: newer,
    });
    expect((await listMonitoringSetups(auth))[0]).toMatchObject({
      lastReceivedAt: newer,
      agents: [{ lastCallReceivedAt: newer }],
    });
  });

  it("moves only the named platform's setup, never the one beside it", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    await configureLiveKitMonitoring(auth);

    const receivedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await recordProductionEvidenceReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: selected()[0].platformAgentId,
      receivedAt,
    });

    const setups = await listMonitoringSetups(auth);
    expect(
      setups.find((setup) => setup.agentPlatform === "retell"),
    ).toMatchObject({ lastReceivedAt: receivedAt });
    // A customer with both platforms configured has two independent facts, and
    // one platform's evidence is not the other platform's news.
    expect(
      setups.find((setup) => setup.agentPlatform === "livekit_agents"),
    ).toMatchObject({ lastReceivedAt: null });
  });

  it("stops an already leased agent when another agent sets the key-wide gate", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        ...selected(),
        {
          platformAgentId: "agent_retell_voice_2",
          platformAgentName: "Overflow desk",
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

  it("does not clear a newer key-wide failure from an older successful target", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        ...selected(),
        {
          platformAgentId: "agent_retell_voice_2",
          platformAgentName: "Overflow desk",
        },
      ],
      now: SETUP_TIME,
    });
    const failed = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    const staleSuccess = await claimDueRetellMonitoringAgent({
      now: SETUP_TIME,
    });
    expect(failed).toBeDefined();
    expect(staleSuccess).toBeDefined();
    if (failed === undefined || staleSuccess === undefined) return;

    const retryAt = new Date(SETUP_TIME.getTime() + 60_000);
    await failRetellMonitoringTarget(failed.auth, failed, {
      kind: "rate_limited",
      retryAt,
      now: SETUP_TIME,
    });

    expect(
      await recoverRetellMonitoringSetup(
        staleSuccess.auth,
        staleSuccess,
        SETUP_TIME,
      ),
    ).toEqual({ recovered: false });
    expect((await listMonitoringSetups(staleSuccess.auth))[0]).toMatchObject({
      healthState: "rate_limited",
      blockedUntil: retryAt,
      consecutiveFailures: 1,
    });
  });

  it("keeps invalid credentials until the customer changes the key", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        ...selected(),
        {
          platformAgentId: "agent_retell_voice_2",
          platformAgentName: "Overflow desk",
        },
      ],
      now: SETUP_TIME,
    });
    const invalid = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    const lateUnavailable = await claimDueRetellMonitoringAgent({
      now: SETUP_TIME,
    });
    expect(invalid).toBeDefined();
    expect(lateUnavailable).toBeDefined();
    if (invalid === undefined || lateUnavailable === undefined) return;

    const invalidUntil = new Date("9999-12-31T23:59:59.999Z");
    await failRetellMonitoringTarget(invalid.auth, invalid, {
      kind: "invalid_credential",
      retryAt: invalidUntil,
      now: SETUP_TIME,
    });
    await failRetellMonitoringTarget(
      lateUnavailable.auth,
      lateUnavailable,
      {
        kind: "provider_unavailable",
        retryAt: new Date(SETUP_TIME.getTime() + 30_000),
        now: new Date(SETUP_TIME.getTime() + 1_000),
      },
    );

    expect((await listMonitoringSetups(invalid.auth))[0]).toMatchObject({
      healthState: "invalid_credential",
      blockedUntil: invalidUntil,
    });
  });

  it("does not shorten a newer Retry-After gate", async () => {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        ...selected(),
        {
          platformAgentId: "agent_retell_voice_2",
          platformAgentName: "Overflow desk",
        },
      ],
      now: SETUP_TIME,
    });
    const rateLimited = await claimDueRetellMonitoringAgent({
      now: SETUP_TIME,
    });
    const lateUnavailable = await claimDueRetellMonitoringAgent({
      now: SETUP_TIME,
    });
    expect(rateLimited).toBeDefined();
    expect(lateUnavailable).toBeDefined();
    if (rateLimited === undefined || lateUnavailable === undefined) return;

    const retryAt = new Date(SETUP_TIME.getTime() + 120_000);
    await failRetellMonitoringTarget(rateLimited.auth, rateLimited, {
      kind: "rate_limited",
      retryAt,
      now: SETUP_TIME,
    });
    await failRetellMonitoringTarget(
      lateUnavailable.auth,
      lateUnavailable,
      {
        kind: "provider_unavailable",
        retryAt: new Date(SETUP_TIME.getTime() + 30_000),
        now: new Date(SETUP_TIME.getTime() + 1_000),
      },
    );

    expect((await listMonitoringSetups(rateLimited.auth))[0]).toMatchObject({
      healthState: "rate_limited",
      blockedUntil: retryAt,
    });
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
        platformAgentId: "agent_retell_voice_1",
        platformAgentName: "Front desk",
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
    expect(
      await claimRetellIngestionFailureReplay(
        at(acmeOther, ada),
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

  it("ignores a replay failure that used the previous key", async () => {
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
      providerCallId: "call_rotated_replay",
      errorKind: "provider_call_not_found",
      now: SETUP_TIME,
    });
    const failureId = (await listMonitoringSetups(auth))[0]?.agents[0]
      ?.failures[0]?.id;
    expect(failureId).toBeDefined();
    if (failureId === undefined) return;
    const stale = await claimRetellIngestionFailureReplay(auth, failureId, {
      now: SETUP_TIME,
    });
    expect(stale.kind).toBe("claimed");
    if (stale.kind !== "claimed") return;

    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: ROTATED_RETELL_KEY,
      agents: selected(),
      now: rotatedAt,
    });
    expect(
      await failRetellIngestionFailureReplay(
        stale.target.auth,
        stale.target,
        {
          kind: "invalid_credential",
          retryAt: new Date("9999-12-31T23:59:59.999Z"),
          now: rotatedAt,
        },
      ),
    ).toMatchObject({ recorded: false, changed: false, failures: 0 });
    expect((await listMonitoringSetups(auth))[0]).toMatchObject({
      healthState: "healthy",
      blockedUntil: null,
      consecutiveFailures: 0,
    });
    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: rotatedAt,
      }),
    ).toMatchObject({
      kind: "claimed",
      target: { apiKey: ROTATED_RETELL_KEY },
    });
  });

  it("does not replace a failed call reason with an old-key replay result", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const poll = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(poll).toBeDefined();
    if (poll === undefined) return;
    await recordRetellIngestionFailure(poll.auth, poll, {
      providerCallId: "call_old_key_replay_result",
      errorKind: "provider_call_not_found",
      now: SETUP_TIME,
    });
    const failureId = (await listMonitoringSetups(auth))[0]?.agents[0]
      ?.failures[0]?.id;
    expect(failureId).toBeDefined();
    if (failureId === undefined) return;
    const stale = await claimRetellIngestionFailureReplay(auth, failureId, {
      now: SETUP_TIME,
    });
    expect(stale.kind).toBe("claimed");
    if (stale.kind !== "claimed") return;

    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: ROTATED_RETELL_KEY,
      agents: selected(),
      now: rotatedAt,
    });
    expect(
      await releaseRetellIngestionFailureReplay(
        stale.target.auth,
        stale.target,
        { errorKind: "platform_agent_mismatch", now: rotatedAt },
      ),
    ).toBe(false);
    expect((await listMonitoringSetups(auth))[0]?.agents[0]?.failures).toEqual([
      expect.objectContaining({
        id: failureId,
        errorKind: "provider_call_not_found",
      }),
    ]);
    expect(
      await claimRetellIngestionFailureReplay(auth, failureId, {
        now: rotatedAt,
      }),
    ).toMatchObject({
      kind: "claimed",
      target: { apiKey: ROTATED_RETELL_KEY },
    });
  });

  it("does not weaken an invalid-key gate with a late replay failure", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const target = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(target).toBeDefined();
    if (target === undefined) return;
    for (const providerCallId of ["call_invalid_key", "call_late_failure"]) {
      await recordRetellIngestionFailure(target.auth, target, {
        providerCallId,
        errorKind: "provider_call_not_found",
        now: SETUP_TIME,
      });
    }
    const failures = (await listMonitoringSetups(auth))[0]?.agents[0]
      ?.failures;
    expect(failures).toHaveLength(2);
    if (failures === undefined) return;
    const invalid = await claimRetellIngestionFailureReplay(
      auth,
      failures[0]!.id,
      { now: SETUP_TIME },
    );
    const late = await claimRetellIngestionFailureReplay(
      auth,
      failures[1]!.id,
      { now: SETUP_TIME },
    );
    expect(invalid.kind).toBe("claimed");
    expect(late.kind).toBe("claimed");
    if (invalid.kind !== "claimed" || late.kind !== "claimed") return;

    const invalidUntil = new Date("9999-12-31T23:59:59.999Z");
    await failRetellIngestionFailureReplay(
      invalid.target.auth,
      invalid.target,
      {
        kind: "invalid_credential",
        retryAt: invalidUntil,
        now: SETUP_TIME,
      },
    );
    await failRetellIngestionFailureReplay(late.target.auth, late.target, {
      kind: "provider_unavailable",
      retryAt: new Date(SETUP_TIME.getTime() + 30_000),
      now: new Date(SETUP_TIME.getTime() + 1_000),
    });

    expect((await listMonitoringSetups(auth))[0]).toMatchObject({
      healthState: "invalid_credential",
      blockedUntil: invalidUntil,
    });
  });

  it("does not deadlock a replay failure behind setup work", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const poll = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(poll).toBeDefined();
    if (poll === undefined) return;
    await recordRetellIngestionFailure(poll.auth, poll, {
      providerCallId: "call_lock_order",
      errorKind: "provider_call_not_found",
      now: SETUP_TIME,
    });
    const failureId = (await listMonitoringSetups(auth))[0]?.agents[0]
      ?.failures[0]?.id;
    expect(failureId).toBeDefined();
    if (failureId === undefined) return;
    const replay = await claimRetellIngestionFailureReplay(auth, failureId, {
      now: SETUP_TIME,
    });
    expect(replay.kind).toBe("claimed");
    if (replay.kind !== "claimed") return;

    const setupWork = await openSingleConnection(database.url);
    let setupWorkOpen = true;
    try {
      await setupWork.sql("begin");
      await setupWork.sql(
        "select id from monitoring_setup where id = $1 for update",
        [replay.target.setupId],
      );

      const recording = failRetellIngestionFailureReplay(
        replay.target.auth,
        replay.target,
        {
          kind: "provider_unavailable",
          retryAt: new Date(SETUP_TIME.getTime() + 30_000),
          now: SETUP_TIME,
        },
      ).then(
        (value) => ({ kind: "recorded" as const, value }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );

      let waitingForSetup = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await database.sql<{ waiting: boolean }>(`
          select exists (
            select 1 from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%monitoring_setup%'
          ) as waiting
        `);
        waitingForSetup = activity.rows[0]?.waiting ?? false;
        if (waitingForSetup) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waitingForSetup).toBe(true);

      // Setup removal and reconfiguration take this child row after the setup
      // row. This must be available while the replay failure waits above.
      await setupWork.sql(
        "select id from retell_ingestion_failure where id = $1 for update",
        [failureId],
      );
      await setupWork.sql("commit");
      setupWorkOpen = false;

      const outcome = await recording;
      expect(outcome.kind).toBe("recorded");
      if (outcome.kind === "recorded") {
        expect(outcome.value).toMatchObject({ recorded: true, failures: 1 });
      }
    } finally {
      if (setupWorkOpen) await setupWork.sql("rollback").catch(() => undefined);
      await setupWork.close();
    }
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
      platformAgentId: "agent_retell_voice_1",
      platformAgentName: "Front desk",
      platformAgentVersion: "7",
      payload: '{"call_id":"call_one_visible_trace"}',
      endedAt: SETUP_TIME,
    };

    expect(await claimProductionTrace(auth, offer)).toMatchObject(offer);
    expect(await claimProductionTrace(auth, offer)).toBeUndefined();
  });

  it("finishes a production trace only inside the acting project", async () => {
    const offer = {
      traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      providerCallId: "call_project_owned_trace",
      platformAgentId: "agent_retell_voice_1",
      payload: '{"call_id":"call_project_owned_trace"}',
      endedAt: SETUP_TIME,
    };
    expect(await claimProductionTrace(at(acme, ada), offer)).toBeDefined();

    await finishProductionTrace(at(acmeOther, ada), {
      traceId: offer.traceId,
      degraded: false,
    });
    let stored = await database.sql<{ status: string }>(
      "select status from production_trace_claim where trace_id = $1",
      [offer.traceId],
    );
    expect(stored.rows[0]?.status).toBe("claimed");

    await finishProductionTrace(at(acme, ada), {
      traceId: offer.traceId,
      degraded: false,
    });
    stored = await database.sql<{ status: string }>(
      "select status from production_trace_claim where trace_id = $1",
      [offer.traceId],
    );
    expect(stored.rows[0]?.status).toBe("written");
  });

  it("restores selected-agent progress when a stale trace claim replays", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const replayedAt = new Date("2026-08-20T08:03:00.000Z");

    await recordProductionEvidenceReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: selected()[0].platformAgentId,
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
