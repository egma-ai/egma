import {
  checkpointMonitoringPage,
  claimDueMonitoringPull,
  createAgent,
  deleteRetellCallRetry,
  disablePullProductionCalls,
  dueRetellCallRetries,
  enablePullProductionCalls,
  failMonitoringPull,
  finishMonitoringScan,
  getAgent,
  MOST_RETELL_CALL_ATTEMPTS,
  readAgentPullState,
  recordPulledCallReceived,
  recordRetellCallAttempt,
  registerAgentPullingProductionCalls,
  releaseMonitoringLease,
  renewMonitoringLease,
  sweepExpiredRetellCallMarkers,
  transientRetellCallState,
  yieldMonitoringLease,
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
 * Monitoring, agent-shaped, on the durable ingestion boundary.
 *
 * There is no setup object and no health surface to test. An agent binds to
 * its platform, holds that platform's sealed monitoring key, and one switch
 * turns polling on. What is worth proving is what the schema now makes
 * impossible — two agents polling one platform agent, a switch that cannot be
 * kept — and what the poller's notebook promises around it: one clock, a park
 * a lesser failure cannot shorten, a resume that does no backfill, and a
 * bounded retry budget for a call that would not come.
 *
 * A call that lands leaves no row here at all. Its evidence is in the object
 * store and then the trace store, where committed span identity is the
 * exactly-once rule (ADR-0014).
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const acmeOther = { organization: acme.organization, project: newId("prj") };
const ada = newId("usr");
const RETELL_KEY = "key_live_retell_monitoring_secret_QRST";
const ROTATED_KEY = "key_live_retell_monitoring_rotated_WXYZ";
const SETUP_TIME = new Date("2026-08-20T08:00:00.000Z");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60_000;
const FOREVER = new Date("9999-12-31T23:59:59.999Z");

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
  const created = await createAgent(at(customer, ada), { agentPlatform: "retell", name });
  return created.id;
}

async function pulling(
  name: string,
  platformAgentId: string,
  customer: typeof acme = acme,
  now: Date = SETUP_TIME,
): Promise<string> {
  const agentId = await agentNamed(name, customer);
  await enablePullProductionCalls(at(customer, ada), {
    agentId,
    agentPlatform: "retell",
    platformAgentId,
    apiKey: RETELL_KEY,
    now,
  });
  return agentId;
}

/** The notebook as the database holds it. No access function publishes it. */
async function notebook(agentId: string) {
  const { rows } = await database.sql<{
    scan_kind: string | null;
    scan_from: Date | null;
    scan_through: Date | null;
    completed_through: Date | null;
    regular_floor_at: Date | null;
    import_generation: number;
    next_poll_at: Date;
    consecutive_failures: number;
    last_error_kind: string | null;
    last_received_at: Date | null;
  }>(`select scan_kind, scan_from, scan_through, completed_through,
             regular_floor_at, import_generation, next_poll_at,
             consecutive_failures, last_error_kind, last_received_at
        from monitoring_state where agent_id = '${agentId}'`);
  return rows[0];
}

async function claimed(now = SETUP_TIME): Promise<MonitoringPullTarget> {
  const target = await claimDueMonitoringPull({ now });
  expect(target).toBeDefined();
  if (target === undefined) throw new Error("nothing was due");
  return target;
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
    "truncate retell_call_retry, monitoring_state, connection, agent cascade",
  );
});

afterAll(async () => {
  await database.drop();
});

describe("the pull switch", () => {
  /**
   * **Registering and switching on are one write.**
   *
   * Watching an unregistered platform agent means registering it, and the two
   * halves cannot be separate commits: the switch's uniqueness index is what
   * refuses a second agent on one platform agent, and a create that had
   * already committed would leave that agent in the roster bound to nothing.
   */
  it("registers an unknown platform agent and starts it in one write", async () => {
    const state = await registerAgentPullingProductionCalls(at(acme, ada), {
      name: "Registered by monitoring",
      agentPlatform: "retell",
      platformAgentId: "agent_retell_registered_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    });

    expect(state).toMatchObject({
      pullProductionCalls: true,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_registered_1",
      monitoringApiKeyHint: RETELL_KEY.slice(-4),
      scanKind: "historical_import",
      lastReceivedAt: null,
    });
    const opened = await notebook(state.agentId);
    expect(opened?.scan_from).toEqual(
      new Date(SETUP_TIME.getTime() - THIRTY_DAYS),
    );
    expect(opened?.scan_through).toEqual(SETUP_TIME);
    expect(opened?.import_generation).toBe(1);
  });

  /** The sealed key never leaves the row, and the hint is what a person reads. */
  it("seals the key on the agent and publishes only its hint", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const { rows } = await database.sql<{
      monitoring_api_key: string;
      monitoring_api_key_hint: string;
    }>(
      `select monitoring_api_key, monitoring_api_key_hint
         from agent where id = '${agentId}'`,
    );
    expect(rows[0]?.monitoring_api_key).not.toContain(RETELL_KEY);
    expect(rows[0]?.monitoring_api_key_hint).toBe(RETELL_KEY.slice(-4));
    expect(await readAgentPullState(at(acme, ada), agentId)).not.toHaveProperty(
      "monitoringApiKey",
    );
  });

  /**
   * Two Egma agents polling one Retell agent would double the API load and
   * contest attribution. The database refuses it rather than the code avoiding
   * it, because a read that checked first would race the very next request.
   */
  it("refuses a second switched-on agent for one platform agent", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const second = await agentNamed("Front desk copy");

    const refusal = await enablePullProductionCalls(at(acme, ada), {
      agentId: second,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    }).catch((error: unknown) => error);

    expect(errorCodeOf(refusal)).toBe(POSTGRES_ERROR.uniqueViolation);
  });

  /** Two switched-off rows may lawfully name one platform agent. */
  it("lets a stopped agent share a platform agent with the one now watching", async () => {
    const first = await pulling("Front desk", "agent_retell_voice_1");
    expect(await disablePullProductionCalls(at(acme, ada), first)).toBe(true);

    const second = await agentNamed("Front desk again");
    const state = await enablePullProductionCalls(at(acme, ada), {
      agentId: second,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: SETUP_TIME,
    });
    expect(state.pullProductionCalls).toBe(true);
  });

  /** Stop keeps everything stored, including the notebook and the key. */
  it("keeps the binding, the key and the notebook when the switch goes off", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    await disablePullProductionCalls(at(acme, ada), agentId);

    const state = await readAgentPullState(at(acme, ada), agentId);
    expect(state).toMatchObject({
      pullProductionCalls: false,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      monitoringApiKeyHint: RETELL_KEY.slice(-4),
    });
    expect(await notebook(agentId)).toBeDefined();
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();
  });

  /**
   * **Pause and resume do no backfill.**
   *
   * Turning the switch on again is a new observation from that moment — a
   * fresh generation, a floor at the switch, and no second 30-day import. The
   * deep import happens once, on an agent's first ever switch-on.
   */
  it("resumes from now rather than backfilling what it missed", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    await disablePullProductionCalls(at(acme, ada), agentId);

    const resumedAt = new Date(SETUP_TIME.getTime() + 6 * 60 * 60_000);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: resumedAt,
    });

    const resumed = await notebook(agentId);
    expect(resumed?.scan_kind).toBeNull();
    expect(resumed?.regular_floor_at).toEqual(resumedAt);
    expect(resumed?.completed_through).toEqual(resumedAt);
    expect(resumed?.import_generation).toBe(2);

    // And the window the poller then fixes starts at the floor, never five
    // minutes behind it into the hours the switch was off.
    const target = await claimed(resumedAt);
    expect(target.scanKind).toBe("regular");
    expect(target.scanFrom).toEqual(resumedAt);
  });

  /**
   * **A turn already in flight may not outlive the switch-on.**
   *
   * Turning the switch on opens a new observation, so a lease taken over the
   * window before it names a scan that no longer exists. Were that turn
   * allowed to finish, its own completion would drag `completed_through` back
   * to its older bound and delete the floor the switch just wrote — and the
   * next regular window would reach into the hours pull was off, which is the
   * backfill this branch exists to refuse.
   */
  it("voids an in-flight lease when the switch is turned on again", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const inFlight = await claimed();

    const resumedAt = new Date(SETUP_TIME.getTime() + 20_000);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: resumedAt,
    });

    // Every write the old turn still tries is refused by its own owner check.
    expect(
      await renewMonitoringLease(inFlight.auth, inFlight, { now: resumedAt }),
    ).toBe(false);
    expect(
      await finishMonitoringScan(inFlight.auth, inFlight, { now: resumedAt }),
    ).toBe(false);

    // And the row is free at once, rather than waiting out a lease nobody owns.
    const resumed = await claimed(resumedAt);
    expect(resumed.importGeneration).toBe(2);
    expect(resumed.scanKind).toBe("regular");
    expect(resumed.scanFrom).toEqual(resumedAt);
  });
});

describe("the poller's notebook", () => {
  /**
   * Two API replicas poll on the same cadence, so the claim is raced rather
   * than taken in turn. `for update skip locked` is what makes the loser see
   * nothing instead of queueing behind the winner.
   */
  it("lets only one replica claim one due agent", async () => {
    await pulling("Front desk", "agent_retell_voice_1");

    const [first, second] = await Promise.all([
      claimDueMonitoringPull({ now: SETUP_TIME }),
      claimDueMonitoringPull({ now: SETUP_TIME }),
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

  it("claims one due agent, holds its window, and finishes it", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();

    expect(target).toMatchObject({
      agentId,
      platformAgentId: "agent_retell_voice_1",
      platformAgentName: "Front desk",
      apiKey: RETELL_KEY,
      scanKind: "historical_import",
      hasTransientCallState: false,
      consecutiveFailures: 0,
    });
    // Leased, so nothing else may take it.
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();

    expect(
      await checkpointMonitoringPage(target.auth, target, {
        paginationKey: "page-2",
        seenPaginationKeys: ["page-1"],
      }),
    ).toBe(true);
    expect(
      await renewMonitoringLease(target.auth, target, { now: SETUP_TIME }),
    ).toBe(true);
    expect(await finishMonitoringScan(target.auth, target)).toBe(true);

    const finished = await notebook(agentId);
    expect(finished?.scan_kind).toBeNull();
    expect(finished?.completed_through).toEqual(target.scanThrough);
    expect(finished?.regular_floor_at).toBeNull();
    expect(finished?.consecutive_failures).toBe(0);
  });

  /** The overlap is the only late-arrival net there is: no daily re-walk. */
  it("reaches five minutes back from the last completed bound and no further", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const first = await claimed();
    await finishMonitoringScan(first.auth, first, { now: SETUP_TIME });

    const later = new Date(SETUP_TIME.getTime() + 60_000);
    const regular = await claimed(later);
    expect(regular.scanKind).toBe("regular");
    expect(regular.scanFrom).toEqual(
      new Date(first.scanThrough.getTime() - FIVE_MINUTES),
    );
    expect(regular.scanThrough).toEqual(later);
  });

  /** A yield is a pause inside one scan: the window and the cursor stay put. */
  it("yields bounded work without losing the window it is inside", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    await checkpointMonitoringPage(target.auth, target, {
      paginationKey: "page-2",
      seenPaginationKeys: ["page-1"],
    });

    const retryAt = new Date(SETUP_TIME.getTime() + 30_000);
    expect(await yieldMonitoringLease(target.auth, target, { retryAt })).toBe(
      true,
    );

    const resumed = await claimed(retryAt);
    expect(resumed.scanKind).toBe("historical_import");
    expect(resumed.scanFrom).toEqual(target.scanFrom);
    expect(resumed.scanThrough).toEqual(target.scanThrough);
    expect(resumed.paginationKey).toBe("page-2");
    expect(resumed.seenPaginationKeys).toEqual(["page-1"]);
  });
});

describe("the cool-down", () => {
  /**
   * **A refused key parks until the customer acts.**
   *
   * A rate limit arriving after Retell called the key wrong may not bring the
   * next poll forward — the answer about the key has not changed.
   */
  it("parks a refused key and refuses to let a lesser failure shorten it", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const refused = await claimed();
    await failMonitoringPull(refused.auth, refused, {
      kind: "invalid_credential",
      retryAt: FOREVER,
      now: SETUP_TIME,
    });
    expect(await notebook(agentId)).toMatchObject({
      next_poll_at: FOREVER,
      last_error_kind: "invalid_credential",
      consecutive_failures: 1,
    });
    expect(await claimDueMonitoringPull({ now: SETUP_TIME })).toBeUndefined();

    // A later, lesser verdict about the same key changes nothing: the park it
    // would write is shorter than the one already stored, and the refusal it
    // would record is not the one that matters. Woken by hand, because a
    // parked agent is exactly what the claim refuses to hand out.
    await database.sql(
      `update monitoring_state set next_poll_at = '${SETUP_TIME.toISOString()}'
         where agent_id = '${agentId}'`,
    );
    const again = await claimed();
    const later = new Date(SETUP_TIME.getTime() + 1_000);
    const rateLimitedUntil = new Date(SETUP_TIME.getTime() + 30_000);
    await failMonitoringPull(again.auth, again, {
      kind: "rate_limited",
      retryAt: rateLimitedUntil,
      now: later,
    });
    const after = await notebook(agentId);
    expect(after?.last_error_kind).toBe("invalid_credential");
    expect(after?.next_poll_at).not.toEqual(rateLimitedUntil);
    expect(after?.consecutive_failures).toBe(2);
  });

  /** Turning the switch on again is the customer acting, so the park ends. */
  it("ends the park when the customer offers the key again", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const refused = await claimed();
    await failMonitoringPull(refused.auth, refused, {
      kind: "invalid_credential",
      retryAt: FOREVER,
      now: SETUP_TIME,
    });

    const rotatedAt = new Date(SETUP_TIME.getTime() + 60_000);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: ROTATED_KEY,
      now: rotatedAt,
    });

    expect(await notebook(agentId)).toMatchObject({
      next_poll_at: rotatedAt,
      last_error_kind: null,
      consecutive_failures: 0,
    });
    expect((await claimed(rotatedAt)).apiKey).toBe(ROTATED_KEY);
  });

  /**
   * The backoff is per agent, because a sealed key on one agent is
   * unrecognizable as the same key sealed on another. Each poller finds out on
   * its own, and no gate is account-wide.
   */
  it("keeps one agent's refusal off another agent sharing the same key", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const other = await pulling("Overflow desk", "agent_retell_voice_2");

    const first = await claimed();
    await failMonitoringPull(first.auth, first, {
      kind: "invalid_credential",
      retryAt: FOREVER,
      now: SETUP_TIME,
    });

    const second = await claimed();
    expect(second.agentId).toBe(other);
    expect(second.consecutiveFailures).toBe(0);
  });

  /** A verdict about a key nobody holds any more is dropped, not counted. */
  it("drops a verdict from a poll whose key was rotated under it", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const stale = await claimed();
    const rotatedAt = new Date(SETUP_TIME.getTime() + 1_000);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: ROTATED_KEY,
      now: rotatedAt,
    });

    await failMonitoringPull(stale.auth, stale, {
      kind: "invalid_credential",
      retryAt: FOREVER,
      now: rotatedAt,
    });
    expect(await notebook(agentId)).toMatchObject({
      last_error_kind: null,
      consecutive_failures: 0,
    });
  });

  /** A call-only fault is not a refusal, so the ladder does not climb. */
  it("releases a lease after a call-only fault without counting a refusal", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    const retryAt = new Date(SETUP_TIME.getTime() + 30_000);

    await releaseMonitoringLease(target.auth, target, {
      retryAt,
      errorKind: "contract_breach",
    });

    expect(await notebook(agentId)).toMatchObject({
      next_poll_at: retryAt,
      consecutive_failures: 0,
      last_error_kind: "contract_breach",
    });
  });
});

describe('"last heard from"', () => {
  it("moves forward for the pulled agent and never backward", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const auth = at(acme, ada);
    const late = new Date(SETUP_TIME.getTime() + 60_000);

    await recordPulledCallReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      receivedAt: late,
    });
    await recordPulledCallReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      receivedAt: new Date(SETUP_TIME.getTime() - 60 * 60_000),
    });

    expect((await notebook(agentId))?.last_received_at).toEqual(late);
    expect((await readAgentPullState(auth, agentId))?.lastReceivedAt).toEqual(
      late,
    );
  });

  /** Push writes nothing down: a platform agent nobody pulls stamps nothing. */
  it("stamps nothing for a platform agent this project does not pull", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    await recordPulledCallReceived(at(acme, ada), {
      agentPlatform: "livekit",
      platformAgentId: "some-livekit-room",
      receivedAt: new Date(SETUP_TIME.getTime() + 60_000),
    });
    expect((await notebook(agentId))?.last_received_at).toBeNull();
  });

  /** One project's evidence never moves another project's notebook. */
  it("stays inside the acting project", async () => {
    const mine = await pulling("Front desk", "agent_retell_voice_1");
    const theirs = await pulling(
      "Their front desk",
      "agent_retell_voice_1",
      acmeOther,
    );
    const late = new Date(SETUP_TIME.getTime() + 60_000);

    await recordPulledCallReceived(at(acme, ada), {
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      receivedAt: late,
    });

    expect((await notebook(mine))?.last_received_at).toEqual(late);
    expect((await notebook(theirs))?.last_received_at).toBeNull();
  });

  /**
   * **It travels with the agent, because the agent is where a person reads it.**
   *
   * Whether it pulls and when it last received are the two facts the agent
   * states about monitoring, and the second one lives on the machine notebook.
   * The agent read carries it across, so the screen needs no second request and
   * no second door.
   */
  it("travels on the agent an ordinary read answers", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const auth = at(acme, ada);
    expect((await getAgent(auth, agentId))?.lastReceivedAt).toBeNull();

    const late = new Date(SETUP_TIME.getTime() + 60_000);
    await recordPulledCallReceived(auth, {
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      receivedAt: late,
    });

    expect((await getAgent(auth, agentId))?.lastReceivedAt).toEqual(late);
    // And an agent with no notebook at all reads as never, not as missing.
    const unbound = await agentNamed("Night line");
    expect((await getAgent(auth, unbound))?.lastReceivedAt).toBeNull();
  });
});

describe("a call that would not come", () => {
  /**
   * One attempt and three automatic retries, and then a marker that schedules
   * nothing. The ceiling is stored, so a restart resumes a budget rather than
   * starting it again — and the overlap listing the call once more meets the
   * marker instead of starting a second budget.
   */
  it("spends a bounded budget and then leaves an expiring marker", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    const backoff = [30_000, 60_000, 120_000];

    let now = SETUP_TIME;
    for (let attempt = 1; attempt <= MOST_RETELL_CALL_ATTEMPTS; attempt += 1) {
      const outcome = await recordRetellCallAttempt(target.auth, target, {
        providerCallId: "call_broken",
        errorKind: "hydrate_failed",
        retryBackoffMilliseconds: backoff,
        now,
      });
      expect(outcome).toMatchObject({
        recorded: true,
        attempts: attempt,
        dropped: attempt === MOST_RETELL_CALL_ATTEMPTS,
      });
      now = new Date(now.getTime() + 10 * 60_000);
    }

    const marked = await transientRetellCallState(target.auth, {
      agentId: target.agentId,
      providerCallIds: ["call_broken"],
      importGeneration: target.importGeneration,
      now,
    });
    expect(marked.get("call_broken")).toMatchObject({
      attempts: MOST_RETELL_CALL_ATTEMPTS,
      nextAttemptAt: null,
      expiresAt: expect.any(Date),
    });

    // The marker schedules nothing, so no retry is ever due for it.
    expect(
      await dueRetellCallRetries(target.auth, {
        agentId: target.agentId,
        importGeneration: target.importGeneration,
        now: new Date(now.getTime() + 60 * 60_000),
        limit: 10,
      }),
    ).toEqual([]);

    // And it does not outlive the overlap it exists to survive.
    expect(
      await sweepExpiredRetellCallMarkers(target.auth, {
        agentId: target.agentId,
        now: new Date(now.getTime() + 60 * 60_000),
      }),
    ).toBe(1);
  });

  /** Durable evidence is what clears the row, and only durable evidence. */
  it("forgets a call once its evidence is durable", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_recovered",
      errorKind: "hydrate_failed",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });

    await deleteRetellCallRetry(target.auth, {
      providerCallId: "call_recovered",
    });

    expect(
      await transientRetellCallState(target.auth, {
        agentId: target.agentId,
        providerCallIds: ["call_recovered"],
        importGeneration: target.importGeneration,
        now: SETUP_TIME,
      }),
    ).toEqual(new Map());
  });

  /**
   * A new observation reads none of the last one's transient state, so leaving
   * it behind would be rows nothing can ever look at again.
   */
  it("clears transient state a new observation cannot read", async () => {
    const agentId = await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_broken",
      errorKind: "hydrate_failed",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });

    await disablePullProductionCalls(at(acme, ada), agentId);
    const restartedAt = new Date(SETUP_TIME.getTime() + 60_000);
    await enablePullProductionCalls(at(acme, ada), {
      agentId,
      agentPlatform: "retell",
      platformAgentId: "agent_retell_voice_1",
      apiKey: RETELL_KEY,
      now: restartedAt,
    });

    const { rows } = await database.sql<{ n: string }>(
      `select count(*)::text as n from retell_call_retry
        where agent_id = '${agentId}'`,
    );
    expect(rows[0]?.n).toBe("0");
  });

  /** The batched page lookup is project-scoped, like every other read here. */
  it("keeps one project's transient call state out of another's page", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    const target = await claimed();
    await recordRetellCallAttempt(target.auth, target, {
      providerCallId: "call_retrying",
      errorKind: "hydrate_failed",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });

    const elsewhere = await transientRetellCallState(at(acmeOther, ada), {
      agentId: target.agentId,
      providerCallIds: ["call_retrying"],
      importGeneration: target.importGeneration,
      now: SETUP_TIME,
    });
    expect(elsewhere.size).toBe(0);
  });

  /**
   * **One call is one budget, whichever agent meets it.**
   *
   * The row is unique per project and provider call, so two pulled agents in
   * one project that both list the same call count against one budget rather
   * than starting two — and the delete scopes by the same pair the finder
   * used, so ownership moving to the later attempt cannot strand the row.
   */
  it("clears the one budget two pulled agents share for a call they both meet", async () => {
    await pulling("Front desk", "agent_retell_voice_1");
    await pulling("Back office", "agent_retell_voice_2");
    const first = await claimed();
    const second = await claimed();
    expect(second.agentId).not.toBe(first.agentId);

    const a = await recordRetellCallAttempt(first.auth, first, {
      providerCallId: "call_both_meet",
      errorKind: "hydrate_failed",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });
    const b = await recordRetellCallAttempt(second.auth, second, {
      providerCallId: "call_both_meet",
      errorKind: "hydrate_failed",
      retryBackoffMilliseconds: [30_000],
      now: SETUP_TIME,
    });
    expect(a).toMatchObject({ attempts: 1 });
    expect(b).toMatchObject({ attempts: 2 });

    const { rows } = await database.sql<{ agent_id: string; attempts: number }>(
      "select agent_id, attempts from retell_call_retry",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.agent_id).toBe(second.agentId);

    // The first agent makes the call durable and clears it, although the row
    // now names the second.
    await deleteRetellCallRetry(first.auth, {
      providerCallId: "call_both_meet",
    });
    const after = await database.sql<{ n: string }>(
      "select count(*)::text as n from retell_call_retry",
    );
    expect(after.rows[0]?.n).toBe("0");
  });
});
