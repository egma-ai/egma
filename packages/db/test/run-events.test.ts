import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cancelRun,
  claimSimulations,
  completeSimulation,
  connectClickHouse,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  disconnectClickHouse,
  failSimulation,
  getRun,
  listRunEvents,
  listSimulations,
  markSimulationCanceled,
  startRun,
  startSimulation,
  sweepOrphanedSimulations,
  type AuthContext,
  type RunEvent,
  type SimulationClaim,
} from "@egma/db";

import {
  createMigratedTraceStore,
  type MigratedTraceStore,
} from "./support/clickhouse.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The run events record, at the seam the rest of egma reaches it through.
 *
 * This is the effort's one new seam, and it exists because HTTP cannot prove
 * what matters most about it: **the lifecycle change and its event land
 * together or not at all**. Over the wire you can only ever see the two after
 * the fact, and two writes that usually agree look exactly like two writes
 * that always agree. So both directions are driven here — a change that could
 * not record itself, and a record with no change under it — and the second is
 * forced by breaking the events table for one transaction, which is the only
 * honest way to ask "and what if the append had failed?".
 *
 * Everything else here is what a follower depends on: the numbering is dense,
 * the same page asked for twice is the same page, and `done` is true exactly
 * when the run has finished. The lifecycle underneath is tested in
 * `runs.test.ts` and is not tested again — what is new is the record of it.
 */

let database: MigratedDatabase;
let traceStore: MigratedTraceStore;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

function actingAsAcme(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: grace,
    organizationId: globex.organization,
    projectId: globex.project,
    role: "member",
    via: "session",
  };
}

const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
} as const;

let agentId: string;
let connectionId: string;
let oneCallerSuite: string;
let twoCallersSuite: string;
let twoCallers: string;

const CLAIMANT = "simulator-blue-1";

/** A run of its own, so a test's feed is never something else's leftovers. */
async function aRun(suiteId = oneCallerSuite) {
  return startRun(actingAsAcme(), {
    suiteId,
    agentId,
    connectionId,
    idempotencyKey: newId("run"),
  });
}

/** Claim for one run under test; the queue is the whole deployment's. */
async function claimOwn(runId: string): Promise<readonly SimulationClaim[]> {
  const claimed = await claimSimulations({
    claimant: CLAIMANT,
    capacity: 50,
  });
  return claimed.filter((claim) => claim.runId === runId);
}

async function feedOf(runId: string, after = 0) {
  const page = await listRunEvents(actingAsAcme(), runId, { after });
  if (page === undefined) throw new Error(`run ${runId} is not readable`);
  return page;
}

/** What each event says, in one line, for comparing whole feeds at a glance. */
function said(event: RunEvent): string {
  return event.kind === "run"
    ? `run ${event.status}`
    : `${event.testName}/${event.personaName} ${event.status}`;
}

/** How many events one run holds, whatever anybody was allowed to read. */
async function eventCount(runId: string): Promise<number> {
  const { rows } = await database.sql<{ count: string }>(
    "select count(*) as count from run_event where run_id = $1",
    [runId],
  );
  return Number(rows[0]?.count);
}

/** Every message in a thrown error's chain, because drivers wrap. */
function causesOf(error: unknown): string[] {
  const said: string[] = [];
  let held = error;
  while (held instanceof Error) {
    said.push(held.message);
    held = held.cause;
  }
  return said;
}

async function statusOf(simulationId: string): Promise<string> {
  const { rows } = await database.sql<{ status: string }>(
    "select status from simulation where id = $1",
    [simulationId],
  );
  return rows[0]?.status ?? "";
}

beforeAll(async () => {
  traceStore = await createMigratedTraceStore("run_events");
  connectClickHouse({ clickhouseUrl: traceStore.url, maxOpenConnections: 2 });
  database = await createConnectedDatabase("run_events");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
  // This file records only the run lifecycle and its event numbering. The
  // empty trace store lets completion check for already-landed evidence without
  // adding grading work to these lifecycle cases.

  const created = await createAgent(actingAsAcme(), {
    name: "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  agentId = created.id;
  connectionId = created.connection?.id ?? "";

  const rita = (
    await createPersona(actingAsAcme(), {
      name: "Impatient Rita",
      traits: neutralTraits,
    })
  ).id;
  const sam = (
    await createPersona(actingAsAcme(), {
      name: "Deliberate Sam",
      traits: neutralTraits,
    })
  ).id;

  const version = async (
    suiteId: string,
    name: string,
    personaIds: readonly string[],
  ) =>
    (
      await createTest(actingAsAcme(), {
        suiteId,
        name,
        scenario: "Their cleaning is booked for Thursday and has to move.",
        expectedBehaviors: ["confirms the new time back before finishing"],
        personaIds,
      })
    ).versionId;

  oneCallerSuite = (
    await createTestSuite(actingAsAcme(), { name: "One persona" })
  ).id;
  twoCallersSuite = (
    await createTestSuite(actingAsAcme(), { name: "Two personas" })
  ).id;
  await version(oneCallerSuite, "Reschedules", [rita]);
  twoCallers = await version(twoCallersSuite, "Cancels", [rita, sam]);
});

afterAll(async () => {
  await database.drop();
  await disconnectClickHouse();
  await traceStore.drop();
});

describe("a run that has only just started", () => {
  it("has no events yet, and is not done", async () => {
    const started = await aRun();

    const feed = await feedOf(started.id);
    expect(feed.events).toEqual([]);
    // Nothing has changed, so there is nothing to ask after: the cursor stays
    // where the follower left it rather than moving to a number nobody issued.
    expect(feed.next).toBe(0);
    expect(feed.done).toBe(false);
  });
});

describe("every lifecycle change", () => {
  it("records itself, in the order it happened, numbered densely from one", async () => {
    const started = await aRun(twoCallersSuite);
    const [first, second] = await claimOwn(started.id);
    if (first === undefined || second === undefined) {
      throw new Error("the claim missed the run under test");
    }

    await startSimulation(actingAsAcme(), first.id, CLAIMANT);
    await completeSimulation(actingAsAcme(), first.id, CLAIMANT, {
      endingReason: "agent_ended",
    });
    await failSimulation(actingAsAcme(), second.id, CLAIMANT, {
      reason: "agent_never_joined",
    });

    const feed = await feedOf(started.id);
    expect(feed.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(feed.events.map(said)).toEqual([
      "Cancels/Impatient Rita claimed",
      "Cancels/Deliberate Sam claimed",
      "run running",
      "Cancels/Impatient Rita running",
      "Cancels/Impatient Rita completed",
      "Cancels/Deliberate Sam failed",
      "run completed",
    ]);
    expect(feed.done).toBe(true);
  });

  it("carries how a conversation ended", async () => {
    const started = await aRun();
    const [only] = await claimOwn(started.id);
    if (only === undefined) throw new Error("the claim missed the run");

    await startSimulation(actingAsAcme(), only.id, CLAIMANT);
    await completeSimulation(actingAsAcme(), only.id, CLAIMANT, {
      endingReason: "persona_concluded",
    });

    const landed = (await feedOf(started.id)).events.find(
      (event) => event.status === "completed" && event.kind === "simulation",
    );
    expect(landed?.reason).toBe("persona_concluded");
  });

  it("records the sweep's own ending too", async () => {
    const started = await aRun();
    const [only] = await claimOwn(started.id);
    if (only === undefined) throw new Error("the claim missed the run");

    await database.sql(
      "update simulation set heartbeat_at = now() - interval '1 hour' where id = $1",
      [only.id],
    );
    await sweepOrphanedSimulations({ staleAfterSeconds: 30 });

    const feed = await feedOf(started.id);
    expect(feed.events.map(said)).toEqual([
      "Reschedules/Impatient Rita claimed",
      "run running",
      "Reschedules/Impatient Rita failed",
      "run completed",
    ]);
    expect(feed.events.at(-2)?.reason).toBe("orphaned");
  });
});

describe("the change and its event", () => {
  it("land together: a move nothing could record is a move that did not happen", async () => {
    const started = await aRun();
    const [only] = await claimOwn(started.id);
    if (only === undefined) throw new Error("the claim missed the run");

    const before = await eventCount(started.id);

    // The events table refuses everything for as long as this trigger is
    // installed. Nothing else in the product can break an append, so breaking
    // it deliberately is the only way to ask what happens when one fails.
    await database.sql(`
      create function refuse_every_event() returns trigger
      language plpgsql as $$
      begin
        raise exception 'this instance cannot write events just now';
      end
      $$`);
    await database.sql(`
      create trigger events_are_broken before insert on run_event
      for each row execute function refuse_every_event()`);

    try {
      // The driver wraps what Postgres said, so the sentence is read off the
      // chain rather than off the top: what matters is that the append is what
      // failed, and that the caller heard about it.
      const refused = await startSimulation(
        actingAsAcme(),
        only.id,
        CLAIMANT,
      ).catch((error: unknown) => error);
      expect(String(refused)).toContain("run_event");
      expect(causesOf(refused)).toContain("this instance cannot write events just now");
    } finally {
      await database.sql("drop trigger events_are_broken on run_event");
      await database.sql("drop function refuse_every_event()");
    }

    // The conversation is where it was. The transaction took the change with
    // it, so a follower can never be shown a run whose events stop short of
    // where the rows actually are.
    expect(await statusOf(only.id)).toBe("claimed");
    expect(await eventCount(started.id)).toBe(before);

    // And the same move, once the record works again, lands both halves.
    await startSimulation(actingAsAcme(), only.id, CLAIMANT);
    expect(await statusOf(only.id)).toBe("running");
    expect(await eventCount(started.id)).toBe(before + 1);
  });

  it("land together the other way: a move that was refused records nothing", async () => {
    const started = await aRun();
    const [only] = await claimOwn(started.id);
    if (only === undefined) throw new Error("the claim missed the run");

    const before = await eventCount(started.id);

    // Somebody else's claimant, a state this landing may not leave, and a
    // cancel nobody asked for. Each is turned away by the guarded update, and
    // none of them may leave an event saying it happened.
    expect(
      await startSimulation(actingAsAcme(), only.id, "simulator-green-2"),
    ).toBeUndefined();
    expect(
      await completeSimulation(actingAsAcme(), only.id, CLAIMANT, {
        endingReason: "agent_ended",
      }),
    ).toBeUndefined();
    expect(
      await markSimulationCanceled(actingAsAcme(), only.id, CLAIMANT),
    ).toBeUndefined();

    expect(await eventCount(started.id)).toBe(before);
    expect(await statusOf(only.id)).toBe("claimed");
  });
});

describe("a follower that crashes and comes back", () => {
  it("misses nothing and applies nothing twice, and a page served twice is harmless", async () => {
    const started = await aRun(twoCallersSuite);

    /**
     * A follower, written the way the contract says one is: it remembers the
     * last number it applied and asks for everything after it, and it applies
     * each number at most once. The server's half is to be stateless; this is
     * the other half.
     */
    const applied: number[] = [];
    const seen = new Set<number>();
    let cursor = 0;
    const follow = async () => {
      const page = await feedOf(started.id, cursor);
      for (const event of page.events) {
        if (seen.has(event.seq)) continue;
        seen.add(event.seq);
        applied.push(event.seq);
      }
      cursor = page.next;
      return page;
    };

    const [first, second] = await claimOwn(started.id);
    if (first === undefined || second === undefined) {
      throw new Error("the claim missed the run under test");
    }
    await follow();

    // The crash: everything after the last applied number is asked for again,
    // and the page that arrives is the same page. Applying it changes nothing.
    const beforeReplay = [...applied];
    const replayed = await listRunEvents(actingAsAcme(), started.id, {
      after: applied.at(-1) ?? 0,
    });
    expect(replayed?.events).toEqual([]);
    expect(applied).toEqual(beforeReplay);

    await startSimulation(actingAsAcme(), first.id, CLAIMANT);
    await completeSimulation(actingAsAcme(), first.id, CLAIMANT, {
      endingReason: "agent_ended",
    });

    // A page served twice: the same request, twice. The server is stateless
    // and hands back the same page, and the second delivery is the follower's
    // own no-op rather than something the server had to prevent.
    const askedFrom = cursor;
    const once = await follow();
    const countAfterOnce = applied.length;
    cursor = askedFrom;
    const twice = await follow();
    expect(twice.events.map((event) => event.seq)).toEqual(
      once.events.map((event) => event.seq),
    );
    expect(applied.length).toBe(countAfterOnce);

    await failSimulation(actingAsAcme(), second.id, CLAIMANT, {
      reason: "simulator_error",
    });
    const last = await follow();

    // Every number exactly once, in order, with no hole in the middle — which
    // is what "missed nothing and repeated nothing" means.
    expect(applied).toEqual([...applied].sort((a, b) => a - b));
    expect(new Set(applied).size).toBe(applied.length);
    expect(applied).toEqual(
      Array.from({ length: applied.length }, (_, index) => index + 1),
    );
    expect(last.done).toBe(true);
    expect(applied.length).toBe(await eventCount(started.id));
  });
});

describe("the feed's done", () => {
  it("is false while anything is still moving, and true once the run finishes", async () => {
    const started = await aRun();
    expect((await feedOf(started.id)).done).toBe(false);

    const [only] = await claimOwn(started.id);
    if (only === undefined) throw new Error("the claim missed the run");
    expect((await feedOf(started.id)).done).toBe(false);

    await cancelRun(actingAsAcme(), started.id);
    // Canceled, and still not finished: one conversation is out with a
    // simulator, and the counts are not honest until it lands.
    expect((await feedOf(started.id)).done).toBe(false);

    await markSimulationCanceled(actingAsAcme(), only.id, CLAIMANT);
    const settled = await feedOf(started.id);
    expect(settled.done).toBe(true);

    // The straggler landing finishes the run, and finishing is not a
    // transition: the header already said `canceled`. One change, one event —
    // a second would draw a screen back through a status it never left, and
    // "the run has finished" is what `done` is for.
    expect(settled.events.map(said)).toEqual([
      "Reschedules/Impatient Rita claimed",
      "run running",
      "run canceled",
      "Reschedules/Impatient Rita canceled",
    ]);
  });

  it("says the run was canceled exactly once, however late the stragglers land", async () => {
    const started = await aRun(twoCallersSuite);
    const claimed = await claimOwn(started.id);
    expect(claimed).toHaveLength(2);

    await cancelRun(actingAsAcme(), started.id);
    for (const one of claimed) {
      await markSimulationCanceled(actingAsAcme(), one.id, CLAIMANT);
    }

    const feed = await feedOf(started.id);
    expect(feed.done).toBe(true);
    expect(feed.events.filter((event) => said(event) === "run canceled")).toHaveLength(
      1,
    );
    // And the counts landed all the same, with nothing pretending to have run.
    const settled = await getRun(actingAsAcme(), started.id);
    expect(settled).toMatchObject({
      status: "canceled",
      completedCount: 0,
      failedCount: 0,
      canceledCount: 2,
    });
  });

  it("is true the moment a cancel catches every conversation still queued", async () => {
    const started = await aRun(twoCallersSuite);

    await cancelRun(actingAsAcme(), started.id);

    const feed = await feedOf(started.id);
    expect(feed.done).toBe(true);
    expect(feed.events.map(said)).toEqual([
      "Cancels/Impatient Rita canceled",
      "Cancels/Deliberate Sam canceled",
      "run canceled",
    ]);
  });
});

describe("another customer's feed", () => {
  it("reads exactly as a run that never existed", async () => {
    const started = await aRun();
    await claimOwn(started.id);

    expect(
      await listRunEvents(actingAsGlobex(), started.id, { after: 0 }),
    ).toBeUndefined();
  });
});

describe("asking from a number nobody could have issued", () => {
  it("is refused rather than quietly read as the beginning", async () => {
    const started = await aRun();

    await expect(
      listRunEvents(actingAsAcme(), started.id, { after: -1 }),
    ).rejects.toThrow(/whole number from zero/);
    await expect(
      listRunEvents(actingAsAcme(), started.id, { after: 1.5 }),
    ).rejects.toThrow(/whole number from zero/);
  });

  it("answers an empty page for a number past the end, and leaves the cursor alone", async () => {
    const started = await aRun();
    await claimOwn(started.id);

    const page = await feedOf(started.id, 999);
    expect(page.events).toEqual([]);
    expect(page.next).toBe(999);
  });
});

describe("the simulations of a run", () => {
  it("name the version they execute and the person who calls, in pinned order", async () => {
    const started = await aRun(twoCallersSuite);

    const conducted = await listSimulations(actingAsAcme(), started.id);
    expect(conducted?.items.map((one) => `${one.testName}/${one.personaName}`)).toEqual([
      "Cancels/Impatient Rita",
      "Cancels/Deliberate Sam",
    ]);
    expect(conducted?.items.map((one) => one.testVersionId)).toEqual([
      twoCallers,
      twoCallers,
    ]);
    expect(started.expectedSimulationCount).toBe(2);
  });
});
