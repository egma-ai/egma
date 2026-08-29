import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  AgentWriteRefusedError,
  claimMockDraftFor,
  createAgent,
  getConnection,
  getRun,
  owedMockCleanups,
  recordMockState,
  updateConnection,
  type AuthContext,
  type ConnectionType,
  type MockMetadata,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * What the record has to admit for mock tools on Retell: the switch on each
 * connection, and — for one run — the serving version it conducted against, the
 * temporary copy it branched, the cleanup it owes, and the note that says how
 * to put the account back.
 *
 * The four fields are checked lane by lane against the sample rows the
 * decisions record settled, because a row a reader cannot interpret without a
 * decoder is exactly what they replaced.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const suiteId = newId("ste");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const testId = newId("tst");
const testVersionId = newId("tstv");

const RETELL_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8";

function acting(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "admin",
    via: "session",
  };
}

/** A sealed key on the agent, written the way monitoring setup writes one. */
async function sealPlatformKeyOn(agentId: string): Promise<void> {
  await database.sql(
    `update agent
        set platform_agent_id = $2,
            monitoring_api_key = 'v1.sealed.envelope.here',
            monitoring_api_key_hint = 'ab12'
      where id = $1`,
    [agentId, RETELL_AGENT],
  );
}

type Lane = {
  readonly connectionType: ConnectionType;
  readonly accessVariant: string;
  readonly modality: "voice" | "chat";
  readonly mockToolsEnabled: boolean;
};

const WEB_CALL: Lane = {
  connectionType: "retell_web_call",
  accessVariant: "retell_web_call.api_key",
  modality: "voice",
  mockToolsEnabled: true,
};

/**
 * A run with one queued simulation, written directly.
 *
 * Direct because what is under test is what a run *remembers*, and reaching it
 * through the whole start-a-run path would make this a test of that path.
 */
async function seedRun(
  agentId: string,
  connectionId: string,
  lane: Lane = WEB_CALL,
): Promise<{ runId: string; simulationId: string }> {
  const runId = newId("run");
  const simulationId = newId("sim");
  await database.sql(
    `insert into run
       (id, organization_id, project_id, suite_id, agent_id, connection_id,
        status, triggered_via, connection_snapshot, mock_tool_snapshot,
        expected_simulation_count)
     values ($1, $2, $3, $4, $5, $6, 'pending', 'manual', $7::jsonb, $8::jsonb, 1)`,
    [
      runId,
      acme.organization,
      acme.project,
      suiteId,
      agentId,
      connectionId,
      JSON.stringify({
        agentPlatform: "retell",
        connectionType: lane.connectionType,
        accessVariant: lane.accessVariant,
        modality: lane.modality,
        topology: "hosted-broker",
        environment: null,
        config: { retellAgentId: RETELL_AGENT },
        mockToolsEnabled: lane.mockToolsEnabled,
      }),
      JSON.stringify({ defaults: [], overrides: {} }),
    ],
  );
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, 'queued')`,
    [
      simulationId,
      runId,
      acme.organization,
      acme.project,
      agentId,
      connectionId,
      personaId,
      personaVersionId,
      testId,
      testVersionId,
      lane.modality,
    ],
  );
  return { runId, simulationId };
}

/** The put-it-back note one mocked web-call run wrote. */
const NOTE: MockMetadata = {
  engine: { type: "conversation-flow", engineId: "flow_9c", version: 105 },
  numbers: [{ number: "+15550100", was: "latest", pinnedTo: 8 }],
};

/** An agent whose platform identity and key are in place. */
async function anAgent(name: string): Promise<string> {
  const created = await createAgent(acting(), {
    name,
    agentPlatform: "retell",
  });
  await sealPlatformKeyOn(created.id);
  return created.id;
}

async function aConnection(
  agentId: string,
  lane: Lane,
  name: string = lane.connectionType,
): Promise<string> {
  const connection = await addConnection(acting(), agentId, {
    name,
    agentPlatform: "retell",
    connectionType: lane.connectionType,
    accessVariant: lane.accessVariant as never,
    modality: lane.modality,
    config:
      lane.connectionType === "phone_number"
        ? { phoneNumber: "+15550100" }
        : { retellAgentId: RETELL_AGENT },
    ...(lane.connectionType === "phone_number"
      ? {}
      : { credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" } }),
    mockToolsEnabled: lane.mockToolsEnabled,
  });
  if (connection === undefined) throw new Error("the connection was not made");
  return connection.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("retell_mock_tools");
  await seedUser(database, ada, "ada@example.com");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await database.sql(
    `insert into test_suite (id, organization_id, project_id, name)
     values ($1, $2, $3, 'Regression')`,
    [suiteId, acme.organization, acme.project],
  );
  await database.sql("begin");
  await database.sql(
    `insert into persona (id, organization_id, project_id, name, current_version_id)
     values ($1, $2, $3, 'Impatient Rita', $4)`,
    [personaId, acme.organization, acme.project, personaVersionId],
  );
  await database.sql(
    `insert into persona_version
       (id, persona_id, version, identity_name, personality, language,
        llm_provider, llm_model, stt_provider, stt_model,
        tts_provider, tts_model, tts_voice_id, tts_speed)
     values ($1, $2, 1, 'Rita Alvarez', 'Speaks plainly.', 'en-US',
       'openai', 'gpt-4.1', 'deepgram', 'nova-3', 'cartesia', 'sonic-2',
       'voice-1', 1.0)`,
    [personaVersionId, personaId],
  );
  await database.sql("commit");
  await database.sql("begin");
  await database.sql(
    `insert into test
       (id, organization_id, project_id, suite_id, name, current_version_id, revision)
     values ($1, $2, $3, $4, 'Books an appointment', $5, $6)`,
    [
      testId,
      acme.organization,
      acme.project,
      suiteId,
      testVersionId,
      newId("rev"),
    ],
  );
  await database.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, '{"scenario": "Books", "expectedBehaviors": ["confirms"]}'::jsonb)`,
    [testVersionId, testId],
  );
  await database.sql("commit");
});

afterAll(async () => {
  await database?.close();
});

describe("the switch, on the connection", () => {
  it("arrives on for a text-mode connection and off for a web call", async () => {
    const agentId = await anAgent("Switch defaults");
    const text = await getConnection(
      acting(),
      agentId,
      await aConnection(
        agentId,
        {
          connectionType: "retell_text_mode",
          accessVariant: "retell_text_mode.api_key",
          modality: "chat",
          mockToolsEnabled: true,
        },
        "Text",
      ),
    );
    // Created with it on, because the text lane carries its answers on each
    // request and writes nothing to the customer's account.
    expect(text?.mockToolsEnabled).toBe(true);

    const web = await getConnection(
      acting(),
      agentId,
      await aConnection(
        agentId,
        { ...WEB_CALL, mockToolsEnabled: false },
        "Web call",
      ),
    );
    expect(web?.mockToolsEnabled).toBe(false);
  });

  it("can never be on for a phone connection", async () => {
    const agentId = await anAgent("Phone switch");
    const refused = await addConnection(acting(), agentId, {
      name: "Phone",
      agentPlatform: "retell",
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+15550100" },
      mockToolsEnabled: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The database says so, not only the factory: the phone lane is the real
    // carrier leg and is never dialled for a mocked run.
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.checkViolation);
  });

  it("refuses a web-call switch on an agent with nothing to branch with", async () => {
    const created = await createAgent(acting(), {
      name: "No platform key",
      agentPlatform: "retell",
    });
    const refused = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: RETELL_AGENT },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      mockToolsEnabled: true,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Checked at write time rather than by a cross-table constraint: a CHECK
    // cannot join, and both facts it would need live on the agent.
    expect(refused).toBeInstanceOf(AgentWriteRefusedError);
    expect(String(refused)).toContain("temporary version");
  });

  it("is turned on and off in place once the agent holds a key", async () => {
    const agentId = await anAgent("Consent flow");
    const connectionId = await aConnection(agentId, {
      ...WEB_CALL,
      mockToolsEnabled: false,
    });

    const on = await updateConnection(acting(), agentId, connectionId, {
      mockToolsEnabled: true,
    });
    expect(on?.mockToolsEnabled).toBe(true);

    // Absence is keep, so renaming never turns a mocked world off.
    const renamed = await updateConnection(acting(), agentId, connectionId, {
      name: "Web call (staging)",
    });
    expect(renamed?.mockToolsEnabled).toBe(true);

    const off = await updateConnection(acting(), agentId, connectionId, {
      mockToolsEnabled: false,
    });
    expect(off?.mockToolsEnabled).toBe(false);
  });
});

describe("the four fields one run records", () => {
  /** What a reader sees on a run's row, in the words the record uses. */
  async function fieldsOf(runId: string) {
    const run = await getRun(acting(), runId);
    return {
      agentVersion: run?.agentVersion ?? null,
      tempMockAgentVersion: run?.tempMockAgentVersion ?? null,
      tempMockAgentVersionCleanup: run?.tempMockAgentVersionCleanup ?? null,
      mockMetadata: run?.mockMetadata ?? null,
    };
  }

  it("says a mocked text run conducted against a version and copied nothing", async () => {
    const agentId = await anAgent("Text mocked");
    const connectionId = await aConnection(agentId, {
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      mockToolsEnabled: true,
    });
    const { runId } = await seedRun(agentId, connectionId, {
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      mockToolsEnabled: true,
    });
    await database.sql("update run set agent_version = 105 where id = $1", [
      runId,
    ]);

    // Text mode carries its answers on each request, so it branches nothing:
    // a serving version, and three nulls.
    expect(await fieldsOf(runId)).toEqual({
      agentVersion: 105,
      tempMockAgentVersion: null,
      tempMockAgentVersionCleanup: null,
      mockMetadata: null,
    });
  });

  it("says an unmocked text run conducted against the same one version", async () => {
    const agentId = await anAgent("Text unmocked");
    const lane: Lane = {
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      mockToolsEnabled: false,
    };
    const connectionId = await aConnection(agentId, lane);
    const { runId } = await seedRun(agentId, connectionId, lane);
    await database.sql("update run set agent_version = 105 where id = $1", [
      runId,
    ]);

    const run = await getRun(acting(), runId);
    // The version is set on every text run, mocked or not — a chat result
    // speaks for the version real traffic reaches either way. What the switch
    // decides is read off the snapshot, not off these four fields.
    expect(run?.agentVersion).toBe(105);
    expect(run?.connectionSnapshot.mockToolsEnabled).toBe(false);
    expect(await fieldsOf(runId)).toEqual({
      agentVersion: 105,
      tempMockAgentVersion: null,
      tempMockAgentVersionCleanup: null,
      mockMetadata: null,
    });
  });

  it("says a mocked web call owes a cleanup, then that the account is back", async () => {
    const agentId = await anAgent("Web call mocked");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const { runId } = await seedRun(agentId, connectionId);
    await database.sql("update run set agent_version = 105 where id = $1", [
      runId,
    ]);

    // Mid-run: the copy exists, a cleanup is owed, and the note says exactly
    // what has to be put back.
    await recordMockState(acting(), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    expect(await fieldsOf(runId)).toEqual({
      agentVersion: 105,
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    // The stored note is exactly the shape the decisions record settled.
    const stored = await database.sql<{ mock_metadata: unknown }>(
      "select mock_metadata from run where id = $1",
      [runId],
    );
    expect(
      (stored.rows[0]?.mock_metadata as { numbers: unknown[] }).numbers,
    ).toEqual([{ number: "+15550100", was: "latest", pinned_to: 8 }]);

    // After teardown: the flag says the account is back. The version number
    // and the note stay — they are the record of what this run branched and
    // what it put back, which a reader months later still deserves.
    await recordMockState(acting(), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: true,
      mockMetadata: NOTE,
    });
    expect(await fieldsOf(runId)).toEqual({
      agentVersion: 105,
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: true,
      mockMetadata: NOTE,
    });
  });

  it("says a phone run named no version and touched nothing", async () => {
    const agentId = await anAgent("Phone run");
    const lane: Lane = {
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      mockToolsEnabled: false,
    };
    const connectionId = await aConnection(agentId, lane);
    const { runId } = await seedRun(agentId, connectionId, lane);

    // Four nulls: the phone lane reaches the customer's published number and
    // the real tools, and Egma names no version at all.
    expect(await fieldsOf(runId)).toEqual({
      agentVersion: null,
      tempMockAgentVersion: null,
      tempMockAgentVersionCleanup: null,
      mockMetadata: null,
    });
  });

  it("keeps a branched copy from ever standing without a cleanup flag", async () => {
    const agentId = await anAgent("Flagless copy");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const { runId } = await seedRun(agentId, connectionId);
    const refused = await database
      .sql("update run set temp_mock_agent_version = 106 where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toContain(
      "run_temp_mock_agent_version_owes_cleanup",
    );
  });

  it("lets a finished run be told the two cleanup facts and nothing else", async () => {
    const agentId = await anAgent("Finished run");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const { runId } = await seedRun(agentId, connectionId);
    await recordMockState(acting(), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    await database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [runId],
    );
    await database.sql(
      `update run
          set status = 'completed', finished_at = now(),
              completed_count = 0, failed_count = 0, canceled_count = 0
        where id = $1`,
      [runId],
    );

    // The carve-out, which the sweep after a crash depends on.
    const settled = await recordMockState(acting(), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: true,
      mockMetadata: { ...NOTE, numbers: [] },
    });
    expect(settled?.tempMockAgentVersionCleanup).toBe(true);

    // And it is exactly those two columns. Everything else is frozen.
    const refused = await database
      .sql("update run set name = 'renamed' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/written once/u);

    const refusedVersion = await database
      .sql("update run set agent_version = 9 where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refusedVersion)).toMatch(/written once/u);
  });
});

describe("the gate that keeps a mocked run honest", () => {
  /**
   * **A mocked run's simulations cannot be claimed until its copy exists.**
   *
   * The gate reads two facts off the run's own snapshot — the switch and the
   * lane — and one off the run: whether it names a temporary copy. It is a
   * condition on the claim itself, so it is closed from the instant the rows
   * are written.
   */
  async function claimable(runId: string): Promise<readonly string[]> {
    const rows = await database.sql<{ id: string }>(
      `select s.id
         from simulation s
         join run r on r.id = s.run_id
        where s.status = 'queued'
          and s.run_id = $1
          and not (
            r.connection_snapshot->>'mockToolsEnabled' = 'true'
            and r.connection_snapshot->>'connectionType' in ('retell_web_call')
            and r.temp_mock_agent_version is null
          )`,
      [runId],
    );
    return rows.rows.map((row) => row.id);
  }

  it("holds a mocked web-call run back until the copy lands", async () => {
    const agentId = await anAgent("Gated agent");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const { runId, simulationId } = await seedRun(agentId, connectionId);

    expect(await claimable(runId)).toEqual([]);

    // The capture, written before anything was branched. Still nothing: a run
    // that owes a cleanup but names no copy is a world half built.
    await recordMockState(acting(), runId, {
      tempMockAgentVersion: null,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    expect(await claimable(runId)).toEqual([]);

    await recordMockState(acting(), runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    expect(await claimable(runId)).toEqual([simulationId]);
  });

  it("holds nothing back for a text run, mocked or not", async () => {
    const agentId = await anAgent("Text gate");
    const lane: Lane = {
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
      mockToolsEnabled: true,
    };
    const connectionId = await aConnection(agentId, lane);
    const { runId, simulationId } = await seedRun(agentId, connectionId, lane);
    // Unlimited in parallel and never queued behind machinery it does not use.
    expect(await claimable(runId)).toEqual([simulationId]);
  });

  it("holds nothing back for a web-call run with the switch off", async () => {
    const agentId = await anAgent("Unmocked web call");
    const lane: Lane = { ...WEB_CALL, mockToolsEnabled: false };
    const connectionId = await aConnection(agentId, lane);
    const { runId, simulationId } = await seedRun(agentId, connectionId, lane);
    expect(await claimable(runId)).toEqual([simulationId]);
  });
});

describe("the claim, and the fence around a cleanup that is owed", () => {
  const STALE = 15 * 60 * 1000;

  async function finishRun(runId: string): Promise<void> {
    await database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [runId],
    );
    await database.sql(
      `update run
          set status = 'completed', finished_at = now(),
              completed_count = 0, failed_count = 0, canceled_count = 0
        where id = $1`,
      [runId],
    );
  }

  it("refuses a second run while a live run still owes a cleanup", async () => {
    const agentId = await anAgent("Held agent");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const first = await seedRun(agentId, connectionId);
    const second = await seedRun(agentId, connectionId);

    expect(
      await claimMockDraftFor(acting(), {
        runId: first.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });

    // The claim itself is the durable marker, so the second run is refused
    // from the instant the first one wins.
    expect(
      await claimMockDraftFor(acting(), {
        runId: second.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "taken", byRunId: first.runId });
  });

  it("lets exactly one of two simultaneous claims through", async () => {
    const agentId = await anAgent("Racing agent");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const first = await seedRun(agentId, connectionId);
    const second = await seedRun(agentId, connectionId);

    const both = await Promise.all([
      claimMockDraftFor(acting(), {
        runId: first.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
      claimMockDraftFor(acting(), {
        runId: second.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ]);
    expect(both.filter((one) => one.kind === "claimed")).toHaveLength(1);
    expect(both.filter((one) => one.kind === "taken")).toHaveLength(1);
  });

  it("finds a predecessor's owed cleanup by one indexed query", async () => {
    const agentId = await anAgent("Owed cleanup");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const crashed = await seedRun(agentId, connectionId);
    await recordMockState(acting(), crashed.runId, {
      tempMockAgentVersion: 106,
      tempMockAgentVersionCleanup: false,
      mockMetadata: NOTE,
    });
    await finishRun(crashed.runId);

    const owed = await owedMockCleanups(acting(), agentId);
    expect(owed).toHaveLength(1);
    expect(owed[0]?.runId).toBe(crashed.runId);
    expect(owed[0]?.tempMockAgentVersion).toBe(106);
    // The note comes back whole, because it is what a restore acts on.
    expect(owed[0]?.metadata).toEqual(NOTE);

    // A finished run never blocks the claim — its litter is the sweep's, and
    // the caller sweeps before it branches. When that sweep cannot settle it,
    // the caller refuses to branch rather than mint the copy the late restore
    // would route real callers to.
    const next = await seedRun(agentId, connectionId);
    expect(
      await claimMockDraftFor(acting(), {
        runId: next.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
  });

  it("stops answering once the cleanup flag says the account is back", async () => {
    const agentId = await anAgent("Settled cleanup");
    const connectionId = await aConnection(agentId, WEB_CALL);
    const done = await seedRun(agentId, connectionId);
    await recordMockState(acting(), done.runId, {
      tempMockAgentVersion: null,
      tempMockAgentVersionCleanup: true,
      mockMetadata: NOTE,
    });
    expect(await owedMockCleanups(acting(), agentId)).toEqual([]);
  });

  it("does not let one agent's owed cleanup block another agent's run", async () => {
    const held = await anAgent("Busy agent");
    const heldConnection = await aConnection(held, WEB_CALL);
    const busy = await seedRun(held, heldConnection);
    await claimMockDraftFor(acting(), {
      runId: busy.runId,
      agentId: held,
      staleBuildMilliseconds: STALE,
    });

    const other = await anAgent("Free agent");
    const otherConnection = await aConnection(other, WEB_CALL);
    const free = await seedRun(other, otherConnection);
    expect(
      await claimMockDraftFor(acting(), {
        runId: free.runId,
        agentId: other,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
  });
});
