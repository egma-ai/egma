import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  allowanceUsedBy,
  billableSecondsOf,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  listSimulations,
  minutesFromSeconds,
  readUsageThisPeriod,
  startRun,
  type AuthContext,
} from "../src/index.ts";
import type { ConnectionType, Modality } from "../src/schema/agents.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * What an organization has used of each allowance this period, through the
 * data-access module.
 *
 * Two organizations throughout: the first question a usage read has to answer
 * correctly is whose usage it is. The conversations are given their spans
 * directly, because what is under test is the counting and not the simulator —
 * the same reason the rate-card tests price a record rather than run a
 * provider.
 */

let database: MigratedDatabase;

const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  otherProjectId: newId("prj"),
  userId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  otherProjectId: newId("prj"),
  userId: newId("usr"),
};

/** Acme was created on the 15th, so its month turns over on the 15th. */
const ACME_ANCHOR = new Date("2026-01-15T08:00:00.000Z");
/** The instant every read below asks about: inside the September period. */
const NOW = new Date("2026-09-20T12:00:00.000Z");
const PERIOD_STARTED = new Date("2026-09-15T08:00:00.000Z");
const PERIOD_RESETS = new Date("2026-10-15T08:00:00.000Z");

function sessionOf(
  who: typeof acme,
  role: "admin" | "member" | "viewer" = "member",
): AuthContext {
  return {
    userId: who.userId,
    organizationId: who.organizationId,
    projectId: who.projectId,
    role,
    via: "session",
  };
}

/** The lanes, and what each is written against. */
const LANES: Readonly<
  Record<
    ConnectionType,
    { readonly accessVariant: string; readonly modality: Modality }
  >
> = {
  retell_chat_api: {
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
  },
  retell_text_mode: {
    accessVariant: "retell_text_mode.api_key",
    modality: "chat",
  },
  retell_web_call: {
    accessVariant: "retell_web_call.api_key",
    modality: "voice",
  },
  phone_number: {
    accessVariant: "phone_number.public_e164",
    modality: "voice",
  },
  livekit_room: {
    accessVariant: "livekit_room.project_credentials",
    modality: "voice",
  },
};

type Seeded = {
  readonly runId: string;
  /** The one real simulation the run started, on the chat lane. */
  readonly simulationId: string;
  readonly agentId: string;
  readonly connections: ReadonlyMap<ConnectionType, string>;
  readonly personaId: string;
  readonly personaVersionId: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly projectId: string;
};

/**
 * One run, and a connection of every lane on its agent.
 *
 * The run is started through the module so the pins and the tenancy triangle
 * are the real ones; the conversations each test needs are written onto it
 * with the spans the test is about. `position` counts on from the run's own.
 */
async function seedRun(
  who: typeof acme,
  projectId: string = who.projectId,
): Promise<Seeded> {
  const auth = { ...sessionOf(who), projectId };
  const label = newId("run").slice(-8);
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
  const connections = new Map<ConnectionType, string>([
    ["retell_chat_api", created.connection?.id ?? ""],
  ]);
  // The other four lanes go in by raw SQL. What is under test is how a span is
  // counted, not what the connection registry admits, and a fixture that had
  // to satisfy every lane's own credential rule would be a fixture about
  // connections.
  for (const [connectionType, lane] of Object.entries(LANES)) {
    if (connectionType === "retell_chat_api") continue;
    const id = newId("con");
    await database.sql(
      `insert into connection
         (id, organization_id, project_id, agent_id, name, connection_type,
          access_variant, modality, topology, config)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'hosted-broker', '{}'::jsonb)`,
      [
        id,
        who.organizationId,
        projectId,
        created.id,
        `${connectionType}-${label}`,
        connectionType,
        lane.accessVariant,
        lane.modality,
      ],
    );
    connections.set(connectionType as ConnectionType, id);
  }

  const personaId = (
    await createPersona(auth, {
      name: `Impatient Rita ${label}`,
      identityName: "Sam Poole",
      personality: "Speaks plainly and asks one question at a time.",
      language: "en-US",
    })
  ).id;
  const suite = await createTestSuite(auth, { name: `Allowance ${label}` });
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
    connectionId: connections.get("retell_chat_api") ?? "",
  });
  const one = (await listSimulations(auth, started.id))?.items[0];
  if (one === undefined) throw new Error("the run has no simulation");

  const { rows } = await database.sql<{
    persona_version_id: string;
    test_id: string;
    test_version_id: string;
  }>(
    "select persona_version_id, test_id, test_version_id from simulation where id = $1",
    [one.id],
  );
  const pins = rows[0];
  if (pins === undefined) throw new Error("the simulation was not written");

  return {
    runId: started.id,
    simulationId: one.id,
    agentId: created.id,
    connections,
    personaId,
    personaVersionId: pins.persona_version_id,
    testId: pins.test_id,
    testVersionId: pins.test_version_id,
    projectId,
  };
}

let position = 100;

/**
 * One conversation on this run, over this lane, with this span.
 *
 * Written directly rather than conducted: what is under test is how a span is
 * counted, and a simulator that actually spoke for six hundred seconds is not
 * a thing a suite can wait for.
 */
async function conversation(
  seeded: Seeded,
  who: typeof acme,
  lane: ConnectionType,
  span: { readonly startedAt: Date | null; readonly seconds?: number },
): Promise<void> {
  position += 1;
  const startedAt = span.startedAt;
  const endedAt =
    startedAt === null || span.seconds === undefined
      ? null
      : new Date(startedAt.getTime() + span.seconds * 1_000);
  const status =
    startedAt === null ? "queued" : endedAt === null ? "running" : "completed";
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, connection_type, status, ending_reason,
        started_at, ended_at, claimed_by, claimed_at, heartbeat_at, persona_parameter_values)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $19,
             (select persona_parameter_values from simulation where run_id = $2 limit 1))`,
    [
      newId("sim"),
      seeded.runId,
      who.organizationId,
      seeded.projectId,
      seeded.agentId,
      seeded.connections.get(lane) ?? "",
      seeded.personaId,
      seeded.personaVersionId,
      seeded.testId,
      seeded.testVersionId,
      position,
      LANES[lane].modality,
      lane,
      status,
      status === "completed" ? "persona_concluded" : null,
      startedAt,
      endedAt,
      startedAt === null ? null : "the-simulator",
      startedAt,
    ],
  );
}

beforeAll(async () => {
  database = await createConnectedDatabase("allowance_usage");
  for (const who of [acme, globex]) {
    await seedOrganization(database, who.organizationId, [
      { id: who.projectId, slug: `p${who.projectId.slice(-6).toLowerCase()}` },
      {
        id: who.otherProjectId,
        slug: `q${who.otherProjectId.slice(-6).toLowerCase()}`,
      },
    ]);
    await seedUser(database, who.userId, `${who.userId}@example.test`);
  }
  await database.sql("update organization set created_at = $2 where id = $1", [
    acme.organizationId,
    ACME_ANCHOR,
  ]);
});

afterAll(async () => {
  await database.drop();
});

describe("a period with nothing in it", () => {
  it("answers zero for every allowance, and the period's own two dates", async () => {
    const usage = await readUsageThisPeriod(sessionOf(globex), NOW);
    expect(usage.used).toEqual({
      chat_simulations: 0,
      web_call_minutes: 0,
      phone_minutes: 0,
    });
    // Globex's own anchor is when the fixture made it, so only the shape is
    // asserted here; Acme's dates are asserted exactly below.
    expect(usage.resetsAt.getTime()).toBeGreaterThan(usage.startedAt.getTime());
  });
});

describe("what one organization used this period", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedRun(acme);
    const inside = new Date("2026-09-18T09:00:00.000Z");

    // Two chats, counted as conversations however long they lasted.
    await conversation(seeded, acme, "retell_chat_api", {
      startedAt: inside,
      seconds: 12,
    });
    await conversation(seeded, acme, "retell_text_mode", {
      startedAt: inside,
      seconds: 900,
    });

    // Web-call minutes: ninety seconds, plus a two-second one that counts the
    // ten-second floor. 90 + 10 = 100 seconds.
    await conversation(seeded, acme, "retell_web_call", {
      startedAt: inside,
      seconds: 90,
    });
    await conversation(seeded, acme, "livekit_room", {
      startedAt: inside,
      seconds: 2,
    });

    // Phone minutes: a full minute, and a ring nobody answered — thirty
    // seconds of waiting, which is real time on the carrier. 60 + 30 = 90.
    await conversation(seeded, acme, "phone_number", {
      startedAt: inside,
      seconds: 60,
    });
    await conversation(seeded, acme, "phone_number", {
      startedAt: inside,
      seconds: 30,
    });
  });

  it("counts chat by the conversation and voice by the second", async () => {
    const usage = await readUsageThisPeriod(sessionOf(acme), NOW);
    expect(usage).toEqual({
      startedAt: PERIOD_STARTED,
      resetsAt: PERIOD_RESETS,
      used: {
        chat_simulations: 2,
        web_call_minutes: minutesFromSeconds(100),
        phone_minutes: minutesFromSeconds(90),
      },
    });
  });

  it("counts the same numbers the one billable-time rule counts", async () => {
    // The aggregate is that rule written in SQL. This is what stops the two
    // drifting: the same spans, folded here by the pure function.
    const { rows } = await database.sql<{
      modality: Modality;
      connection_type: ConnectionType;
      started_at: Date | null;
      ended_at: Date | null;
    }>(
      `select modality, connection_type, started_at, ended_at
         from simulation
        where organization_id = $1 and started_at >= $2 and started_at < $3`,
      [acme.organizationId, PERIOD_STARTED, PERIOD_RESETS],
    );
    const folded = { chat_simulations: 0, web_call_minutes: 0, phone_minutes: 0 };
    let webCallSeconds = 0;
    let phoneSeconds = 0;
    for (const row of rows) {
      const { kind } = allowanceUsedBy({
        modality: row.modality,
        connectionType: row.connection_type,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      });
      if (kind === "chat_simulations") {
        folded.chat_simulations += 1;
        continue;
      }
      const seconds = billableSecondsOf({
        startedAt: row.started_at,
        endedAt: row.ended_at,
      });
      if (kind === "phone_minutes") phoneSeconds += seconds;
      else webCallSeconds += seconds;
    }
    folded.web_call_minutes = minutesFromSeconds(webCallSeconds);
    folded.phone_minutes = minutesFromSeconds(phoneSeconds);

    const usage = await readUsageThisPeriod(sessionOf(acme), NOW);
    expect(usage.used).toEqual(folded);
  });

  it("counts nothing for a conversation that has not both begun and ended", async () => {
    const before = await readUsageThisPeriod(sessionOf(acme), NOW);
    // Queued, and running. Neither has a measured span yet.
    await conversation(seeded, acme, "phone_number", { startedAt: null });
    await conversation(seeded, acme, "phone_number", {
      startedAt: new Date("2026-09-19T09:00:00.000Z"),
    });
    const after = await readUsageThisPeriod(sessionOf(acme), NOW);
    expect(after.used).toEqual(before.used);
  });

  it("counts a conversation of the customer's other project too", async () => {
    // An allowance belongs to the customer, and a member looking at one
    // project's settings page is still looking at the customer's month.
    const before = await readUsageThisPeriod(sessionOf(acme), NOW);
    const elsewhere = await seedRun(acme, acme.otherProjectId);
    await conversation(elsewhere, acme, "phone_number", {
      startedAt: new Date("2026-09-19T10:00:00.000Z"),
      seconds: 60,
    });
    const after = await readUsageThisPeriod(sessionOf(acme), NOW);
    expect(after.used.phone_minutes).toBe(
      before.used.phone_minutes + minutesFromSeconds(60),
    );
    // And the run the other project started is itself a chat conversation,
    // still queued, so it changed no count of its own.
    expect(after.used.chat_simulations).toBe(before.used.chat_simulations);
  });

  it("counts nothing of another customer's", async () => {
    const theirs = await seedRun(globex);
    await conversation(theirs, globex, "phone_number", {
      startedAt: new Date("2026-09-19T11:00:00.000Z"),
      seconds: 600,
    });
    const acmeUsage = await readUsageThisPeriod(sessionOf(acme), NOW);
    const globexUsage = await readUsageThisPeriod(sessionOf(globex), NOW);
    expect(globexUsage.used.phone_minutes).toBe(minutesFromSeconds(600));
    expect(acmeUsage.used.phone_minutes).toBeLessThan(
      globexUsage.used.phone_minutes,
    );
  });

  it("is readable by every role, because a paused run has to explain itself", async () => {
    const asViewer = await readUsageThisPeriod(sessionOf(acme, "viewer"), NOW);
    const asAdmin = await readUsageThisPeriod(sessionOf(acme, "admin"), NOW);
    expect(asViewer.used).toEqual(asAdmin.used);
  });
});

describe("where one period stops and the next begins", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedRun(acme);
    // The last instant of August's period, the first instant of September's,
    // and the first instant of October's — one conversation each, all phone.
    for (const startedAt of [
      new Date(PERIOD_STARTED.getTime() - 1),
      PERIOD_STARTED,
      PERIOD_RESETS,
    ]) {
      await conversation(seeded, acme, "phone_number", {
        startedAt,
        seconds: 120,
      });
    }
  });

  it("counts the conversation begun at the period's first instant", async () => {
    const august = await readUsageThisPeriod(
      sessionOf(acme),
      new Date("2026-09-01T00:00:00.000Z"),
    );
    const september = await readUsageThisPeriod(sessionOf(acme), NOW);
    const october = await readUsageThisPeriod(
      sessionOf(acme),
      new Date("2026-10-20T00:00:00.000Z"),
    );

    expect(august.startedAt).toEqual(new Date("2026-08-15T08:00:00.000Z"));
    expect(august.resetsAt).toEqual(PERIOD_STARTED);
    expect(october.startedAt).toEqual(PERIOD_RESETS);

    // Each of the three conversations lands in exactly one month, and each
    // month sees exactly one of them: two minutes apiece.
    expect(august.used.phone_minutes).toBe(2);
    expect(october.used.phone_minutes).toBe(2);
    expect(september.used.phone_minutes).toBeGreaterThanOrEqual(2);
  });
});
