import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMigratedDatabase,
  errorCodeOf,
  openSingleConnection,
  POSTGRES_ERROR,
  type MigratedDatabase,
  type SingleConnection,
} from "./support/database.ts";

/**
 * These tests write raw SQL on purpose. The constraints and triggers below
 * exist to defend the paths that never pass through the application — a
 * migration script, a bulk import, a manual fix at three in the morning — so
 * a test that went through the application could not reach them.
 *
 * Two organizations exist throughout, because a test with one organization
 * cannot fail the way that matters.
 */

let database: MigratedDatabase;
let db: SingleConnection;

const acme = { organization: newId("org"), project: newId("prj") };
/** A second project of Acme's, so a cross-project pairing has a real target. */
const outbound = newId("prj");
const globex = { organization: newId("org"), project: newId("prj") };

const agentId = newId("agt");
const connectionId = newId("con");
const outboundAgentId = newId("agt");
const outboundConnectionId = newId("con");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const globexPersonaId = newId("prs");
const globexPersonaVersionId = newId("prsv");

async function seedTenancy(): Promise<void> {
  for (const [organization, slug] of [
    [acme.organization, "acme"],
    [globex.organization, "globex"],
  ] as const) {
    await db.sql("insert into organization (id, name, slug) values ($1, $2, $2)", [
      organization,
      slug,
    ]);
  }
  for (const [project, organization, slug] of [
    [acme.project, acme.organization, "default"],
    [outbound, acme.organization, "outbound"],
    [globex.project, globex.organization, "default"],
  ] as const) {
    await db.sql(
      "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $3)",
      [project, organization, slug],
    );
  }
}

async function seedAgent(
  id: string,
  projectId: string,
  connection: string,
): Promise<void> {
  await db.sql(
    "insert into agent (id, organization_id, project_id, name) values ($1, $2, $3, $1)",
    [id, acme.organization, projectId],
  );
  await db.sql(
    `insert into connection
       (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
     values ($1, $2, $3, $4, $1, 'retell', 'chat', 'hosted-broker', '{}'::jsonb)`,
    [connection, acme.organization, projectId, id],
  );
}

async function seedPersona(
  persona: string,
  version: string,
  organization: string,
  project: string,
): Promise<void> {
  // The current-version pointer is deferred, so the pair lands in one
  // transaction exactly as the application writes it.
  await db.sql("begin");
  await db.sql(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [persona, organization, project, version],
  );
  await db.sql(
    "insert into persona_version (id, persona_id, version, traits) values ($1, $2, 1, '{}'::jsonb)",
    [version, persona],
  );
  await db.sql("commit");
}

type RunOverrides = Readonly<Record<string, unknown>>;

/** A minimal well-formed run row, its shape overridden by the case at hand. */
async function insertRun(overrides: RunOverrides = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: newId("run"),
    organization_id: acme.organization,
    project_id: acme.project,
    agent_id: agentId,
    connection_id: connectionId,
    status: "pending",
    triggered_via: "manual",
    requested_personas: JSON.stringify({ personaIds: [personaId] }),
    connection_snapshot: JSON.stringify({
      type: "retell",
      modality: "chat",
      topology: "hosted-broker",
      environment: null,
      config: {},
    }),
    expected_simulation_count: 1,
    ...overrides,
  };
  const columns = Object.keys(row);
  await db.sql(
    `insert into run (${columns.join(", ")})
     values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

/** What each lifecycle state's row looks like, for births in mid-lifecycle. */
function shapeOf(status: string): Record<string, unknown> {
  const claim = {
    claimed_by: "simulator-blue-1",
    claimed_at: new Date(),
    heartbeat_at: new Date(),
  };
  switch (status) {
    case "queued":
      return {};
    case "claimed":
      return claim;
    case "running":
      return { ...claim, started_at: new Date() };
    case "completed":
      return {
        ...claim,
        started_at: new Date(),
        ended_at: new Date(),
        ending_reason: "persona_concluded",
      };
    case "failed":
      return { ...claim, ended_at: new Date(), ending_reason: "simulator_error" };
    case "canceled":
      return { ended_at: new Date(), cancel_requested_at: new Date() };
    default:
      throw new Error(`no such status: ${status}`);
  }
}

type SimulationOverrides = Readonly<Record<string, unknown>>;

/** One run, one simulation in the named state; the simulation's id back. */
async function insertSimulation(
  status: string,
  overrides: SimulationOverrides = {},
): Promise<string> {
  const runId = await insertRun();
  const row: Record<string, unknown> = {
    id: newId("sim"),
    run_id: runId,
    organization_id: acme.organization,
    project_id: acme.project,
    agent_id: agentId,
    connection_id: connectionId,
    persona_id: personaId,
    persona_version_id: personaVersionId,
    position: 1,
    connection_type: "retell",
    modality: "chat",
    status,
    ...shapeOf(status),
    ...overrides,
  };
  const columns = Object.keys(row);
  await db.sql(
    `insert into simulation (${columns.join(", ")})
     values (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row),
  );
  return row.id as string;
}

async function moveSimulation(
  id: string,
  to: string,
  set: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const extra = Object.entries(set);
  await db.sql(
    `update simulation set status = $1${extra
      .map(([column], index) => `, ${column} = $${index + 3}`)
      .join("")} where id = $2`,
    [to, id, ...extra.map(([, value]) => value)],
  );
}

beforeAll(async () => {
  database = await createMigratedDatabase("run_constraints");
  db = await openSingleConnection(database.url);

  await seedTenancy();
  await seedAgent(agentId, acme.project, connectionId);
  await seedAgent(outboundAgentId, outbound, outboundConnectionId);
  await seedPersona(personaId, personaVersionId, acme.organization, acme.project);
  await seedPersona(
    globexPersonaId,
    globexPersonaVersionId,
    globex.organization,
    globex.project,
  );
});

afterAll(async () => {
  await db.close();
  await database.drop();
});

describe("an illegal simulation move", () => {
  it("cannot be written: queued does not skip to running or to completed", async () => {
    const id = await insertSimulation("queued");

    for (const to of ["running", "completed"]) {
      await expect(
        moveSimulation(id, to, shapeOf(to)),
      ).rejects.toSatisfy(
        (error) =>
          errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
          String(error).includes("may not move"),
      );
    }
  });

  it("cannot be written: claimed does not skip running on its way to completed", async () => {
    const id = await insertSimulation("claimed");

    await expect(
      moveSimulation(id, "completed", {
        started_at: new Date(),
        ended_at: new Date(),
        ending_reason: "persona_concluded",
      }),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("may not move"),
    );
  });

  it("cannot reopen a terminal row, or rewrite what one reported", async () => {
    const id = await insertSimulation("completed");

    await expect(
      moveSimulation(id, "running", { ended_at: null, ending_reason: null }),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("written once"),
    );

    await expect(
      db.sql("update simulation set transcript = '[]'::jsonb where id = $1", [id]),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("written once"),
    );
  });

  it("keeps a canceled-before-claim row unclaimable forever", async () => {
    const id = await insertSimulation("canceled");

    await expect(
      moveSimulation(id, "claimed", shapeOf("claimed")),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("written once"),
    );
  });

  it("still lets the lifecycle walk forward one legal step at a time", async () => {
    const id = await insertSimulation("queued");

    await moveSimulation(id, "claimed", shapeOf("claimed"));
    await moveSimulation(id, "running", { started_at: new Date() });
    await moveSimulation(id, "completed", {
      ended_at: new Date(),
      ending_reason: "agent_ended",
    });

    const { rows } = await db.sql<{ status: string }>(
      "select status from simulation where id = $1",
      [id],
    );
    expect(rows[0]?.status).toBe("completed");
  });
});

describe("a simulation's shape", () => {
  it("refuses a claimed row with no claim bookkeeping", async () => {
    await expect(
      insertSimulation("claimed", {
        claimed_by: null,
        claimed_at: null,
        heartbeat_at: null,
      }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("refuses a queued row already carrying a cancel intent", async () => {
    await expect(
      insertSimulation("queued", { cancel_requested_at: new Date() }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("refuses an ending reason from the wrong class, in both directions", async () => {
    // "The agent never joined" is not a way a conversation ends…
    await expect(
      insertSimulation("completed", { ending_reason: "agent_never_joined" }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );

    // …and "the persona concluded" is not a way to have never run.
    await expect(
      insertSimulation("failed", { ending_reason: "persona_concluded" }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("refuses a report on a row that has not ended", async () => {
    await expect(
      insertSimulation("running", { transcript: "[]" }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("holds audio facts to voice: a chat cannot carry a band or a recording", async () => {
    await expect(
      insertSimulation("completed", { measured_audio_band_hertz: 48_000 }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
    await expect(
      insertSimulation("completed", { recording_reference: "recordings/one.flac" }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );

    // On voice they are exactly what the row is for.
    await expect(
      insertSimulation("completed", {
        modality: "voice",
        measured_audio_band_hertz: 8_000,
        recording_reference: "recordings/one.flac",
      }),
    ).resolves.toBeDefined();
  });

  it("refuses an identifier carrying the wrong prefix", async () => {
    await expect(insertSimulation("queued", { id: newId("tst") })).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });
});

describe("what a simulation cannot name", () => {
  it("a connection that is not the named agent's, even when both exist", async () => {
    await expect(
      insertSimulation("queued", {
        agent_id: outboundAgentId,
        project_id: outbound,
        connection_id: connectionId, // the default project's agent's
      }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("a run of another project, even inside the same customer", async () => {
    await expect(
      insertSimulation("queued", {
        agent_id: outboundAgentId,
        project_id: outbound,
        connection_id: outboundConnectionId,
        // run_id stays a default-project run's, and the pairing is refused.
      }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("another customer's project, whichever columns look real on their own", async () => {
    await expect(
      insertRun({ project_id: globex.project }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("another customer's persona pin, even though the version exists", async () => {
    await expect(
      insertSimulation("queued", {
        persona_id: globexPersonaId,
        persona_version_id: globexPersonaVersionId,
      }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("a version that is not the named persona's, even when both are this project's", async () => {
    await expect(
      insertSimulation("queued", {
        persona_id: personaId,
        persona_version_id: globexPersonaVersionId,
      }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });
});

describe("the run header", () => {
  it("cannot complete a run that never started", async () => {
    const id = await insertRun();

    await expect(
      db.sql(
        `update run set status = 'completed', started_at = now(), finished_at = now(),
           completed_count = 0, failed_count = 0, canceled_count = 0
         where id = $1`,
        [id],
      ),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("may not move"),
    );
  });

  it("freezes the counts once they are written", async () => {
    const id = await insertRun({
      status: "canceled",
      finished_at: new Date(),
      completed_count: 0,
      failed_count: 0,
      canceled_count: 1,
    });

    await expect(
      db.sql("update run set completed_count = 5 where id = $1", [id]),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("written once"),
    );
  });

  it("refuses half a terminal write: counts and finished_at arrive together", async () => {
    await expect(
      insertRun({ completed_count: 1 }),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("keeps the expectation set at start", async () => {
    const id = await insertRun();

    await expect(
      db.sql("update run set expected_simulation_count = 7 where id = $1", [id]),
    ).rejects.toSatisfy(
      (error) =>
        errorCodeOf(error) === POSTGRES_ERROR.raiseException &&
        String(error).includes("set once at start"),
    );
  });
});
