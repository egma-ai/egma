import {
  checkpointMonitoringPage,
  claimDueMonitoringAgent,
  createAgent,
  deleteProductionCallFailure,
  dueProductionCallRetries,
  failMonitoringTarget,
  finishMonitoringScan,
  NotPermittedError,
  recordProductionCallAttempt,
  recordProductionEvidenceReceived,
  renewMonitoringLease,
  startPullingProductionCalls,
  stopPullingProductionCalls,
  sweepExpiredProductionCallMarkers,
  transientProductionCallState,
  UnprocessableInputError,
  yieldMonitoringLease,
  type AuthContext,
  type MonitoringTarget,
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
 * Monitoring, as the agent owns it.
 *
 * Everything here runs against a real Postgres through the module's own
 * exports: the switch, the machine notebook it opens, the lease the poller
 * takes, and the bounded budget a broken call spends. What is deliberately
 * absent is a health surface — there is no state to assert because none is
 * stored.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const acmeOther = { organization: acme.organization, project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");
const RETELL_KEY = "key_live_retell_monitoring_secret_QRST";
const ROTATED_RETELL_KEY = "key_live_retell_monitoring_rotated_WXYZ";
const PLATFORM_AGENT = "agent_retell_voice_1";
const SETUP_TIME = new Date("2026-08-20T08:00:00.000Z");
const HISTORY_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

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

/** One registered agent, with nothing about monitoring settled yet. */
async function anAgent(
  auth: AuthContext,
  name: string,
): Promise<{ readonly id: string }> {
  return createAgent(auth, { name });
}

async function switchedOn(
  auth: AuthContext,
  agentId: string,
  options: {
    readonly platformAgentId?: string;
    readonly apiKey?: string;
    readonly now?: Date;
  } = {},
) {
  return startPullingProductionCalls(auth, {
    agentId,
    agentPlatform: "retell",
    platformAgentId: options.platformAgentId ?? PLATFORM_AGENT,
    apiKey: options.apiKey ?? RETELL_KEY,
    now: options.now ?? SETUP_TIME,
  });
}

type StateRow = {
  scan_kind: string | null;
  scan_from: Date | null;
  scan_through: Date | null;
  pagination_key: string | null;
  pagination_trail: string;
  completed_through: Date | null;
  next_poll_at: Date;
  import_generation: number;
  lease_owner: string | null;
  consecutive_failures: number;
  last_received_at: Date | null;
};

async function stateOf(agentId: string): Promise<StateRow | undefined> {
  const { rows } = await database.sql<StateRow>(
    "select * from monitoring_state where agent_id = $1",
    [agentId],
  );
  return rows[0];
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
    "truncate monitoring_failure, monitoring_state, connection, agent cascade",
  );
});

afterAll(async () => {
  await database.drop();
});

describe("the pull switch", () => {
  it("binds the agent, seals its key, and opens a fixed 30-day import", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");

    const held = await switchedOn(at(acme, ada), agent.id);

    expect(held).toMatchObject({
      agentId: agent.id,
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      monitoringApiKeyHint: "QRST",
      pullProductionCalls: true,
    });

    const state = await stateOf(agent.id);
    expect(state).toMatchObject({
      scan_kind: "historical_import",
      scan_from: new Date(SETUP_TIME.getTime() - HISTORY_MILLISECONDS),
      scan_through: SETUP_TIME,
      pagination_key: null,
      next_poll_at: SETUP_TIME,
      import_generation: 1,
      lease_owner: null,
      consecutive_failures: 0,
    });
  });

  it("never lets a read carry the sealed key, only its hint", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    const held = await switchedOn(at(acme, ada), agent.id);

    expect(JSON.stringify(held)).not.toContain(RETELL_KEY);

    const { rows } = await database.sql<{ monitoring_api_key: string }>(
      "select monitoring_api_key from agent where id = $1",
      [agent.id],
    );
    expect(rows[0]?.monitoring_api_key).toMatch(/^v1\./);
    expect(rows[0]?.monitoring_api_key).not.toContain(RETELL_KEY);
  });

  it("re-arms the window on a second switch-on and takes the old budget with it", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const first = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (first === undefined) throw new Error("no due agent");
    await recordProductionCallAttempt(first.auth, first, {
      providerCallId: "call_from_the_old_window",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });

    const later = new Date(SETUP_TIME.getTime() + 60 * 60_000);
    await switchedOn(at(acme, ada), agent.id, { now: later });

    const state = await stateOf(agent.id);
    expect(state).toMatchObject({
      scan_kind: "historical_import",
      scan_from: new Date(later.getTime() - HISTORY_MILLISECONDS),
      scan_through: later,
      pagination_key: null,
      pagination_trail: "[]",
      // The lease over the window it replaces is void: whoever holds it is
      // paging a scan that no longer exists.
      lease_owner: null,
      import_generation: 2,
      next_poll_at: later,
    });

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from monitoring_failure where agent_id = $1",
      [agent.id],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("keeps the cursor when the switch goes off, and stops the polling", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");
    await checkpointMonitoringPage(target.auth, target, {
      paginationKey: "page-2",
      seenPaginationKeys: ["page-2"],
    });
    await yieldMonitoringLease(target.auth, target, {
      retryAt: SETUP_TIME,
      now: SETUP_TIME,
    });

    const stopped = await stopPullingProductionCalls(at(acme, ada), agent.id);
    expect(stopped).toMatchObject({
      pullProductionCalls: false,
      // The binding and the key stay, so turning it back on asks for neither.
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      monitoringApiKeyHint: "QRST",
    });

    expect(await claimDueMonitoringAgent({ now: SETUP_TIME })).toBeUndefined();
    expect((await stateOf(agent.id))?.pagination_key).toBe("page-2");
  });

  it("refuses a second switched-on agent for one platform agent, and allows a switched-off one", async () => {
    const first = await anAgent(at(acme, ada), "Front desk");
    const second = await anAgent(at(acme, ada), "Front desk copy");
    await switchedOn(at(acme, ada), first.id);

    await expect(switchedOn(at(acme, ada), second.id)).rejects.toBeInstanceOf(
      UnprocessableInputError,
    );

    // Switched off, the same platform agent is nobody's contested claim.
    await stopPullingProductionCalls(at(acme, ada), first.id);
    const moved = await switchedOn(at(acme, ada), second.id);
    expect(moved?.pullProductionCalls).toBe(true);
  });

  it("refuses a viewer before it stores the key", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");

    await expect(
      switchedOn(at(acme, ada, "viewer"), agent.id),
    ).rejects.toBeInstanceOf(NotPermittedError);

    const { rows } = await database.sql<{ monitoring_api_key: string | null }>(
      "select monitoring_api_key from agent where id = $1",
      [agent.id],
    );
    expect(rows[0]?.monitoring_api_key).toBeNull();
  });

  it("answers nothing for an agent this project cannot see", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");

    expect(await switchedOn(at(acmeOther, ada), agent.id)).toBeUndefined();
    expect(
      await stopPullingProductionCalls(at(globex, gene), agent.id),
    ).toBeUndefined();
  });
});

describe("what the agent row refuses outright", () => {
  async function anUnboundAgent(): Promise<string> {
    const agent = await anAgent(at(acme, ada), `Agent ${newId("agt")}`);
    return agent.id;
  }

  it("will not hold the switch on without a platform, an id and a key", async () => {
    const id = await anUnboundAgent();
    const refused = await database
      .sql("update agent set pull_production_calls = true where id = $1", [id])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect((refused as { constraint?: string }).constraint).toBe(
      "agent_pull_needs_binding",
    );
  });

  it("will not hold a key without its hint, or a hint without its key", async () => {
    const id = await anUnboundAgent();
    const refused = await database
      .sql(
        "update agent set agent_platform = 'retell', monitoring_api_key = 'v1.x' where id = $1",
        [id],
      )
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect((refused as { constraint?: string }).constraint).toBe(
      "agent_monitoring_key_hint_agrees",
    );
  });

  it("will not hold a key with no platform to spend it on", async () => {
    const id = await anUnboundAgent();
    const refused = await database
      .sql(
        "update agent set monitoring_api_key = 'v1.x', monitoring_api_key_hint = 'QRST' where id = $1",
        [id],
      )
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect((refused as { constraint?: string }).constraint).toBe(
      "agent_monitoring_key_needs_platform",
    );
  });

  it("refuses the duplicate at the index, not merely at the door", async () => {
    const first = await anAgent(at(acme, ada), "First");
    const second = await anAgent(at(acme, ada), "Second");
    await switchedOn(at(acme, ada), first.id);
    await switchedOn(at(acme, ada), second.id, {
      platformAgentId: "agent_retell_voice_2",
    });

    const refused = await database
      .sql(
        "update agent set platform_agent_id = $2 where id = $1",
        [second.id, PLATFORM_AGENT],
      )
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.uniqueViolation);
  });
});

describe("claiming one due agent", () => {
  it("lets only one replica hold the lease", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);

    const [first, second] = await Promise.all([
      claimDueMonitoringAgent({ now: SETUP_TIME }),
      claimDueMonitoringAgent({ now: SETUP_TIME }),
    ]);

    const claimed = [first, second].filter((one) => one !== undefined);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.apiKey).toBe(RETELL_KEY);
    expect(claimed[0]?.platformAgentId).toBe(PLATFORM_AGENT);
    expect(claimed[0]?.agentPlatform).toBe("retell");
  });

  it("does not claim an agent whose switch has gone off", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    await stopPullingProductionCalls(at(acme, ada), agent.id);

    expect(await claimDueMonitoringAgent({ now: SETUP_TIME })).toBeUndefined();
  });

  it("opens a regular window five minutes behind the last completed bound", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const importing = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (importing === undefined) throw new Error("no due agent");
    await finishMonitoringScan(importing.auth, importing, { now: SETUP_TIME });

    const later = new Date(SETUP_TIME.getTime() + 60_000);
    const regular = await claimDueMonitoringAgent({ now: later });
    expect(regular).toMatchObject({
      scanKind: "regular",
      scanFrom: new Date(SETUP_TIME.getTime() - 5 * 60_000),
      scanThrough: later,
    });
  });

  it("keeps the cursor and the fixed window when bounded work yields", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");

    await checkpointMonitoringPage(target.auth, target, {
      paginationKey: "page-2",
      seenPaginationKeys: ["page-2"],
    });
    const retryAt = new Date(SETUP_TIME.getTime() + 1_000);
    expect(
      await yieldMonitoringLease(target.auth, target, {
        retryAt,
        now: SETUP_TIME,
      }),
    ).toBe(true);

    const resumed = await claimDueMonitoringAgent({ now: retryAt });
    expect(resumed).toMatchObject({
      scanKind: "historical_import",
      scanFrom: target.scanFrom,
      scanThrough: target.scanThrough,
      paginationKey: "page-2",
      seenPaginationKeys: ["page-2"],
    });
  });

  it("voids an in-flight lease when the switch is armed again", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");

    const later = new Date(SETUP_TIME.getTime() + 60_000);
    await switchedOn(at(acme, ada), agent.id, { now: later });

    expect(
      await renewMonitoringLease(target.auth, target, { now: later }),
    ).toBe(false);
    expect(
      await checkpointMonitoringPage(target.auth, target, {
        paginationKey: "page-2",
        seenPaginationKeys: ["page-2"],
      }),
    ).toBe(false);
    expect(
      await finishMonitoringScan(target.auth, target, { now: later }),
    ).toBe(false);
  });
});

describe("per-agent backoff", () => {
  it("counts the failure on this agent's own clock and pushes its next poll out", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");
    expect(target.consecutiveFailures).toBe(0);

    const retryAt = new Date(SETUP_TIME.getTime() + 30_000);
    const first = await failMonitoringTarget(target.auth, target, {
      errorKind: "rate_limited",
      retryAt,
      now: SETUP_TIME,
    });
    expect(first).toEqual({ recorded: true, failures: 1 });

    const state = await stateOf(agent.id);
    expect(state?.next_poll_at).toEqual(retryAt);
    expect(state?.lease_owner).toBeNull();

    // Not yet due, then due, and the retry clock travels with the claim.
    expect(await claimDueMonitoringAgent({ now: SETUP_TIME })).toBeUndefined();
    const again = await claimDueMonitoringAgent({ now: retryAt });
    expect(again?.consecutiveFailures).toBe(1);
  });

  it("clears the retry clock when a scan completes", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");
    const retryAt = new Date(SETUP_TIME.getTime() + 30_000);
    await failMonitoringTarget(target.auth, target, {
      errorKind: "provider_unavailable",
      retryAt,
      now: SETUP_TIME,
    });

    const recovered = await claimDueMonitoringAgent({ now: retryAt });
    if (recovered === undefined) throw new Error("no due agent");
    expect(
      await finishMonitoringScan(recovered.auth, recovered, { now: retryAt }),
    ).toBe(true);

    const state = await stateOf(agent.id);
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.completed_through).toEqual(recovered.scanThrough);
    expect(state?.scan_kind).toBeNull();
  });

  it("backs off each of two agents sharing one dead key independently", async () => {
    const first = await anAgent(at(acme, ada), "Front desk");
    const second = await anAgent(at(acme, ada), "Night line");
    await switchedOn(at(acme, ada), first.id);
    await switchedOn(at(acme, ada), second.id, {
      platformAgentId: "agent_retell_voice_2",
    });

    const one = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (one === undefined) throw new Error("no due agent");
    await failMonitoringTarget(one.auth, one, {
      errorKind: "invalid_credential",
      retryAt: new Date(SETUP_TIME.getTime() + 3_600_000),
      now: SETUP_TIME,
    });

    // The other agent is not gated by its sibling's failure: there is no
    // account-wide gate to be gated by.
    const other = await claimDueMonitoringAgent({ now: SETUP_TIME });
    expect(other?.agentId).not.toBe(one.agentId);
    expect(other?.consecutiveFailures).toBe(0);
  });

  it("re-arms rather than counting a failure from a lease that used the old key", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");

    const later = new Date(SETUP_TIME.getTime() + 60_000);
    await switchedOn(at(acme, ada), agent.id, {
      apiKey: ROTATED_RETELL_KEY,
      now: later,
    });
    // The re-arm voided the lease, so the stale turn reaches nothing at all.
    expect(
      await failMonitoringTarget(target.auth, target, {
        errorKind: "invalid_credential",
        retryAt: new Date(later.getTime() + 3_600_000),
        now: later,
      }),
    ).toEqual({ recorded: false, failures: 0 });

    const state = await stateOf(agent.id);
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.next_poll_at).toEqual(later);
  });

  it("ignores a failure from a target that has lost its lease", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);
    const target = await claimDueMonitoringAgent({ now: SETUP_TIME });
    if (target === undefined) throw new Error("no due agent");
    await yieldMonitoringLease(target.auth, target, {
      retryAt: SETUP_TIME,
      now: SETUP_TIME,
    });

    expect(
      await failMonitoringTarget(target.auth, target, {
        errorKind: "provider_unavailable",
        retryAt: new Date(SETUP_TIME.getTime() + 30_000),
        now: SETUP_TIME,
      }),
    ).toEqual({ recorded: false, failures: 0 });
    expect((await stateOf(agent.id))?.consecutive_failures).toBe(0);
  });
});

describe("last heard from", () => {
  it("stamps the agent's own notebook and never winds it backwards", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);

    const newest = new Date("2026-08-20T09:00:00.000Z");
    await recordProductionEvidenceReceived(at(acme, ada), {
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      receivedAt: newest,
    });
    expect((await stateOf(agent.id))?.last_received_at).toEqual(newest);

    // A replay carrying an older instant is still happening now, and must not
    // answer "last production conversation" with an hour ago.
    await recordProductionEvidenceReceived(at(acme, ada), {
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      receivedAt: new Date("2026-08-20T08:30:00.000Z"),
    });
    expect((await stateOf(agent.id))?.last_received_at).toEqual(newest);
  });

  it("writes nothing for a pushing agent, which has no notebook at all", async () => {
    const agent = await anAgent(at(acme, ada), "LiveKit desk");
    await database.sql(
      "update agent set agent_platform = 'livekit_agents', platform_agent_id = $2 where id = $1",
      [agent.id, "livekit_worker_1"],
    );

    await recordProductionEvidenceReceived(at(acme, ada), {
      agentPlatform: "livekit_agents",
      platformAgentId: "livekit_worker_1",
      receivedAt: new Date("2026-08-20T09:00:00.000Z"),
    });

    expect(await stateOf(agent.id)).toBeUndefined();
  });

  it("moves nothing outside the acting project", async () => {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id);

    await recordProductionEvidenceReceived(at(globex, gene), {
      agentPlatform: "retell",
      platformAgentId: PLATFORM_AGENT,
      receivedAt: new Date("2026-08-20T09:00:00.000Z"),
    });
    expect((await stateOf(agent.id))?.last_received_at).toBeNull();
  });
});

describe("the bounded production call budget", () => {
  const BACKOFF = [30_000, 60_000, 120_000];
  /** Three regular overlaps, which is how long a recent-drop marker applies. */
  const MARKER_MILLISECONDS = 15 * 60_000;

  async function polling(now = SETUP_TIME): Promise<MonitoringTarget> {
    const agent = await anAgent(at(acme, ada), "Front desk");
    await switchedOn(at(acme, ada), agent.id, { now });
    const target = await claimDueMonitoringAgent({ now });
    if (target === undefined) throw new Error("no due agent");
    return target;
  }

  /** Spend the whole budget for one call, returning when it is dropped. */
  async function spendBudget(
    target: MonitoringTarget,
    providerCallId: string,
    from = SETUP_TIME,
  ): Promise<Date> {
    let at = from;
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      await recordProductionCallAttempt(target.auth, target, {
        providerCallId,
        errorKind: "provider_call_not_found",
        retryBackoffMilliseconds: BACKOFF,
        now: at,
      });
    }
    return at;
  }

  it("counts one budget across attempts and refuses a fourth automatic retry", async () => {
    const target = await polling();

    const outcomes = [];
    let at = SETUP_TIME;
    for (const wait of [0, ...BACKOFF]) {
      at = new Date(at.getTime() + wait);
      outcomes.push(
        await recordProductionCallAttempt(target.auth, target, {
          providerCallId: "call_poison",
          errorKind: "provider_call_not_found",
          retryBackoffMilliseconds: BACKOFF,
          now: at,
        }),
      );
    }

    expect(outcomes).toEqual([
      { recorded: true, attempts: 1, dropped: false },
      { recorded: true, attempts: 2, dropped: false },
      { recorded: true, attempts: 3, dropped: false },
      { recorded: true, attempts: 4, dropped: true },
    ]);

    // The marker schedules nothing, so the call is not offered again.
    expect(
      await dueProductionCallRetries(target.auth, {
        agentId: target.agentId,
        importGeneration: target.importGeneration,
        now: new Date(at.getTime() + 60 * 60_000),
        limit: 10,
      }),
    ).toEqual([]);
  });

  it("answers one batched lookup for a page and drops the marker after it expires", async () => {
    const target = await polling();
    const droppedAt = await spendBudget(target, "call_dropped");
    await recordProductionCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: droppedAt,
    });

    const held = await transientProductionCallState(target.auth, {
      agentId: target.agentId,
      providerCallIds: ["call_dropped", "call_retrying", "call_new"],
      importGeneration: target.importGeneration,
      now: droppedAt,
    });
    expect([...held.keys()].sort()).toEqual(["call_dropped", "call_retrying"]);
    expect(held.get("call_dropped")?.nextAttemptAt).toBeNull();
    expect(held.get("call_dropped")?.expiresAt).toBeInstanceOf(Date);

    const outlived = new Date(droppedAt.getTime() + MARKER_MILLISECONDS + 1);
    const afterExpiry = await transientProductionCallState(target.auth, {
      agentId: target.agentId,
      providerCallIds: ["call_dropped", "call_retrying"],
      importGeneration: target.importGeneration,
      now: outlived,
    });
    expect([...afterExpiry.keys()]).toEqual(["call_retrying"]);

    expect(
      await sweepExpiredProductionCallMarkers(target.auth, {
        agentId: target.agentId,
        now: outlived,
      }),
    ).toBe(1);
  });

  it("gives a new import its own budget for a call an earlier scan dropped", async () => {
    const target = await polling();
    const droppedAt = await spendBudget(target, "call_dropped");

    const later = new Date(droppedAt.getTime() + 60_000);
    await switchedOn(at(acme, ada), target.agentId, { now: later });
    const armed = await claimDueMonitoringAgent({ now: later });
    if (armed === undefined) throw new Error("no due agent");
    expect(armed.importGeneration).toBe(target.importGeneration + 1);

    const held = await transientProductionCallState(armed.auth, {
      agentId: armed.agentId,
      providerCallIds: ["call_dropped"],
      importGeneration: armed.importGeneration,
      now: later,
    });
    expect(held.size).toBe(0);

    const fresh = await recordProductionCallAttempt(armed.auth, armed, {
      providerCallId: "call_dropped",
      errorKind: "provider_call_not_found",
      retryBackoffMilliseconds: BACKOFF,
      now: later,
    });
    expect(fresh).toEqual({ recorded: true, attempts: 1, dropped: false });
  });

  it("forgets a call's budget once its evidence is durable", async () => {
    const target = await polling();
    await recordProductionCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });

    await deleteProductionCallFailure(target.auth, {
      providerCallId: "call_retrying",
    });

    const held = await transientProductionCallState(target.auth, {
      agentId: target.agentId,
      providerCallIds: ["call_retrying"],
      importGeneration: target.importGeneration,
      now: SETUP_TIME,
    });
    expect(held.size).toBe(0);
  });

  it("tells the claim whether an agent owes anything, so an empty poll asks nothing", async () => {
    const target = await polling();
    expect(target.hasTransientCallState).toBe(false);

    await recordProductionCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });
    await yieldMonitoringLease(target.auth, target, {
      retryAt: SETUP_TIME,
      now: SETUP_TIME,
    });

    const owing = await claimDueMonitoringAgent({ now: SETUP_TIME });
    expect(owing?.hasTransientCallState).toBe(true);
  });

  it("keeps one project's transient call state out of another's page", async () => {
    const target = await polling();
    await recordProductionCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "provider_call_refused",
      retryBackoffMilliseconds: BACKOFF,
      now: SETUP_TIME,
    });

    const elsewhere = await transientProductionCallState(at(globex, gene), {
      agentId: target.agentId,
      providerCallIds: ["call_retrying"],
      importGeneration: target.importGeneration,
      now: SETUP_TIME,
    });
    expect(elsewhere.size).toBe(0);
  });
});
