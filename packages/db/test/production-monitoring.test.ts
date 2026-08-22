import {
  claimDueMonitoringPull,
  claimMonitoringFailureReplay,
  claimProductionTrace,
  createAgent,
  disablePullProductionCalls,
  enablePullProductionCalls,
  failMonitoringPull,
  finishMonitoringScan,
  finishProductionTrace,
  listMonitoringFailures,
  NotPermittedError,
  productionCallIsAccountedFor,
  readAgentPullState,
  recordMonitoringFailure,
  recordPulledCallReceived,
  resolveMonitoringFailureReplay,
  sweepStaleProductionClaims,
  type AuthContext,
  type MonitoringPullTarget,
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
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Monitoring, agent-shaped.
 *
 * There is no setup object to test any more: an agent binds to its platform,
 * holds that platform's sealed monitoring key, and one switch turns polling on.
 * What is worth proving is exactly what the schema now makes impossible — a
 * switch that cannot be kept, two agents polling one platform agent, a key
 * without the platform it opens — and that the receipt book and the
 * poison-call record still do their jobs around the change.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const acmeOther = { organization: acme.organization, project: newId("prj") };
const ada = newId("usr");
const RETELL_KEY = "key_live_retell_monitoring_secret_QRST";
const SETUP_TIME = new Date("2026-08-20T08:00:00.000Z");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;

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

/** A bare roster entry: no platform, no key, no switch. */
async function agentNamed(
  name: string,
  customer: typeof acme = acme,
): Promise<string> {
  const created = await createAgent(at(customer, ada), { name });
  return created.id;
}

async function pulling(
  name: string,
  platformAgentId: string,
  customer: typeof acme = acme,
): Promise<string> {
  const agentId = await agentNamed(name, customer);
  await enablePullProductionCalls(at(customer, ada), {
    agentId,
    agentPlatform: "retell",
    platformAgentId,
    apiKey: RETELL_KEY,
    now: SETUP_TIME,
  });
  return agentId;
}

function offer(providerCallId: string) {
  return {
    traceId: newId("ptc").slice(-26).toLowerCase(),
    providerCallId,
    platformAgentId: "agent_retell_voice_1",
    payload: JSON.stringify({ call_id: providerCallId }),
    endedAt: SETUP_TIME,
  };
}

beforeAll(async () => {
  database = await createConnectedDatabase("production_monitoring");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acmeOther.project, slug: "other" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

beforeEach(async () => {
  await database.sql(
    "truncate monitoring_failure, production_trace_claim, " +
      "monitoring_state, connection, agent cascade",
  );
});

afterAll(async () => {
  await database.drop();
});

describe("the pull switch", () => {
  it("seals the key on the agent and opens the notebook on a 30-day import", async () => {
    const agentId = await agentNamed("Front desk");

    const state = await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    });

    expect(state).toMatchObject({
      agentId,
      pullProductionCalls: true,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      // The hint, never the key.
      monitoringApiKeyHint: "QRST",
      scanKind: "historical_import",
    });

    const { rows } = await database.sql<{
      scan_from: Date;
      scan_through: Date;
      next_poll_at: Date;
    }>("select scan_from, scan_through, next_poll_at from monitoring_state");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scan_through.toISOString()).toBe(SETUP_TIME.toISOString());
    expect(rows[0]?.scan_from.getTime()).toBe(SETUP_TIME.getTime() - THIRTY_DAYS);
  });

  it("never selects the key itself, only the hint", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const state = await readAgentPullState(at(acme, ada), agentId);
    expect(state).not.toHaveProperty("monitoringApiKey");
    expect(state?.monitoringApiKeyHint).toBe("QRST");

    const { rows } = await database.sql<{ monitoring_api_key: string }>(
      "select monitoring_api_key from agent",
    );
    // Sealed, and not the plaintext anybody typed.
    expect(rows[0]?.monitoring_api_key).toMatch(/^v1\./);
    expect(rows[0]?.monitoring_api_key).not.toContain(RETELL_KEY);
  });

  it("leaves the notebook standing when the switch goes off, and stops the poller", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");

    expect(await disablePullProductionCalls(at(acme, ada), agentId)).toBe(true);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*)::text as count from monitoring_state",
    );
    expect(rows[0]?.count).toBe("1");
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();

    const state = await readAgentPullState(at(acme, ada), agentId);
    expect(state?.pullProductionCalls).toBe(false);
  });

  it("resumes the same notebook when the switch comes back on", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const [before] = (
      await database.sql<{ id: string }>("select id from monitoring_state")
    ).rows;

    await disablePullProductionCalls(at(acme, ada), agentId);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    });

    const { rows } = await database.sql<{ id: string }>(
      "select id from monitoring_state",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(before?.id);
  });

  it("is not a viewer's to turn on", async () => {
    const agentId = await agentNamed("Front desk");
    await expect(
      enablePullProductionCalls(at(acme, ada, "viewer"), {
        agentId,
        agentPlatform: "retell",
        platformAgentId: "agent_retell_voice_1",
        apiKey: RETELL_KEY,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe("what the agent row refuses", () => {
  it("will not hold the switch on without a platform, an id and a key", async () => {
    const agentId = await agentNamed("Front desk");
    const refused = await database
      .sql(`update agent set pull_production_calls = true where id = '${agentId}'`)
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.checkViolation);
  });

  it("will not hold a key without the platform it opens", async () => {
    const agentId = await agentNamed("Front desk");
    const refused = await database
      .sql(
        `update agent set monitoring_api_key = 'v1.a.b.c', ` +
          `monitoring_api_key_hint = 'QRST' where id = '${agentId}'`,
      )
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.checkViolation);
  });

  it("will not hold a key without its hint, or a hint without its key", async () => {
    const agentId = await agentNamed("Front desk");
    const refused = await database
      .sql(
        `update agent set agent_platform = 'retell', ` +
          `monitoring_api_key = 'v1.a.b.c' where id = '${agentId}'`,
      )
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.checkViolation);
  });

  it("refuses a second switched-on agent naming one platform agent", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const second = await agentNamed("Front desk copy");

    const refused = await enablePullProductionCalls(at(acme, ada), {
      agentId: second,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    }).catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.uniqueViolation);
  });

  it("allows a switched-off duplicate, because two off rows poll nothing", async () => {
    const first = await pulling("Front desk", "agent_retell_voice_1");
    await disablePullProductionCalls(at(acme, ada), first);

    const second = await agentNamed("Front desk copy");
    await expect(
      enablePullProductionCalls(at(acme, ada), {
        agentId: second,
        agentPlatform: "retell",
        platformAgentId: "agent_retell_voice_1",
        apiKey: RETELL_KEY,
        now: SETUP_TIME,
      }),
    ).resolves.toMatchObject({ pullProductionCalls: true });
  });

  it("scopes the rule to one project, so two projects may watch one platform agent", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    await expect(
      pulling("Front desk", "agent_retell_voice_1", acmeOther),
    ).resolves.toBeTruthy();
  });
});

describe("claiming a due agent", () => {
  it("hands the poller the agent's own key and its fixed window", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");

    const claimed = await claimDueMonitoringPull({ now: SETUP_TIME });
    expect(claimed).toMatchObject({
      agentId,
      platformAgentId: "agent_retell_voice_1",
      platformAgentName: "Front desk",
      apiKey: RETELL_KEY,
      scanKind: "historical_import",
      consecutiveFailures: 0,
    });
    expect(claimed?.auth).toMatchObject({
      organizationId: acme.organization,
      projectId: acme.project,
      via: "monitoring",
    });
  });

  it("leases the row, so a second poller finds nothing", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    await claimDueMonitoringPull({ now: SETUP_TIME });
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();
  });

  it("backs off this agent alone and says so", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = (await claimDueMonitoringPull({
      now: SETUP_TIME,
    })) as MonitoringPullTarget;

    const retryAt = new Date(SETUP_TIME.getTime() + 60_000);
    expect(
      await failMonitoringPull(target.auth, target, {
        kind: "rate_limited",
        retryAt,
        now: SETUP_TIME,
      }),
    ).toEqual({ changed: true, failures: 1 });

    const { rows } = await database.sql<{
      consecutive_failures: number;
      next_poll_at: Date;
      lease_owner: string | null;
    }>(
      "select consecutive_failures, next_poll_at, lease_owner from monitoring_state",
    );
    expect(rows[0]?.consecutive_failures).toBe(1);
    expect(rows[0]?.lease_owner).toBeNull();
    expect(rows[0]?.next_poll_at.toISOString()).toBe(retryAt.toISOString());
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();
  });

  it("clears the retry clock when a scan finishes, and stamps what it covered", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = (await claimDueMonitoringPull({
      now: SETUP_TIME,
    })) as MonitoringPullTarget;

    expect(await finishMonitoringScan(target.auth, target, { now: SETUP_TIME }))
      .toBe(true);

    const { rows } = await database.sql<{
      completed_through: Date;
      scan_kind: string | null;
      consecutive_failures: number;
    }>(
      "select completed_through, scan_kind, consecutive_failures from monitoring_state",
    );
    expect(rows[0]?.scan_kind).toBeNull();
    expect(rows[0]?.consecutive_failures).toBe(0);
    expect(rows[0]?.completed_through.toISOString()).toBe(
      target.scanThrough.toISOString(),
    );
  });

  it("stamps the notebook as pulled calls arrive", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const target = (await claimDueMonitoringPull({
      now: SETUP_TIME,
    })) as MonitoringPullTarget;

    const received = new Date(SETUP_TIME.getTime() + 1_000);
    await recordPulledCallReceived(target.auth, target, received);

    const state = await readAgentPullState(at(acme, ada), agentId);
    expect(state?.lastReceivedAt?.toISOString()).toBe(received.toISOString());
  });
});

describe("the poison-call record", () => {
  async function failed(): Promise<{
    readonly agentId: string;
    readonly target: MonitoringPullTarget;
  }> {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const target = (await claimDueMonitoringPull({
      now: SETUP_TIME,
    })) as MonitoringPullTarget;
    await recordMonitoringFailure(target.auth, target, {
      providerCallId: "call_broken_1",
      errorKind: "unreadable_transcript",
      now: SETUP_TIME,
    });
    return { agentId, target };
  }

  it("belongs to the agent and counts its attempts", async () => {
    const { agentId, target } = await failed();

    const [failure] = await listMonitoringFailures(at(acme, ada), agentId);
    expect(failure).toMatchObject({
      providerCallId: "call_broken_1",
      errorKind: "unreadable_transcript",
      attempts: 1,
      status: "open",
    });

    await recordMonitoringFailure(target.auth, target, {
      providerCallId: "call_broken_1",
      errorKind: "unreadable_transcript",
      now: SETUP_TIME,
    });
    const [again] = await listMonitoringFailures(at(acme, ada), agentId);
    expect(again?.attempts).toBe(2);
    expect(again?.id).toBe(failure?.id);
  });

  it("is unique on the project and the provider's call id", async () => {
    const { agentId } = await failed();
    const other = await agentNamed("Second desk");
    const refused = await database
      .sql(
        `insert into monitoring_failure (id, agent_id, organization_id, ` +
          `project_id, provider_call_id, error_kind, last_attempt_at) values ` +
          `('${newId("mnf")}', '${other}', '${acme.organization}', ` +
          `'${acme.project}', 'call_broken_1', 'unreadable_transcript', now())`,
      )
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.uniqueViolation);
    expect(await listMonitoringFailures(at(acme, ada), agentId)).toHaveLength(1);
  });

  it("keeps the cursor honest: an open failure accounts for its call", async () => {
    await failed();
    expect(
      await productionCallIsAccountedFor(at(acme, ada), "call_broken_1"),
    ).toBe(true);
    expect(
      await productionCallIsAccountedFor(at(acme, ada), "call_never_seen"),
    ).toBe(false);
  });

  it("leases one replay at a time and resolves it once", async () => {
    const { agentId } = await failed();
    const [failure] = await listMonitoringFailures(at(acme, ada), agentId);

    const claim = await claimMonitoringFailureReplay(
      at(acme, ada),
      failure?.id ?? "",
      { now: SETUP_TIME },
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    expect(claim.target).toMatchObject({
      agentId,
      providerCallId: "call_broken_1",
      apiKey: RETELL_KEY,
    });

    const second = await claimMonitoringFailureReplay(
      at(acme, ada),
      failure?.id ?? "",
      { now: SETUP_TIME },
    );
    expect(second).toMatchObject({ kind: "busy", reason: "replay_in_progress" });

    expect(
      await resolveMonitoringFailureReplay(claim.target.auth, claim.target, {
        now: SETUP_TIME,
      }),
    ).toEqual({ resolved: true, agentRecovered: true });
    expect(await listMonitoringFailures(at(acme, ada), agentId)).toHaveLength(0);
  });

  it("answers an unknown failure the same way it answers another tenant's", async () => {
    await failed();
    expect(
      await claimMonitoringFailureReplay(at(acme, ada), newId("mnf")),
    ).toEqual({ kind: "not_found" });
    expect(
      await claimMonitoringFailureReplay(at(acmeOther, ada), newId("mnf")),
    ).toEqual({ kind: "not_found" });
  });
});

describe("the receipt book", () => {
  it("is owned once per project and provider call, and survives the redesign", async () => {
    const auth = at(acme, ada);
    const claimed = await claimProductionTrace(auth, offer("call_1"));
    expect(claimed).toMatchObject({ providerCallId: "call_1", degraded: false });
    // A second claim on the same call is nobody's.
    expect(await claimProductionTrace(auth, offer("call_1"))).toBeUndefined();

    // It names no agent, no key and no setup, which is why nothing above could
    // have lost or duplicated a stored conversation.
    const { rows } = await database.sql<{ column_name: string }>(
      "select column_name from information_schema.columns " +
        "where table_name = 'production_trace_claim'",
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).not.toContain("agent_id");
    expect(columns).not.toContain("monitoring_setup_id");
    expect(columns).not.toContain("retell_monitored_agent_id");
  });

  it("marks the write as finished, and a sweep re-takes what a crash left", async () => {
    const auth = at(acme, ada);
    const claimed = await claimProductionTrace(auth, offer("call_2"));
    await finishProductionTrace(auth, {
      traceId: claimed?.traceId ?? "",
      degraded: false,
    });
    expect(
      await sweepStaleProductionClaims({
        now: new Date(SETUP_TIME.getTime() + 10 * 60_000),
      }),
    ).toHaveLength(0);

    await claimProductionTrace(auth, offer("call_3"));
    const swept = await sweepStaleProductionClaims({
      now: new Date(Date.now() + 10 * 60_000),
    });
    expect(swept.map((one) => one.providerCallId)).toEqual(["call_3"]);
  });
});

describe("the dropped tables", () => {
  it("do not exist", async () => {
    const { rows } = await database.sql<{ table_name: string }>(
      "select table_name from information_schema.tables " +
        "where table_schema = 'public'",
    );
    const tables = rows.map((row) => row.table_name);
    expect(tables).not.toContain("monitoring_setup");
    expect(tables).not.toContain("retell_monitored_agent");
    expect(tables).not.toContain("retell_ingestion_failure");
    expect(tables).toContain("monitoring_state");
    expect(tables).toContain("monitoring_failure");
  });
});
