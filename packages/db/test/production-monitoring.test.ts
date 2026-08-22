import {
  checkpointRetellMonitoringPage,
  claimDueRetellMonitoringAgent,
  configureLiveKitMonitoring,
  configureRetellMonitoring,
  deleteRetellCallRetry,
  dueRetellCallRetries,
  failRetellMonitoringTarget,
  finishRetellMonitoringScan,
  listMonitoringSetups,
  NotPermittedError,
  recordProductionEvidenceReceived,
  recordRetellCallAttempt,
  recoverRetellMonitoringSetup,
  releaseRetellMonitoringLease,
  renewRetellMonitoringLease,
  sweepExpiredRetellCallMarkers,
  transientRetellCallState,
  yieldRetellMonitoringLease,
  type AuthContext,
  type RetellMonitoringTarget,
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
    "truncate retell_call_retry, retell_monitored_agent, " +
      "monitoring_setup cascade",
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
            platform_agent_id, platform_agent_name, next_poll_at)
         values ($1, $2, $3, $4, 'agent_cross_tenant', 'Cross tenant', $5)`,
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

  it("voids an in-flight lease when the agent is selected again", async () => {
    const auth = at(acme, ada);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    const active = await claimDueRetellMonitoringAgent({ now: SETUP_TIME });
    expect(active).toBeDefined();
    if (active === undefined) return;

    // Selecting the agent again arms a new fixed 30-day window. A lease taken
    // over the old one names a scan that no longer exists, so it has to stop
    // being a lease: were it allowed to finish, its own completion would
    // overwrite the window the customer just asked for and the re-import would
    // silently never happen.
    const savedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await configureRetellMonitoring(auth, {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: savedAt,
    });

    expect(
      await renewRetellMonitoringLease(active.auth, active, { now: savedAt }),
    ).toBe(false);
    expect(
      await finishRetellMonitoringScan(active.auth, active, { now: savedAt }),
    ).toBe(false);

    const rearmed = await claimDueRetellMonitoringAgent({ now: savedAt });
    expect(rearmed).toMatchObject({
      scanKind: "historical_import",
      scanThrough: savedAt,
      paginationKey: null,
      importGeneration: 2,
    });
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

describe("the bounded Retell call budget", () => {
  const BACKOFF = [30_000, 60_000, 120_000];

  async function leased(now = SETUP_TIME): Promise<RetellMonitoringTarget> {
    const target = await claimDueRetellMonitoringAgent({ now });
    if (target === undefined) throw new Error("no due selected agent");
    return target;
  }

  async function configured(now = SETUP_TIME): Promise<RetellMonitoringTarget> {
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now,
    });
    return leased(now);
  }

  /** Spend the whole budget for one call, returning when it is dropped. */
  async function spendBudget(
    target: RetellMonitoringTarget,
    providerCallId: string,
    from = SETUP_TIME,
  ): Promise<Date> {
    let at = from;
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      await recordRetellCallAttempt(target.auth, target, {
        providerCallId,
        errorKind: "provider_call_not_found",
        retryBackoffMilliseconds: BACKOFF,
        now: at,
      });
    }
    return at;
  }

  it("counts one budget across attempts and refuses a fourth automatic retry", async () => {
    const target = await configured();
    let at = SETUP_TIME;
    const seen: number[] = [];
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      const outcome = await recordRetellCallAttempt(target.auth, target, {
        providerCallId: "call_never_arrives",
        errorKind: "provider_call_not_found",
        retryBackoffMilliseconds: BACKOFF,
        now: at,
      });
      if (!outcome.recorded) throw new Error("the attempt was not recorded");
      seen.push(outcome.attempts);
      expect(outcome.dropped).toBe(outcome.attempts === 4);
    }
    expect(seen).toEqual([1, 2, 3, 4]);

    // The marker cannot schedule a fifth attempt, whoever asks.
    const due = await dueRetellCallRetries(target.auth, {
      monitoredAgentId: target.monitoredAgentId,
      importGeneration: target.importGeneration,
      now: new Date(at.getTime() + 60 * 60_000),
      limit: 25,
    });
    expect(due).toEqual([]);

    const rows = await database.sql<{
      attempts: number;
      next_attempt_at: Date | null;
      expires_at: Date | null;
    }>(
      "select attempts, next_attempt_at, expires_at from retell_call_retry",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.attempts).toBe(4);
    expect(rows.rows[0]?.next_attempt_at).toBeNull();
    expect(rows.rows[0]?.expires_at).not.toBeNull();
  });

  it("answers one batched lookup for a whole page and keeps a marker out of it after expiry", async () => {
    const target = await configured();
    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    const droppedAt = await spendBudget(target, "call_dropped");

    const asked = ["call_retrying", "call_dropped", "call_never_seen"];
    const found = await transientRetellCallState(target.auth, {
      monitoredAgentId: target.monitoredAgentId,
      providerCallIds: asked,
      importGeneration: target.importGeneration,
      now: droppedAt,
    });
    expect([...found.keys()].sort()).toEqual(["call_dropped", "call_retrying"]);
    expect(found.get("call_retrying")?.nextAttemptAt).not.toBeNull();
    expect(found.get("call_dropped")?.nextAttemptAt).toBeNull();
    expect(found.get("call_dropped")?.expiresAt).not.toBeNull();

    // A marker applies for as long as an overlap could still list the call,
    // and then stops applying whether or not anybody has deleted it.
    const wellPast = new Date(droppedAt.getTime() + 60 * 60_000);
    const later = await transientRetellCallState(target.auth, {
      monitoredAgentId: target.monitoredAgentId,
      providerCallIds: asked,
      importGeneration: target.importGeneration,
      now: wellPast,
    });
    expect([...later.keys()]).toEqual(["call_retrying"]);

    expect(
      await sweepExpiredRetellCallMarkers(target.auth, {
        monitoredAgentId: target.monitoredAgentId,
        now: wellPast,
      }),
    ).toBe(1);
    const remaining = await database.sql<{ provider_call_id: string }>(
      "select provider_call_id from retell_call_retry",
    );
    expect(remaining.rows.map((row) => row.provider_call_id)).toEqual([
      "call_retrying",
    ]);
  });

  it("gives a new explicit import its own budget for a call an earlier scan dropped", async () => {
    const first = await configured();
    const droppedAt = await spendBudget(first, "call_dropped");

    // Selecting the agent again is the explicit deep-import action, and it is
    // a new observation of the provider's history.
    const reselectedAt = new Date(droppedAt.getTime() + 60_000);
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: reselectedAt,
    });
    const second = await leased(reselectedAt);
    expect(second.importGeneration).toBe(first.importGeneration + 1);
    expect(second.scanKind).toBe("historical_import");

    const found = await transientRetellCallState(second.auth, {
      monitoredAgentId: second.monitoredAgentId,
      providerCallIds: ["call_dropped"],
      importGeneration: second.importGeneration,
      now: reselectedAt,
    });
    expect(found.size).toBe(0);

    // And a failure under the new generation starts at one rather than five.
    const outcome = await recordRetellCallAttempt(second.auth, second, {
      providerCallId: "call_dropped",
      errorKind: "provider_call_not_found",
      retryBackoffMilliseconds: BACKOFF,
      now: reselectedAt,
    });
    expect(outcome).toMatchObject({ attempts: 1, dropped: false });
  });

  /**
   * A row the new generation cannot see is a row nothing will ever read,
   * sweep or delete — and the two existence checks that drive `degraded` and
   * the poller's retry pass ask about the agent rather than the generation, so
   * leaving one would pin a working agent degraded for work nobody owes.
   */
  it("takes the previous window's transient rows with it when the agent is selected again", async () => {
    const first = await configured();
    await recordRetellCallAttempt(first.auth, first, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    await spendBudget(first, "call_dropped");
    const before = await database.sql<{ count: string }>(
      "select count(*)::text as count from retell_call_retry",
    );
    expect(before.rows[0]?.count).toBe("2");

    const reselectedAt = new Date(SETUP_TIME.getTime() + 60_000);
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: reselectedAt,
    });

    const after = await database.sql<{ count: string }>(
      "select count(*)::text as count from retell_call_retry",
    );
    expect(after.rows[0]?.count).toBe("0");

    // And the agent is not left owing anything: nothing to poll for, and
    // nothing keeping it degraded.
    const second = await leased(reselectedAt);
    expect(second.hasTransientCallState).toBe(false);
  });

  it("says a selected agent is degraded while a retry is in flight and not after it", async () => {
    const target = await configured();
    const state = async (): Promise<string | undefined> => {
      const rows = await database.sql<{ state: string }>(
        "select state from retell_monitored_agent",
      );
      return rows.rows[0]?.state;
    };

    await finishRetellMonitoringScan(target.auth, target, { now: SETUP_TIME });
    expect(await state()).toBe("active");

    const polling = await leased(new Date(SETUP_TIME.getTime() + 60_000));
    await recordRetellCallAttempt(polling.auth, polling, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    expect(await state()).toBe("degraded");

    await deleteRetellCallRetry(polling.auth, polling, {
      providerCallId: "call_retrying",
      now: SETUP_TIME,
    });
    expect(await state()).toBe("active");
  });

  it("clears the one budget two selected agents share for a call they both meet", async () => {
    // Two selected agents in one project, so a provider call that turns out to
    // belong to one of them is a `platform_agent_mismatch` the other can also
    // meet — and the row is unique per project and call, so there is one of it.
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: [
        {
          platformAgentId: "agent_retell_voice_1",
          platformAgentName: "Front desk",
        },
        {
          platformAgentId: "agent_retell_voice_2",
          platformAgentName: "Back office",
        },
      ],
      now: SETUP_TIME,
    });
    const first = await leased(SETUP_TIME);
    const second = await leased(SETUP_TIME);
    expect(second.monitoredAgentId).not.toBe(first.monitoredAgentId);

    // The second attempt lands on the first's row and counts against one budget
    // rather than starting a second, taking ownership with it.
    const a = await recordRetellCallAttempt(first.auth, first, {
      providerCallId: "call_both_meet",
      errorKind: "platform_agent_mismatch",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    const b = await recordRetellCallAttempt(second.auth, second, {
      providerCallId: "call_both_meet",
      errorKind: "platform_agent_mismatch",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    expect(a).toMatchObject({ attempts: 1 });
    expect(b).toMatchObject({ attempts: 2 });

    const rows = await database.sql<{
      retell_monitored_agent_id: string;
      attempts: number;
    }>("select retell_monitored_agent_id, attempts from retell_call_retry");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.attempts).toBe(2);
    expect(rows.rows[0]?.retell_monitored_agent_id).toBe(second.monitoredAgentId);

    // The first agent makes the call durable and clears it, even though the row
    // is now the second's: the delete scopes by project and call, the same pair
    // the finder used, so ownership cannot strand the one shared row.
    await deleteRetellCallRetry(first.auth, first, {
      providerCallId: "call_both_meet",
      now: SETUP_TIME,
    });
    const after = await database.sql<{ count: string }>(
      "select count(*)::text as count from retell_call_retry",
    );
    expect(after.rows[0]?.count).toBe("0");
  });

  it("tells the claim whether an agent owes anything, so an empty poll asks nothing", async () => {
    const target = await configured();
    expect(target.hasTransientCallState).toBe(false);

    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    await yieldRetellMonitoringLease(target.auth, target, {
      retryAt: SETUP_TIME,
      now: SETUP_TIME,
    });

    const owing = await leased(SETUP_TIME);
    expect(owing.hasTransientCallState).toBe(true);
  });

  it("keeps one project's transient call state out of another's page", async () => {
    const target = await configured();
    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });

    const elsewhere = await transientRetellCallState(at(globex, gene), {
      monitoredAgentId: target.monitoredAgentId,
      providerCallIds: ["call_retrying"],
      importGeneration: target.importGeneration,
      now: SETUP_TIME,
    });
    expect(elsewhere.size).toBe(0);
  });
});

describe("the regular window's floor", () => {
  it("holds the first window at the floor and returns the overlap after it", async () => {
    const cutover = new Date("2026-08-20T12:00:00.000Z");
    await configureRetellMonitoring(at(acme, ada), {
      apiKey: RETELL_KEY,
      agents: selected(),
      now: SETUP_TIME,
    });
    // The cutover's own statement, said here the way the migration says it.
    await database.sql(
      "update retell_monitored_agent set scan_kind = null, scan_from = null, " +
        "scan_through = null, pagination_key = null, pagination_trail = '[]', " +
        "lease_owner = null, lease_expires_at = null, completed_through = $1, " +
        "next_poll_at = $1, regular_floor_at = $1",
      [cutover],
    );

    const first = await claimDueRetellMonitoringAgent({ now: cutover });
    expect(first).toMatchObject({ scanKind: "regular", scanFrom: cutover });
    if (first === undefined) return;

    // Without the floor this window would start five minutes before the
    // cutover and re-import evidence the release deliberately removed.
    expect(first.scanFrom.getTime()).toBe(cutover.getTime());
    expect(
      await finishRetellMonitoringScan(first.auth, first, {
        now: cutover,
        pollMilliseconds: 1,
      }),
    ).toBe(true);

    const nextAt = new Date(cutover.getTime() + 60_000);
    const second = await claimDueRetellMonitoringAgent({ now: nextAt });
    expect(second?.scanFrom.getTime()).toBe(
      first.scanThrough.getTime() - 5 * 60_000,
    );
  });
});
