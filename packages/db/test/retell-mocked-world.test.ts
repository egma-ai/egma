import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  AgentWriteRefusedError,
  claimMockedWorldFor,
  claimSimulations,
  coverageFromClasses,
  createAgent,
  failSimulation,
  getAgent,
  getConnection,
  getRun,
  getSimulation,
  recordMockedWorld,
  simulationMockedWorld,
  TOOL_COVERAGE_CLASSES as RECORD_CLASSES,
  updateAgent,
  type AuthContext,
  type MockedWorld,
} from "@egma/db";
import { TOOL_COVERAGE_CLASSES as RETELL_CLASSES } from "@egma/retell";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * What the record has to admit for a mocked run on Retell: the tick on the
 * agent, the web-call lane beside the chat one, and — for one run — the
 * temporary version it minted, every touched number's routing as it was read,
 * and the three-class coverage stamp.
 *
 * The round trip is the point of every case here. A record that could be
 * written and not read back is a teardown that cannot put an account back.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const suiteId = newId("ste");
const personaId = newId("prs");
const personaVersionId = newId("prsv");
const testId = newId("tst");
const testVersionId = newId("tstv");

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
        set platform_agent_id = 'agent_b0e2e9cb267c47e7e7026cd8e8',
            monitoring_api_key = 'v1.sealed.envelope.here',
            monitoring_api_key_hint = 'ab12'
      where id = $1`,
    [agentId],
  );
}

/**
 * A run with one queued simulation, written directly.
 *
 * Direct because what is under test is what a run *remembers*, and reaching it
 * through the whole start-a-run path would make this a test of that path.
 */
async function seedRun(
  agentId: string,
  connectionId: string,
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
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        topology: "hosted-broker",
        environment: null,
        config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      }),
      JSON.stringify({
        defaults: [
          {
            toolName: "get_availability",
            mockToolId: newId("mck"),
            answer: { answer: { slots: ["Tuesday 14:00"] } },
            delayMilliseconds: 0,
          },
        ],
        overrides: {},
      }),
    ],
  );
  await database.sql(
    `insert into simulation
       (id, run_id, organization_id, project_id, agent_id, connection_id,
        persona_id, persona_version_id, test_id, test_version_id,
        position, modality, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'voice', 'queued')`,
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
    ],
  );
  return { runId, simulationId };
}

/** The world one run recorded, with a binding field egma has never heard of. */
const WORLD: MockedWorld = {
  servingVersion: 105,
  draftVersion: 106,
  engine: {
    type: "conversation-flow",
    engineId: "conversation_flow_2346a0e8367c",
    version: 106,
  },
  numbers: [
    {
      number: "+12567332874",
      pinned: false,
      bindings: [
        { agent_id: "agent_b0e2e9cb267c47e7e7026cd8e8", agent_version: "prod" },
      ],
    },
    {
      number: "+14155550199",
      pinned: true,
      bindings: [
        { agent_id: "agent_other", agent_version: "latest_published" },
        {
          agent_id: "agent_b0e2e9cb267c47e7e7026cd8e8",
          agent_version: "latest",
          weight: 2,
          a_field_egma_has_never_heard_of: "keep me",
        },
      ],
    },
  ],
  coverage: {
    mocked: ["get_availability", "book_appointment"],
    notInterceptable: ["transfer_to_front_desk", "text_directions"],
    notInThisVersion: ["inventory"],
  },
};

beforeAll(async () => {
  database = await createConnectedDatabase("retell-mocked-world");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
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
    [testId, acme.organization, acme.project, suiteId, testVersionId, newId("rev")],
  );
  await database.sql(
    `insert into test_version (id, test_id, version, content)
     values ($1, $2, 1, '{"scenario": "Books", "expectedBehaviors": ["confirms the time"]}'::jsonb)`,
    [testVersionId, testId],
  );
  await database.sql("commit");
});

afterAll(async () => {
  await database.drop();
});

describe("the coverage stamp's vocabulary", () => {
  /**
   * The three class names are written down twice on purpose — once where a
   * platform configuration is classified (`@egma/retell`) and once where the
   * record stores the result (`@egma/db`) — because the record must not depend
   * on a provider package. Two definitions can drift; this is the one line that
   * makes drift a failed build rather than a stamp whose two halves disagree
   * about what they are counting.
   */
  it("is the same three words in the package that classifies and the one that stores", () => {
    expect([...RECORD_CLASSES]).toEqual([...RETELL_CLASSES]);
  });
});

describe("the mock-tools tick", () => {
  it("is off on a new agent and reads back off it", async () => {
    const created = await createAgent(acting(), {
      name: "Untouched",
      agentPlatform: "retell",
    });
    expect(created.mockToolsDuringSimulations).toBe(false);
    const read = await getAgent(acting(), created.id);
    expect(read?.mockToolsDuringSimulations).toBe(false);
  });

  it("is refused on an agent with no platform identity and key", async () => {
    const created = await createAgent(acting(), {
      name: "No platform key",
      agentPlatform: "retell",
    });
    await expect(
      updateAgent(acting(), created.id, { mockToolsDuringSimulations: true }),
    ).rejects.toBeInstanceOf(AgentWriteRefusedError);
    // And the sentence says what to do about it rather than naming a column.
    await expect(
      updateAgent(acting(), created.id, { mockToolsDuringSimulations: true }),
    ).rejects.toThrow(/platform identity and key/u);
  });

  it("is accepted once the agent holds one, and turns off again", async () => {
    const created = await createAgent(acting(), {
      name: "Ticked",
      agentPlatform: "retell",
    });
    await sealPlatformKeyOn(created.id);

    const ticked = await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: true,
    });
    expect(ticked?.mockToolsDuringSimulations).toBe(true);
    expect((await getAgent(acting(), created.id))?.mockToolsDuringSimulations).toBe(
      true,
    );

    const renamed = await updateAgent(acting(), created.id, {
      name: "Ticked, renamed",
    });
    // A rename must never turn a mocked world off as a side effect.
    expect(renamed?.mockToolsDuringSimulations).toBe(true);

    const unticked = await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: false,
    });
    expect(unticked?.mockToolsDuringSimulations).toBe(false);
  });

  it("is refused by the database itself, not only by the factory", async () => {
    const created = await createAgent(acting(), {
      name: "Raw tick",
      agentPlatform: "retell",
    });
    const refused = await database
      .sql("update agent set mock_tools_during_simulations = true where id = $1", [
        created.id,
      ])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe(POSTGRES_ERROR.checkViolation);
  });
});

describe("the retell_web_call connection", () => {
  it("is creatable, and reads back with its own product label", async () => {
    const created = await createAgent(acting(), {
      name: "Web call agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      name: "Staging web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "key_retell_abcdefghijkl" },
    });

    expect(connection?.connectionType).toBe("retell_web_call");
    expect(connection?.modality).toBe("voice");
    expect(connection?.topology).toBe("hosted-broker");
    // The key is sealed and the hint is all that comes back.
    expect(connection?.credentialsHint).toBe("ijkl");

    const read = await getConnection(acting(), created.id, connection!.id);
    expect(read?.accessVariant).toBe("retell_web_call.api_key");
    expect(read?.config).toEqual({
      retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8",
    });
  });

  it("refuses chat, because a web call is WebRTC voice", async () => {
    const created = await createAgent(acting(), {
      name: "Web call chat attempt",
      agentPlatform: "retell",
    });
    await expect(
      addConnection(acting(), created.id, {
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_x" },
        credentials: { apiKey: "key_retell_abcdefghijkl" },
      }),
    ).rejects.toThrow(/speaks voice/u);
  });

  it("demands the Retell key, because the key is what opens the call", async () => {
    const created = await createAgent(acting(), {
      name: "Web call keyless",
      agentPlatform: "retell",
    });
    await expect(
      addConnection(acting(), created.id, {
        agentPlatform: "retell",
        connectionType: "retell_web_call",
        accessVariant: "retell_web_call.api_key",
        modality: "voice",
        config: { retellAgentId: "agent_x" },
      }),
    ).rejects.toThrow(/credentials/u);
  });
});

describe("the world a run built", () => {
  it("round-trips the temporary version and every binding verbatim", async () => {
    const created = await createAgent(acting(), {
      name: "World agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "key_retell_abcdefghijkl" },
    });
    const { runId } = await seedRun(created.id, connection!.id);

    expect((await getRun(acting(), runId))?.mockedWorld).toBeNull();

    await recordMockedWorld(acting(), runId, WORLD);
    const read = await getRun(acting(), runId);

    expect(read?.mockedWorld).toEqual(WORLD);
    // The whole point of "verbatim": a field egma never read still comes back.
    expect(read?.mockedWorld?.numbers[1]?.bindings[1]).toEqual({
      agent_id: "agent_b0e2e9cb267c47e7e7026cd8e8",
      agent_version: "latest",
      weight: 2,
      a_field_egma_has_never_heard_of: "keep me",
    });
  });

  it("can be cleared once the teardown has put everything back", async () => {
    const created = await createAgent(acting(), {
      name: "Torn down agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "key_retell_abcdefghijkl" },
    });
    const { runId } = await seedRun(created.id, connection!.id);

    await recordMockedWorld(acting(), runId, WORLD);
    await recordMockedWorld(acting(), runId, { ...WORLD, draftVersion: null });
    expect((await getRun(acting(), runId))?.mockedWorld?.draftVersion).toBeNull();
  });

  it("is the one thing a finished run may still be told", async () => {
    const created = await createAgent(acting(), {
      name: "Crashed run agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "key_retell_abcdefghijkl" },
    });
    const { runId } = await seedRun(created.id, connection!.id);
    await recordMockedWorld(acting(), runId, WORLD);

    // The run finishes without its teardown ever running.
    await database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [runId],
    );
    await database.sql(
      `update run
          set status = 'completed', finished_at = now(),
              completed_count = 1, failed_count = 0, canceled_count = 0
        where id = $1`,
      [runId],
    );

    // The sweep finishes it afterwards, and the record accepts that.
    await recordMockedWorld(acting(), runId, { ...WORLD, draftVersion: null });
    expect((await getRun(acting(), runId))?.mockedWorld?.draftVersion).toBeNull();

    // Everything else about a finished run is still frozen.
    const refused = await database
      .sql("update run set name = 'renamed after the fact' where id = $1", [runId])
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(String(refused)).toMatch(/written once/u);
  });
});

describe("the gate that keeps a mocked run honest", () => {
  /**
   * **A mocked run's simulations cannot be claimed until its world exists.**
   *
   * This is what makes "a run that cannot build its world fails before a single
   * simulation" true rather than merely intended. It is a condition on the
   * claim itself, so it is closed from the instant the rows are written — there
   * is no window between the run being created and the builder starting in
   * which a simulator could get in front of it.
   */
  it("holds a ticked agent's queued simulations back, and lets them go when the draft lands", async () => {
    const created = await createAgent(acting(), {
      name: "Gated agent",
      agentPlatform: "retell",
    });
    await sealPlatformKeyOn(created.id);
    const connection = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: true,
    });
    const { runId, simulationId } = await seedRun(created.id, connection!.id);

    const claimable = async (): Promise<readonly string[]> => {
      const rows = await database.sql<{ id: string }>(
        `select s.id
           from simulation s
           join run r on r.id = s.run_id
           join agent a on a.id = r.agent_id
          where s.status = 'queued'
            and s.run_id = $1
            and not (
              a.mock_tools_during_simulations = true
              and r.connection_snapshot->>'connectionType'
                    in ('retell_web_call', 'retell_chat_api')
              and (
                r.mocked_world is null
                or r.mocked_world->>'draftVersion' is null
              )
            )`,
        [runId],
      );
      return rows.rows.map((row) => row.id);
    };

    // Nothing yet: the world has not been recorded at all.
    expect(await claimable()).toEqual([]);

    // The capture, written before anything was branched. Still nothing —
    // a world with no temporary version in it is a world half built.
    await recordMockedWorld(acting(), runId, { ...WORLD, draftVersion: null });
    expect(await claimable()).toEqual([]);

    // The branch landed, and now the run is somebody's to conduct.
    await recordMockedWorld(acting(), runId, WORLD);
    expect(await claimable()).toEqual([simulationId]);
  });

  it("holds nothing back for a run that mocks nothing", async () => {
    const created = await createAgent(acting(), {
      name: "Unticked agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    const { runId, simulationId } = await seedRun(created.id, connection!.id);

    const rows = await database.sql<{ id: string }>(
      `select s.id
         from simulation s
         join run r on r.id = s.run_id
         join agent a on a.id = r.agent_id
        where s.status = 'queued'
          and s.run_id = $1
          and not (
            a.mock_tools_during_simulations = true
            and r.connection_snapshot->>'connectionType'
                  in ('retell_web_call', 'retell_chat_api')
            and (
              r.mocked_world is null
              or r.mocked_world->>'draftVersion' is null
            )
          )`,
      [runId],
    );
    // Which is every run in the product but a handful: the condition costs a
    // run that mocks nothing exactly nothing.
    expect(rows.rows.map((row) => row.id)).toEqual([simulationId]);
  });

  it("holds the gate through the real claim, not only a copy of its SQL", async () => {
    // The proof above reads a hand-written copy of the predicate. This one goes
    // through `claimSimulations` itself, so dropping `runIsReadyToConduct` from
    // the claim — the one line that closes the gate — fails a test rather than
    // passing quietly.
    const created = await createAgent(acting(), {
      name: "Claim-gated agent",
      agentPlatform: "retell",
    });
    await sealPlatformKeyOn(created.id);
    const connection = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: true,
    });
    const { runId, simulationId } = await seedRun(created.id, connection!.id);

    const claimedOur = async (): Promise<boolean> => {
      // A claimant of this test's own, and a capacity large enough that its
      // simulation is reached if it is eligible at all. Whatever else the queue
      // holds is claimed too and does not change this answer.
      const claims = await claimSimulations({
        claimant: `gate-proof-${runId}`,
        capacity: 50,
      });
      return claims.some((claim) => claim.id === simulationId);
    };

    // Ticked, mockable lane, no draft recorded: the real claim passes it over.
    expect(await claimedOur()).toBe(false);
    // The run stays pending, because nothing of its was claimed.
    expect((await getRun(acting(), runId))?.status).toBe("pending");

    // The draft lands, and now the real claim takes it.
    await recordMockedWorld(acting(), runId, WORLD);
    expect(await claimedOur()).toBe(true);
  });
});

/**
 * One mocked world per agent at a time.
 *
 * Two of these lifecycles overlapping on one agent is a hijack, not a queue:
 * one run's teardown restores a `latest` binding it captured while the other's
 * freshly branched draft is what `latest` then resolves to, and real callers
 * reach a mocked agent. Delete-before-restore protects a run from its own draft
 * and can see no other, so the overlap itself is refused.
 */
describe("the one mocked world an agent has at a time", () => {
  const STALE = 15 * 60 * 1000;

  /**
   * Walk a run to `completed`, one legal move at a time.
   *
   * The record's own trigger refuses `pending` straight to `completed`, so this
   * goes through `running` exactly as a real run does.
   */
  async function finishRun(runId: string): Promise<void> {
    await database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [runId],
    );
    // The three counts land together with the finish, as the record insists.
    await database.sql(
      `update run
          set status = 'completed', finished_at = now(),
              completed_count = 0, failed_count = 0, canceled_count = 0
        where id = $1`,
      [runId],
    );
  }

  /** A ticked agent with a web-call connection, ready to hold a world. */
  async function aTickedAgent(
    name: string,
  ): Promise<{ agentId: string; connectionId: string }> {
    const created = await createAgent(acting(), {
      name,
      agentPlatform: "retell",
    });
    await sealPlatformKeyOn(created.id);
    const connection = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: true,
    });
    return { agentId: created.id, connectionId: connection!.id };
  }

  it("refuses a second run while a live run holds the world, and names it", async () => {
    const created = await createAgent(acting(), {
      name: "Held agent",
      agentPlatform: "retell",
    });
    await sealPlatformKeyOn(created.id);
    const connection = await addConnection(acting(), created.id, {
      name: "Web call",
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    });
    await updateAgent(acting(), created.id, {
      mockToolsDuringSimulations: true,
    });

    // Run one builds its world and is conducting.
    const first = await seedRun(created.id, connection!.id);
    expect(
      await claimMockedWorldFor(acting(), {
        runId: first.runId,
        agentId: created.id,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
    await recordMockedWorld(acting(), first.runId, WORLD);

    // Run two arrives while run one still holds it.
    const second = await seedRun(created.id, connection!.id);
    const taken = await claimMockedWorldFor(acting(), {
      runId: second.runId,
      agentId: created.id,
      staleBuildMilliseconds: STALE,
    });

    expect(taken).toEqual({ kind: "taken", byRunId: first.runId });
    // And nothing was written onto the loser: it holds no world at all, so it
    // branched nothing and owes the account nothing.
    expect((await getRun(acting(), second.runId))?.mockedWorld).toBeNull();
  });

  it("lets exactly one of two simultaneous starts through", async () => {
    const { agentId, connectionId } = await aTickedAgent("Raced agent");

    const first = await seedRun(agentId, connectionId);
    const second = await seedRun(agentId, connectionId);

    // Started together, so the check-and-claim of each overlaps the other's.
    // Without the advisory lock both would read "nobody holds it" and build.
    const [one, two] = await Promise.all([
      claimMockedWorldFor(acting(), {
        runId: first.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
      claimMockedWorldFor(acting(), {
        runId: second.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ]);

    const winners = [one, two].filter((answer) => answer.kind === "claimed");
    const losers = [one, two].filter((answer) => answer.kind === "taken");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser names the winner, so its refusal can say which run to wait for.
    expect(losers[0]).toEqual({
      kind: "taken",
      byRunId: one.kind === "claimed" ? first.runId : second.runId,
    });
  });

  it("lets the next run build once the first has finished and settled", async () => {
    const { agentId, connectionId } = await aTickedAgent("Sequential agent");
    const first = await seedRun(agentId, connectionId);
    await claimMockedWorldFor(acting(), {
      runId: first.runId,
      agentId,
      staleBuildMilliseconds: STALE,
    });
    await recordMockedWorld(acting(), first.runId, WORLD);

    // It finishes and its teardown settles the world it owed.
    await finishRun(first.runId);
    await recordMockedWorld(acting(), first.runId, {
      ...WORLD,
      draftVersion: null,
      numbers: WORLD.numbers.map((one) => ({ ...one, pinned: false })),
    });

    const next = await seedRun(agentId, connectionId);
    expect(
      await claimMockedWorldFor(acting(), {
        runId: next.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
  });

  it("is not blocked by a finished run that never settled, nor by a dead build", async () => {
    const { agentId, connectionId } = await aTickedAgent("Littered agent");

    // A run that finished and left its draft behind: the sweep's job, never a
    // reason to refuse the next run.
    const crashed = await seedRun(agentId, connectionId);
    await recordMockedWorld(acting(), crashed.runId, WORLD);
    await finishRun(crashed.runId);

    // And a build whose process died: pending, no draft, older than the window.
    const dead = await seedRun(agentId, connectionId);
    await recordMockedWorld(acting(), dead.runId, {
      ...WORLD,
      draftVersion: null,
      numbers: [],
    });
    await database.sql(
      `update run set created_at = now() - interval '30 minutes' where id = $1`,
      [dead.runId],
    );

    const next = await seedRun(agentId, connectionId);
    expect(
      await claimMockedWorldFor(acting(), {
        runId: next.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
  });

  it("blocks on a run still inside its build window, which is not dead yet", async () => {
    const { agentId, connectionId } = await aTickedAgent("Building agent");

    // Pending, no draft, but young: a build in flight, not a dead one.
    const building = await seedRun(agentId, connectionId);
    await claimMockedWorldFor(acting(), {
      runId: building.runId,
      agentId,
      staleBuildMilliseconds: STALE,
    });

    const next = await seedRun(agentId, connectionId);
    expect(
      await claimMockedWorldFor(acting(), {
        runId: next.runId,
        agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "taken", byRunId: building.runId });
  });

  it("does not let one agent's world block another agent's run", async () => {
    const busy = await aTickedAgent("Busy agent");
    const held = await seedRun(busy.agentId, busy.connectionId);
    await claimMockedWorldFor(acting(), {
      runId: held.runId,
      agentId: busy.agentId,
      staleBuildMilliseconds: STALE,
    });
    await recordMockedWorld(acting(), held.runId, WORLD);

    // A different agent entirely: the lock is per agent, so this one is free.
    const free = await aTickedAgent("Free agent");
    const other = await seedRun(free.agentId, free.connectionId);
    expect(
      await claimMockedWorldFor(acting(), {
        runId: other.runId,
        agentId: free.agentId,
        staleBuildMilliseconds: STALE,
      }),
    ).toEqual({ kind: "claimed" });
  });
});

describe("the three-class coverage stamp", () => {
  it("round-trips the record's serialization", async () => {
    const created = await createAgent(acting(), {
      name: "Stamped agent",
      agentPlatform: "retell",
    });
    const connection = await addConnection(acting(), created.id, {
      agentPlatform: "retell",
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
      config: { retellAgentId: "agent_b0e2e9cb267c47e7e7026cd8e8" },
      credentials: { apiKey: "key_retell_abcdefghijkl" },
    });
    const { runId, simulationId } = await seedRun(created.id, connection!.id);
    await recordMockedWorld(acting(), runId, WORLD);

    // The simulation walks its own lifecycle, one legal move at a time.
    await database.sql(
      `update simulation
          set status = 'claimed', claimed_by = 'simulator-blue-1',
              claimed_at = now(), heartbeat_at = now()
        where id = $1`,
      [simulationId],
    );
    await database.sql(
      "update simulation set status = 'running', started_at = now() where id = $1",
      [simulationId],
    );
    await database.sql(
      "update run set status = 'running', started_at = now() where id = $1",
      [runId],
    );

    const mocked = await simulationMockedWorld(acting(), simulationId);
    expect(mocked?.world).toEqual(WORLD);
    // The run's frozen answers, resolved for this simulation's test version.
    expect(mocked?.answeredFor).toEqual(["get_availability"]);

    const stamp = coverageFromClasses(
      mocked!.world!.coverage,
      mocked!.answeredFor,
    );
    expect(stamp).toEqual({
      discovered: [
        "get_availability",
        "book_appointment",
        "transfer_to_front_desk",
        "text_directions",
        "inventory",
      ],
      covered: ["get_availability"],
      // `book_appointment` is intercepted and nobody authored an answer, so it
      // is uncovered and in neither class: the call was refused.
      uncovered: [
        "book_appointment",
        "transfer_to_front_desk",
        "text_directions",
        "inventory",
      ],
      notInterceptable: ["transfer_to_front_desk", "text_directions"],
      notInThisVersion: ["inventory"],
    });

    // A failed landing rather than a completed one, deliberately: both write
    // the stamp through the same path, and a completed landing also queues
    // grading work, which is another file's subject and would drag a grading
    // plan into a test about five lists.
    await failSimulation(acting(), simulationId, "simulator-blue-1", {
      reason: "simulator_error",
      turnCount: 6,
      mockToolCoverage: stamp,
      startedAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
    });

    expect((await getSimulation(acting(), simulationId))?.mockToolCoverage).toEqual(
      stamp,
    );
  });
});
