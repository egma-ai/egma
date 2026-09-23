import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  AgentWriteRefusedError,
  createAgent,
  listConnections,
  registerAgent,
  updateConnection,
  type AuthContext,
  type NewAgent,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Pipecat as stored: migration 0009 widens the allowed values, and the access
 * layer admits a Daily room connection on both of its variants. Rows through
 * the module where the module is the seam; raw SQL only where the database
 * itself is the thing asked.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingAsAcme(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "session",
  };
}

const CLOUD = {
  agentPlatform: "pipecat",
  connectionType: "daily_room",
  accessVariant: "daily_room.pipecat_cloud",
} as const;
const SELF_HOSTED = {
  agentPlatform: "pipecat",
  connectionType: "daily_room",
  accessVariant: "daily_room.self_hosted",
} as const;
const PUBLIC_KEY = "pk_live_1a2b3c4d5e6f7g8h";
const HEADERS = '{"X-Egma-Dev-Secret":"s3cr3t-value-0001"}';

beforeAll(async () => {
  database = await createConnectedDatabase("pipecat");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("the database after migration 0009", () => {
  it("admits a Pipecat agent and a Daily room connection on both variants", async () => {
    const agentId = newId("agt");
    await database.sql(
      `insert into agent (id, organization_id, project_id, name, agent_platform)
       values ($1, $2, $3, 'Raw Pipecat', 'pipecat')`,
      [agentId, acme.organization, acme.project],
    );
    for (const [name, variant, modality] of [
      ["raw-cloud", "daily_room.pipecat_cloud", "voice"],
      ["raw-self", "daily_room.self_hosted", "chat"],
    ] as const) {
      await database.sql(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, connection_type, access_variant, modality, topology, config)
         values ($1, $2, $3, $4, $5, 'daily_room', $6, $7, 'hosted-broker', '{}')`,
        [newId("con"), acme.organization, acme.project, agentId, name, variant, modality],
      );
    }
  });

  it("still refuses a platform nobody supports", async () => {
    await expect(
      database.sql(
        `insert into agent (id, organization_id, project_id, name, agent_platform)
         values ($1, $2, $3, 'Unknown', 'vapi')`,
        [newId("agt"), acme.organization, acme.project],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.checkViolation,
    );
  });

  it("widens the four allowed-value checks and keeps every value stored before", async () => {
    const { rows } = await database.sql<{ name: string; definition: string }>(
      `select conname as name, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname = any($1::text[])
        order by conname`,
      [[
        "agent_platform_allowed",
        "connection_access_variant_allowed",
        "connection_type_allowed",
        "simulation_connection_type_allowed",
      ]],
    );
    const definitionOf = (name: string) =>
      rows.find((row) => row.name === name)?.definition ?? "";

    expect(definitionOf("agent_platform_allowed")).toContain("'pipecat'");
    expect(definitionOf("agent_platform_allowed")).toContain("'livekit'");
    for (const name of ["connection_type_allowed", "simulation_connection_type_allowed"]) {
      expect(definitionOf(name)).toContain("'daily_room'");
      // A retired lane's historical rows stay valid.
      expect(definitionOf(name)).toContain("'retell_chat_api'");
      expect(definitionOf(name)).toContain("'livekit_room'");
    }
    expect(definitionOf("connection_access_variant_allowed")).toContain(
      "'daily_room.pipecat_cloud'",
    );
    expect(definitionOf("connection_access_variant_allowed")).toContain(
      "'daily_room.self_hosted'",
    );
    expect(definitionOf("connection_access_variant_allowed")).toContain(
      "'retell_chat_api.api_key'",
    );
  });

  it("holds the SDK's latest report on the simulation row, as an object or nothing", async () => {
    const { rows } = await database.sql<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'simulation'
          and column_name = 'agent_report'`,
    );
    expect(rows).toEqual([
      { data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    const { rows: checks } = await database.sql<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint where conname = 'simulation_agent_report_is_object'`,
    );
    expect(checks[0]?.definition).toContain("jsonb_typeof(agent_report) = 'object'");
  });
});

describe("adding a Pipecat connection", () => {
  it("stores a Pipecat Cloud connection with a last-four hint and a default name", async () => {
    const agent = await createAgent(actingAsAcme(), {
      name: "Front desk bot",
      agentPlatform: "pipecat",
    });
    const voice = await addConnection(actingAsAcme(), agent.id, {
      ...CLOUD,
      modality: "voice",
      config: { agentName: "lakeside-front-desk" },
      credentials: { publicApiKey: PUBLIC_KEY },
    });
    const chat = await addConnection(actingAsAcme(), agent.id, {
      ...CLOUD,
      modality: "chat",
      config: { agentName: "lakeside-front-desk" },
      credentials: { publicApiKey: PUBLIC_KEY },
    });

    expect(voice).toMatchObject({
      name: "pipecat_voice-1",
      agentPlatform: "pipecat",
      connectionType: "daily_room",
      accessVariant: "daily_room.pipecat_cloud",
      modality: "voice",
      topology: "hosted-broker",
      productLabel: "Pipecat Cloud",
      config: { agentName: "lakeside-front-desk" },
      credentialsHint: "7g8h",
    });
    expect(chat).toMatchObject({
      name: "pipecat_chat-1",
      productLabel: "Pipecat Cloud chat",
    });

    const { rows } = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [voice?.id],
    );
    expect(rows[0]?.credentials).toMatch(/^v1\./);
    expect(rows[0]?.credentials).not.toContain(PUBLIC_KEY);
  });

  it("stores a self-hosted connection with the header names as its hint", async () => {
    const agent = await createAgent(actingAsAcme(), {
      name: "Self-hosted bot",
      agentPlatform: "pipecat",
    });
    const connection = await addConnection(actingAsAcme(), agent.id, {
      ...SELF_HOSTED,
      modality: "voice",
      config: { startUrl: "https://bots.lakeside.example/start" },
      credentials: { headers: HEADERS },
    });
    expect(connection).toMatchObject({
      name: "pipecat_voice-1",
      productLabel: "Pipecat self-hosted",
      config: { startUrl: "https://bots.lakeside.example/start" },
      credentialsHint: "X-Egma-Dev-Secret",
    });
  });

  it("refuses a Daily room on a LiveKit agent", async () => {
    const agent = await createAgent(actingAsAcme(), {
      name: "A LiveKit worker",
      agentPlatform: "livekit",
    });
    await expect(
      addConnection(actingAsAcme(), agent.id, {
        ...CLOUD,
        agentPlatform: "livekit",
        modality: "voice",
        config: { agentName: "front-desk" },
        credentials: { publicApiKey: PUBLIC_KEY },
      }),
    ).rejects.toBeInstanceOf(AgentWriteRefusedError);
  });

  it("replaces the start URL and the headers of a this-machine connection in one edit", async () => {
    const agent = await createAgent(actingAsAcme(), {
      name: "Laptop bot",
      agentPlatform: "pipecat",
    });
    const connection = await addConnection(actingAsAcme(), agent.id, {
      ...SELF_HOSTED,
      name: "dev-laptop-voice",
      modality: "voice",
      config: { startUrl: "https://first-tunnel-1234.trycloudflare.com/start" },
      credentials: { headers: HEADERS },
    });
    const updated = await updateConnection(
      actingAsAcme(),
      agent.id,
      connection?.id ?? "",
      {
        config: { startUrl: "https://second-tunnel-5678.trycloudflare.com/start" },
        credentials: { headers: '{"X-Egma-Dev-Secret":"another-secret-0002"}' },
      },
    );
    expect(updated).toMatchObject({
      name: "dev-laptop-voice",
      config: { startUrl: "https://second-tunnel-5678.trycloudflare.com/start" },
      credentialsHint: "X-Egma-Dev-Secret",
    });
  });
});

describe("registering a Pipecat agent twice", () => {
  function pipecatRegistration(overrides: {
    readonly name: string;
    readonly modality: "voice" | "chat";
    readonly config: Record<string, string>;
    readonly credentials: Record<string, string>;
    readonly variant: "daily_room.pipecat_cloud" | "daily_room.self_hosted";
  }): NewAgent {
    return {
      name: overrides.name,
      agentPlatform: "pipecat",
      connection: {
        agentPlatform: "pipecat",
        connectionType: "daily_room",
        accessVariant: overrides.variant,
        modality: overrides.modality,
        config: overrides.config,
        credentials: overrides.credentials,
      },
    };
  }

  it("adds the chat connection to the agent the voice one made, by Pipecat Cloud agent name", async () => {
    const first = await registerAgent(
      actingAsAcme(),
      pipecatRegistration({
        name: "Billing bot",
        modality: "voice",
        variant: "daily_room.pipecat_cloud",
        config: { agentName: "billing-bot" },
        credentials: { publicApiKey: PUBLIC_KEY },
      }),
    );
    const second = await registerAgent(
      actingAsAcme(),
      pipecatRegistration({
        name: "Billing bot",
        modality: "chat",
        variant: "daily_room.pipecat_cloud",
        config: { agentName: "billing-bot" },
        credentials: { publicApiKey: PUBLIC_KEY },
      }),
    );
    expect(first.result).toBe("created");
    expect(second.result).toBe("connection_added");
    expect(second.agent.id).toBe(first.agent.id);
    const connections = await listConnections(actingAsAcme(), first.agent.id);
    expect((connections ?? []).map((one) => one.name).sort()).toEqual([
      "pipecat_chat-1",
      "pipecat_voice-1",
    ]);
  });

  it("knows a self-hosted starter by host and path, not by its query", async () => {
    const first = await registerAgent(
      actingAsAcme(),
      pipecatRegistration({
        name: "Starter bot",
        modality: "voice",
        variant: "daily_room.self_hosted",
        config: { startUrl: "https://starter.example.com/start?token=a" },
        credentials: { headers: HEADERS },
      }),
    );
    const again = await registerAgent(
      actingAsAcme(),
      pipecatRegistration({
        name: "Starter bot",
        modality: "voice",
        variant: "daily_room.self_hosted",
        config: { startUrl: "https://STARTER.example.com./start?token=b" },
        credentials: { headers: HEADERS },
      }),
    );
    expect(again.result).toBe("reused");
    expect(again.agent.id).toBe(first.agent.id);
  });
});
