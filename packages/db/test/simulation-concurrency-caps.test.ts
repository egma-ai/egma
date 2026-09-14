import { newId } from "@egma/ids";
import {
  claimSimulations,
  completeSimulation,
  createAgent,
  createPersona,
  createTest,
  createTestSuite,
  editPersona,
  estimateVoiceSimulationDemand,
  getSimulation,
  listSimulations,
  startRun,
  startSimulation,
  type AuthContext,
  type PersonaModels,
} from "@egma/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

let database: MigratedDatabase;

const organizationId = newId("org");
const projectId = newId("prj");
const userId = newId("usr");
const auth: AuthContext = {
  userId,
  organizationId,
  projectId,
  role: "member",
  via: "session",
};

const CARTESIA: PersonaModels = {
  mode: "separate",
  llm: { provider: "openai", model: "gpt-5.6-terra" },
  stt: { provider: "cartesia", model: "ink-2" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
};

const OPENAI: PersonaModels = {
  mode: "separate",
  llm: { provider: "openai", model: "gpt-5.6-terra" },
  stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
  tts: {
    provider: "openai",
    model: "gpt-4o-mini-tts-2025-12-15",
    voiceId: "alloy",
    speed: 1,
  },
};

let voiceAgentId: string;
let voiceConnectionId: string;
let chatAgentId: string;
let chatConnectionId: string;
let personaId: string;
let suiteId: string;

async function queued(modality: "voice" | "chat", models = OPENAI, concurrency?: number): Promise<string> {
  await editPersona(auth, personaId, { models });
  const started = await startRun(auth, {
    suiteId,
    ...(concurrency === undefined ? {} : { concurrency }),
    agentId: modality === "voice" ? voiceAgentId : chatAgentId,
    connectionId: modality === "voice" ? voiceConnectionId : chatConnectionId,
  });
  const item = (await listSimulations(auth, started.id))?.items[0];
  if (item === undefined) throw new Error("the run has no simulation");
  return item.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("simulation_concurrency_caps");
  await seedOrganization(database, organizationId, [{ id: projectId, slug: "default" }]);
  await seedUser(database, userId, "caps@example.test");

  const voice = await createAgent(auth, {
    agentPlatform: "livekit",
    name: "Voice worker",
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "voice",
      config: { url: "wss://acme.livekit.cloud", agentName: "front-desk" },
      credentials: {
        apiKey: "livekit-key-A1B2C3D4WXYZ",
        apiSecret: "livekit-secret-E5F6G7H8QRST",
      },
    },
  });
  voiceAgentId = voice.id;
  voiceConnectionId = voice.connection?.id ?? "";

  const chat = await createAgent(auth, {
    agentPlatform: "livekit",
    name: "Chat worker",
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: "chat",
      config: { url: "wss://test.livekit.cloud", agentName: "agent_caps_test" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ", apiSecret: "livekit-secret-A1B2C3D4WXYZ" },
    },
  });
  chatAgentId = chat.id;
  chatConnectionId = chat.connection?.id ?? "";

  personaId = (await createPersona(auth, {
    name: "Caller",
    identityName: "Alex Morgan",
    personality: "Speaks plainly.",
    language: "en-US",
    models: OPENAI,
  })).id;
  suiteId = (await createTestSuite(auth, { name: "Fleet caps" })).id;
  await createTest(auth, {
    suiteId,
    name: "Books an appointment",
    scenario: "Book the next available appointment.",
    expectedBehaviors: ["confirms the appointment"],
    personaIds: [personaId],
  });
});

afterEach(async () => {
  await database.sql("delete from run where project_id = $1", [projectId]);
});

afterAll(async () => {
  await database.drop();
});

describe("fleet claim selection", () => {
  it("holds independent voice and chat pools at one hundred and refills ten", async () => {
    const expand = async (sourceId: string): Promise<void> => {
      const ids = Array.from({ length: 109 }, () => newId("sim")).sort();
      await database.sql(
        `insert into simulation
         select populated.*
           from simulation source
           cross join unnest($2::text[], $3::integer[]) as clone(id, position)
           cross join lateral jsonb_populate_record(
             null::simulation,
             to_jsonb(source) || jsonb_build_object('id', clone.id, 'position', clone.position)
           ) as populated
          where source.id = $1`,
        [sourceId, ids, ids.map((_, index) => index + 2)],
      );
    };
    await expand(await queued("voice", OPENAI, 110));
    await expand(await queued("chat", OPENAI, 110));
    const caps = { voice: 100, chat: 100 } as const;

    const filled = await Promise.all([
      claimSimulations({ claimant: "voice-1", capacity: 50, modalities: ["voice"], caps }),
      claimSimulations({ claimant: "voice-2", capacity: 50, modalities: ["voice"], caps }),
      claimSimulations({ claimant: "chat-1", capacity: 50, modalities: ["chat"], caps }),
      claimSimulations({ claimant: "chat-2", capacity: 50, modalities: ["chat"], caps }),
    ]);
    const voice = filled.flat().filter((claim) => claim.modality === "voice");
    const chat = filled.flat().filter((claim) => claim.modality === "chat");
    expect({ voice: voice.length, chat: chat.length }).toEqual({ voice: 100, chat: 100 });

    await Promise.all([...voice.slice(0, 10), ...chat.slice(0, 10)].map(async (claim) => {
      await startSimulation(claim.auth, claim.id, claim.claimedBy);
      await completeSimulation(claim.auth, claim.id, claim.claimedBy, {
        endingReason: "persona_concluded",
      });
    }));
    const refill = await Promise.all([
      claimSimulations({ claimant: "voice-refill", capacity: 50, modalities: ["voice"], caps }),
      claimSimulations({ claimant: "chat-refill", capacity: 50, modalities: ["chat"], caps }),
    ]);
    expect(refill.map((claims) => claims.length)).toEqual([10, 10]);
  });

  it("claims only requested modalities without changing omission behavior", async () => {
    const chat = await queued("chat");
    const voice = await queued("voice");

    const claims = await claimSimulations({
      claimant: "voice-one-shot",
      capacity: 1,
      modalities: ["voice"],
    });

    expect(claims.map((claim) => claim.id)).toEqual([voice]);
    expect((await getSimulation(auth, chat))?.status).toBe("queued");
  });

  it("does not resolve provider settings when no cap can use them", async () => {
    const valid = await queued("voice");
    const malformed = newId("sim");
    await database.sql(
      "alter table simulation disable trigger simulation_persona_parameters_guard",
    );
    try {
      await database.sql(
        `insert into simulation
         select populated.*
           from simulation source
           cross join lateral jsonb_populate_record(
             null::simulation,
             to_jsonb(source) || jsonb_build_object(
               'id', $2::text,
               'position', 2,
               'persona_parameter_values', '{}'::jsonb
             )
           ) as populated
          where source.id = $1`,
        [valid, malformed],
      );
    } finally {
      await database.sql(
        "alter table simulation enable trigger simulation_persona_parameters_guard",
      );
    }

    const claims = await claimSimulations({
      claimant: "standing-self-hosted",
      capacity: 2,
      modalities: ["voice"],
    });

    expect(claims.map((claim) => claim.id)).toEqual([valid, malformed]);
  });

  it("counts one provider once per simulation and exposes the same demand decision", async () => {
    const first = await queued("voice", CARTESIA);
    const second = await queued("voice", CARTESIA);
    const third = await queued("voice", CARTESIA);
    const caps = { speechProviders: { cartesia: 2 } } as const;

    const claimed = await claimSimulations({
      claimant: "cartesia-pool",
      capacity: 2,
      modalities: ["voice"],
      caps,
    });
    expect(claimed.map((claim) => claim.id)).toEqual([first, second]);
    expect(await estimateVoiceSimulationDemand({ caps })).toEqual({
      active: 2,
      admissibleQueued: 0,
    });
    expect((await getSimulation(auth, third))?.status).toBe("queued");
  });

  it("uses each run's pinned values after persona settings change", async () => {
    const cartesia = await queued("voice", CARTESIA);
    await claimSimulations({
      claimant: "cartesia-active",
      capacity: 1,
      modalities: ["voice"],
      caps: { speechProviders: { cartesia: 1 } },
    });
    const blocked = await queued("voice", CARTESIA);
    const openai = await queued("voice", OPENAI);

    const claimed = await claimSimulations({
      claimant: "next-provider",
      capacity: 1,
      modalities: ["voice"],
      caps: { speechProviders: { cartesia: 1, openai: 1 } },
    });

    expect((await getSimulation(auth, cartesia))?.status).toBe("claimed");
    expect((await getSimulation(auth, blocked))?.status).toBe("queued");
    expect(claimed.map((claim) => claim.id)).toEqual([openai]);
  });

  it("serializes concurrent cap admissions", async () => {
    await queued("voice");
    await queued("voice");

    const fleet = await Promise.all([
      claimSimulations({
        claimant: "voice-a",
        capacity: 1,
        modalities: ["voice"],
        caps: { voice: 1 },
      }),
      claimSimulations({
        claimant: "voice-b",
        capacity: 1,
        modalities: ["voice"],
        caps: { voice: 1 },
      }),
    ]);

    expect(fleet.flat()).toHaveLength(1);
  });

  it("enforces the chat cap across concurrent claimants", async () => {
    await queued("chat");
    await queued("chat");

    const fleet = await Promise.all([
      claimSimulations({
        claimant: "chat-a",
        capacity: 1,
        modalities: ["chat"],
        caps: { chat: 1 },
      }),
      claimSimulations({
        claimant: "chat-b",
        capacity: 1,
        modalities: ["chat"],
        caps: { chat: 1 },
      }),
    ]);

    expect(fleet.flat()).toHaveLength(1);
  });

  it("scans past 500 capped rows for admissible work", async () => {
    await queued("voice", CARTESIA);
    await claimSimulations({
      claimant: "cartesia-active",
      capacity: 1,
      modalities: ["voice"],
      caps: { speechProviders: { cartesia: 1 } },
    });
    const firstBlocked = await queued("voice", CARTESIA);
    const cloneIds = Array.from({ length: 499 }, () => newId("sim")).sort();
    await database.sql(
      `insert into simulation
       select populated.*
         from simulation source
         cross join unnest($2::text[], $3::integer[]) as clone(id, position)
         cross join lateral jsonb_populate_record(
           null::simulation,
           to_jsonb(source) || jsonb_build_object('id', clone.id, 'position', clone.position)
         ) as populated
        where source.id = $1`,
      [firstBlocked, cloneIds, cloneIds.map((_, index) => index + 2)],
    );
    const openai = await queued("voice", OPENAI);

    const demand = await estimateVoiceSimulationDemand({
      caps: { speechProviders: { cartesia: 1, openai: 1 } },
    });
    const claimed = await claimSimulations({
      claimant: "scan-past-cap",
      capacity: 1,
      modalities: ["voice"],
      caps: { speechProviders: { cartesia: 1, openai: 1 } },
    });

    expect(demand).toEqual({ active: 1, admissibleQueued: 1 });
    expect(claimed.map((claim) => claim.id)).toEqual([openai]);
  });
});

async function queuedRun(modality: "voice" | "chat", concurrency?: number, count = 7) {
  const suite = await createTestSuite(auth, { name: "Concurrency tests" });
  for (let index = 0; index < count; index += 1) {
    await createTest(auth, {
      suiteId: suite.id, name: `Test ${index}`,
      scenario: "Book an appointment.", expectedBehaviors: ["Confirms the time"],
      personaIds: [personaId],
    });
  }
  return startRun(auth, {
    suiteId: suite.id,
    agentId: modality === "voice" ? voiceAgentId : chatAgentId,
    connectionId: modality === "voice" ? voiceConnectionId : chatConnectionId,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
}

describe("per-run concurrency", () => {
  it.each(["voice", "chat"] as const)("applies the %s default across simultaneous workers and refills freed slots", async (modality) => {
    const expected = modality === "voice" ? 4 : 10;
    const run = await queuedRun(modality, undefined, expected + 3);
    expect(run.concurrency).toBe(expected);
    if (modality === "voice") {
      expect(await estimateVoiceSimulationDemand()).toEqual({ active: 0, admissibleQueued: 4 });
    }
    const claims = (await Promise.all([
      claimSimulations({ claimant: "first", capacity: 10 }),
      claimSimulations({ claimant: "second", capacity: 10 }),
    ])).flat();
    expect(claims).toHaveLength(expected);
    expect(new Set(claims.map((claim) => claim.id)).size).toBe(expected);
    const claim = claims[0]!;
    await startSimulation(claim.auth, claim.id, claim.claimedBy);
    expect(await claimSimulations({ claimant: "blocked", capacity: 10 })).toHaveLength(0);
    await completeSimulation(claim.auth, claim.id, claim.claimedBy, { endingReason: "persona_concluded" });
    expect(await claimSimulations({ claimant: "refill", capacity: 10 })).toHaveLength(1);
  });

  it.each(["voice", "chat"] as const)("admits all seven %s simulations with concurrency 100", async (modality) => {
    const run = await queuedRun(modality, 100);
    expect(run.concurrency).toBe(100);
    expect(run.expectedSimulationCount).toBe(7);
    expect(await claimSimulations({ claimant: "all-seven", capacity: 50 })).toHaveLength(7);
  });

  it("keeps run limits independent while respecting deployment caps", async () => {
    const first = await queuedRun("voice", 1);
    const second = await queuedRun("voice", 3);
    const claims = await claimSimulations({ claimant: "shared", capacity: 20, caps: { voice: 3 } });
    expect(claims).toHaveLength(3);
    expect(claims.filter((claim) => claim.runId === first.id)).toHaveLength(1);
    expect(claims.filter((claim) => claim.runId === second.id)).toHaveLength(2);
    expect(await estimateVoiceSimulationDemand({ caps: { voice: 3 } })).toEqual({ active: 3, admissibleQueued: 0 });
  });

  it("rejects invalid limits and freezes the chosen limit", async () => {
    for (const concurrency of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
      await expect(startRun(auth, { suiteId, agentId: voiceAgentId, connectionId: voiceConnectionId, concurrency })).rejects.toThrow("concurrency");
    }
    const run = await queuedRun("voice", 2);
    await expect(database.sql("update run set concurrency = 3 where id = $1", [run.id])).rejects.toThrow("concurrency");
  });
});
