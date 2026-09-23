import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimSimulations,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  readAgentReport,
  recordAgentReport,
  reconcileGraderCatalog,
  registerSimulationProviderReference,
  resolveLiveDailyRoomSimulation,
  resolveSimulationStanding,
  startRun,
  startSimulation,
  type AuthContext,
  type SimulationClaim,
} from "../src/index.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * A Pipecat bot's SDK says hello to egma's server over HTTPS, naming its
 * simulation by provider reference — the simulation's own id, registered by
 * the simulator before the start request. These tests hold the store's half:
 * which simulation a reference names, where the hello is kept, and how the
 * simulator reads it back.
 */

let database: MigratedDatabase;
let suiteId: string;

const organizationId = newId("org");
const projectId = newId("prj");
const otherProjectId = newId("prj");
const userId = newId("usr");
const session: AuthContext = {
  organizationId,
  projectId,
  userId,
  role: "member",
  via: "session",
};
/** The project API key a bot's SDK holds. */
const projectKey: AuthContext = { ...session, via: "api_key" };
const SIMULATOR = "pipecat-report-simulator";

async function claimedPipecatSimulation(): Promise<{
  readonly claim: SimulationClaim;
  readonly conducting: AuthContext;
}> {
  const name = `pipecat-${newId("agt")}`;
  const created = await createAgent(session, {
    agentPlatform: "pipecat",
    name,
    connection: {
      agentPlatform: "pipecat",
      connectionType: "daily_room",
      accessVariant: "daily_room.pipecat_cloud",
      modality: "voice",
      config: { agentName: name },
      credentials: { publicApiKey: "pk_report_A1B2C3D4" },
    },
  });
  const started = await startRun(session, {
    suiteId,
    agentId: created.id,
    connectionId: created.connection?.id ?? "",
  });
  const claim = (await claimSimulations({ claimant: SIMULATOR, capacity: 50 }))
    .find((one) => one.runId === started.id);
  if (claim === undefined) throw new Error("the simulation was not claimed");
  const standing = await resolveSimulationStanding(claim.id);
  if (standing === undefined) throw new Error("the simulation has no standing");
  return { claim, conducting: standing.auth };
}

async function registered(): Promise<{
  readonly claim: SimulationClaim;
  readonly conducting: AuthContext;
}> {
  const conducted = await claimedPipecatSimulation();
  expect(
    await registerSimulationProviderReference(conducted.conducting, {
      simulationId: conducted.claim.id,
      claimant: SIMULATOR,
      providerReference: conducted.claim.id,
    }),
  ).toBe(true);
  return conducted;
}

beforeAll(async () => {
  database = await createConnectedDatabase("pipecat_agent_reports");
  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
    { id: otherProjectId, slug: "other" },
  ]);
  await seedUser(database, userId, "pipecat-reports@example.com");
  await reconcileGraderCatalog();
  const persona = await createPersona(session, {
    name: "Rita",
    identityName: "Rita Alvarez",
    personality: "Patient",
    language: "en-US",
  });
  suiteId = (await createTestSuite(session, { name: "Pipecat reports" })).id;
  await createTest(session, {
    suiteId,
    name: "Check the calendar",
    scenario: "Ask for a slot.",
    expectedBehaviors: ["offers a slot"],
    personaIds: [persona.id],
    mockTools: [
      { tool: "check_calendar", answer: { slots: [] } },
      { tool: "cancel_booking", error: "the calendar service is unavailable" },
    ],
  });
});

afterAll(async () => {
  await database.drop();
});

describe("registering a Pipecat simulation's provider reference", () => {
  it("takes the simulation's own id, and nothing shaped like a LiveKit room", async () => {
    const { claim, conducting } = await claimedPipecatSimulation();
    expect(
      await registerSimulationProviderReference(conducting, {
        simulationId: claim.id,
        claimant: SIMULATOR,
        providerReference: "egma-sim-0123456789abcdef",
      }),
    ).toBe(false);
    expect(
      await registerSimulationProviderReference(conducting, {
        simulationId: claim.id,
        claimant: "somebody-else",
        providerReference: claim.id,
      }),
    ).toBe(false);
    expect(
      await registerSimulationProviderReference(conducting, {
        simulationId: claim.id,
        claimant: SIMULATOR,
        providerReference: claim.id,
      }),
    ).toBe(true);
    const { rows } = await database.sql<{ provider_reference: string }>(
      "select provider_reference from simulation where id = $1",
      [claim.id],
    );
    expect(rows[0]?.provider_reference).toBe(claim.id);
  });
});

describe("which simulation a provider reference names", () => {
  it("names nothing before the simulator registered it", async () => {
    const { claim } = await claimedPipecatSimulation();
    await expect(resolveLiveDailyRoomSimulation(projectKey, claim.id)).resolves.toBeUndefined();
  });

  it("names a registered, conducting simulation with its pinned answers", async () => {
    const { claim } = await registered();
    await expect(resolveLiveDailyRoomSimulation(projectKey, claim.id)).resolves.toEqual({
      simulationId: claim.id,
      runId: claim.runId,
      agentId: claim.agentId,
      testVersionId: claim.testVersionId,
      answers: [
        { tool: "check_calendar", answer: { slots: [] } },
        { tool: "cancel_booking", error: "the calendar service is unavailable" },
      ],
    });
  });

  it("names nothing for another project's key, or an empty reference", async () => {
    const { claim } = await registered();
    await expect(
      resolveLiveDailyRoomSimulation({ ...projectKey, projectId: otherProjectId }, claim.id),
    ).resolves.toBeUndefined();
    await expect(resolveLiveDailyRoomSimulation(projectKey, "")).resolves.toBeUndefined();
  });

  it("names a running simulation, and nothing once its cancel is requested", async () => {
    const { claim, conducting } = await registered();
    await startSimulation(conducting, claim.id, SIMULATOR);
    await expect(resolveLiveDailyRoomSimulation(projectKey, claim.id)).resolves.toMatchObject({
      simulationId: claim.id,
    });
    await database.sql(
      "update simulation set cancel_requested_at = now() where id = $1",
      [claim.id],
    );
    await expect(resolveLiveDailyRoomSimulation(projectKey, claim.id)).resolves.toBeUndefined();
    expect(
      await recordAgentReport(projectKey, claim.id, {
        state: "accepted",
        tools: [],
        mockedTools: [],
      }),
    ).toBe(false);
  });
});

describe("the hello kept on the simulation", () => {
  it("is nothing until the SDK says hello, and nothing to a simulator that holds no claim", async () => {
    const { claim, conducting } = await registered();
    await expect(
      readAgentReport(conducting, { simulationId: claim.id, claimant: SIMULATOR }),
    ).resolves.toBeNull();
    await expect(
      readAgentReport(conducting, { simulationId: claim.id, claimant: "somebody-else" }),
    ).resolves.toBeUndefined();
    await expect(
      readAgentReport(session, { simulationId: claim.id, claimant: SIMULATOR }),
    ).resolves.toBeUndefined();
  });

  it("keeps the census and the mocked names, and the first acceptance time across repeats", async () => {
    const { claim, conducting } = await registered();
    const census = [
      { name: "check_calendar", schema: { type: "object" } },
      { name: "route_to_billing", flows: true as const },
    ];
    expect(
      await recordAgentReport(projectKey, claim.id, {
        state: "accepted",
        tools: census,
        mockedTools: ["check_calendar", "cancel_booking"],
      }),
    ).toBe(true);
    const first = await readAgentReport(conducting, {
      simulationId: claim.id,
      claimant: SIMULATOR,
    });
    expect(first).toMatchObject({
      state: "accepted",
      protocolVersion: 1,
      tools: census,
      mockedTools: ["check_calendar", "cancel_booking"],
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordAgentReport(projectKey, claim.id, {
      state: "accepted",
      tools: census.slice(0, 1),
      mockedTools: ["check_calendar", "cancel_booking"],
    });
    const second = await readAgentReport(conducting, {
      simulationId: claim.id,
      claimant: SIMULATOR,
    });
    expect(second?.state).toBe("accepted");
    if (first?.state !== "accepted" || second?.state !== "accepted") return;
    expect(second.firstAt).toBe(first.firstAt);
    expect(second.at >= first.at).toBe(true);
    expect(second.tools).toEqual(census.slice(0, 1));

    const { rows } = await database.sql<{ agent_report: Record<string, unknown> }>(
      "select agent_report from simulation where id = $1",
      [claim.id],
    );
    expect(Object.keys(rows[0]?.agent_report ?? {}).sort()).toEqual([
      "at",
      "first_at",
      "mocked_tools",
      "protocol_version",
      "state",
      "tools",
    ]);
  });

  it("keeps a refusal with its code and sentence, and a new attempt forgets it", async () => {
    const { claim, conducting } = await registered();
    const message =
      'the test mocks "route_to_billing", and this is a Pipecat Flows function; Egma cannot mock it yet. Remove it from the test\'s mock tools. Flows functions that are not mocked run for real and are recorded.';
    await recordAgentReport(projectKey, claim.id, {
      state: "refused",
      code: 905,
      message,
      tools: [{ name: "route_to_billing", flows: true }],
    });
    await expect(
      readAgentReport(conducting, { simulationId: claim.id, claimant: SIMULATOR }),
    ).resolves.toMatchObject({ state: "refused", code: 905, message });

    expect(
      await registerSimulationProviderReference(conducting, {
        simulationId: claim.id,
        claimant: SIMULATOR,
        providerReference: claim.id,
      }),
    ).toBe(true);
    await expect(
      readAgentReport(conducting, { simulationId: claim.id, claimant: SIMULATOR }),
    ).resolves.toBeNull();
  });
});
