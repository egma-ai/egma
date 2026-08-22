import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  createAgent,
  archiveAgent,
  getConnection,
  listConnections,
  NotPermittedError,
  archiveConnection,
  updateConnection,
  type AuthContext,
  type NewConnection,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Every assertion goes through the factory functions — the seam — except the
 * reads of the raw `credentials` column, which bypass the module on purpose:
 * the whole claim under test is that what the module writes is ciphertext and
 * what it answers never includes it, and only a read the module cannot dress
 * up can say so.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  secondProject: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const grace = newId("usr");

function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
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

/** A live retell payload, spread-and-overridden by the case at hand. */
function retellConnection(overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    name: `retell-${newId("con").slice(-8)}`,
    agentPlatform: "retell",
    connectionType: "retell_chat_api",
    accessVariant: "retell_chat_api.api_key",
    modality: "chat",
    config: { retellAgentId: "agent_in_retell_1" },
    credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    ...overrides,
  };
}

/**
 * A live livekit payload. The credential halves carry distinct tails so a
 * hint, an envelope and a resolved pair can each be told apart at a glance.
 */
function livekitConnection(overrides: Partial<NewConnection> = {}): NewConnection {
  return {
    name: `livekit-${newId("con").slice(-8)}`,
    agentPlatform: "livekit_agents",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    modality: "voice",
    config: { url: "wss://acme.livekit.cloud" },
    credentials: {
      apiKey: "livekit-key-A1B2C3D4WXYZ",
      apiSecret: "livekit-secret-E5F6G7H8QRST",
    },
    ...overrides,
  };
}

async function agentNamed(name: string): Promise<string> {
  const created = await createAgent(actingAsAcme(), { name });
  return created.id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("connections");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.secondProject, slug: "outbound" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, grace, "grace@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("adding a connection", () => {
  it("returns a con_ id and fetch round-trips every non-secret field", async () => {
    const agentId = await agentNamed("Round Trip");

    const added = await addConnection(actingAsAcme(), agentId, {
      name: "staging",
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
      credentials: { apiKey: "sk-retell-000011112222WXYZ" },
    });

    expect(added).toBeDefined();
    expect(isId("con", added?.id ?? "")).toBe(true);

    const fetched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(fetched).toMatchObject({
      agentId,
      name: "staging",
      agentPlatform: "retell",
      connectionType: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      productLabel: "Retell chat",
      modality: "chat",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
      credentialsHint: "WXYZ",
    });
  });

  it("derives the topology from the type, so a phone connection dials in", async () => {
    const agentId = await agentNamed("Topology");

    const added = await addConnection(actingAsAcme(), agentId, {
      name: "production-line",
      agentPlatform: null,
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
      config: { phoneNumber: "+15551234567" },
    });

    expect(added?.topology).toBe("egma-dials-in");
    expect(added?.credentialsHint).toBeNull();
  });

  it("defaults the name from the type, and again for the next one", async () => {
    const agentId = await agentNamed("Unnamed");

    const first = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: undefined }),
    );
    const second = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: undefined }),
    );

    expect(first?.name).toBe("retell_chat_api-1");
    expect(second?.name).toBe("retell_chat_api-2");
  });

  it("is allowed to a member and refused to a viewer", async () => {
    const agentId = await agentNamed("Permissions");

    await expect(
      addConnection(actingAsAcme("viewer"), agentId, retellConnection()),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("what the registry refuses at the door, by name", () => {
  it("refuses phone + chat: a phone connection speaks voice", async () => {
    const agentId = await agentNamed("Modality Rules");

    await expect(
      addConnection(actingAsAcme(), agentId, {
        name: "impossible",
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "chat",
        config: { phoneNumber: "+15551234567" },
      }),
    ).rejects.toThrow(/phone_number connection speaks voice/);
  });

  it("refuses an unknown config key by its name", async () => {
    const agentId = await agentNamed("Config Typo");

    await expect(
      addConnection(
        actingAsAcme(),
        agentId,
        retellConnection({
          config: { retellAgentId: "agent_abc", retellAgentld: "typo" },
        }),
      ),
    ).rejects.toThrow(/"retellAgentld"/);
  });

  it("refuses a retell connection missing retellAgentId, naming it", async () => {
    const agentId = await agentNamed("Config Missing");

    await expect(
      addConnection(actingAsAcme(), agentId, retellConnection({ config: {} })),
    ).rejects.toThrow(/retellAgentId/);
  });

  it("refuses a phone number that is not E.164", async () => {
    const agentId = await agentNamed("Bad Number");

    await expect(
      addConnection(actingAsAcme(), agentId, {
        name: "landline",
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "555-1234" },
      }),
    ).rejects.toThrow(/E\.164/);
  });

  it("refuses a credential on a phone connection rather than ignoring it", async () => {
    const agentId = await agentNamed("Uncredentialed");

    await expect(
      addConnection(actingAsAcme(), agentId, {
        name: "with-secret",
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
        credentials: { apiKey: "should-not-be-here" },
      }),
    ).rejects.toThrow(/takes no credential/);

    // Refused means not stored: nothing landed under that name.
    expect(await listConnections(actingAsAcme(), agentId)).toEqual([]);
  });

  it("refuses a retell connection with no credentials at all", async () => {
    const agentId = await agentNamed("Keyless");

    await expect(
      addConnection(
        actingAsAcme(),
        agentId,
        retellConnection({ credentials: undefined }),
      ),
    ).rejects.toThrow(/needs credentials/);
  });

  it("refuses a credential so short its last-4 hint would give it away", async () => {
    const agentId = await agentNamed("Tiny Secret");

    await expect(
      addConnection(
        actingAsAcme(),
        agentId,
        retellConnection({ credentials: { apiKey: "abcd" } }),
      ),
    ).rejects.toThrow(/at least 8 characters/);
  });
});

/**
 * The livekit type end to end through the store. What a payload is allowed to
 * say is the registry's story and is checked where the registry lives, with no
 * database in the way; what is here is only what a row can prove — that the
 * type lands, that its topology is derived, and that both credential halves go
 * in sealed and come back only through the one door.
 */
describe("a livekit connection", () => {
  it("lands with url alone, dialling out, and reads back with the hint", async () => {
    const agentId = await agentNamed("LiveKit Bare");

    const added = await addConnection(
      actingAsAcme(),
      agentId,
      livekitConnection({ name: "quickstart" }),
    );

    const fetched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(fetched).toMatchObject({
      name: "quickstart",
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      productLabel: "LiveKit project credentials",
      modality: "voice",
      // Derived from the type: the agent joins the room egma opened.
      topology: "agent-dials-out",
      config: { url: "wss://acme.livekit.cloud" },
      // The last four of the key, never of the secret.
      credentialsHint: "WXYZ",
    });
    expect(fetched).not.toHaveProperty("credentials");
  });

  it("lands with an agent name and metadata too, both read back whole", async () => {
    const agentId = await agentNamed("LiveKit Dispatched");

    const added = await addConnection(
      actingAsAcme(),
      agentId,
      livekitConnection({
        config: {
          url: "wss://acme.livekit.cloud",
          agentName: "front-desk",
          metadata: '{"tenant":"acme"}',
        },
      }),
    );

    expect(added?.config).toEqual({
      url: "wss://acme.livekit.cloud",
      agentName: "front-desk",
      metadata: '{"tenant":"acme"}',
    });
  });

  it("defaults its name from the type, like every other", async () => {
    const agentId = await agentNamed("LiveKit Unnamed");

    const first = await addConnection(
      actingAsAcme(),
      agentId,
      livekitConnection({ name: undefined }),
    );
    expect(first?.name).toBe("livekit_room-1");
  });

  it("seals both halves, and neither is in the row", async () => {
    const agentId = await agentNamed("LiveKit Sealed");
    const added = await addConnection(actingAsAcme(), agentId, livekitConnection());

    const { rows } = await database.sql<{
      credentials: string;
      credentials_hint: string;
    }>("select credentials, credentials_hint from connection where id = $1", [
      added?.id,
    ]);

    expect(rows[0]?.credentials).toMatch(/^v1\./);
    expect(rows[0]?.credentials).not.toContain("livekit-key");
    expect(rows[0]?.credentials).not.toContain("livekit-secret");
    expect(rows[0]?.credentials_hint).toBe("WXYZ");
  });

  it("leaves nothing behind when the payload is refused", async () => {
    const agentId = await agentNamed("LiveKit Refused");

    await expect(
      addConnection(
        actingAsAcme(),
        agentId,
        livekitConnection({ config: { url: "wss://acme.livekit.cloud", agentName: "" } }),
      ),
    ).rejects.toThrow(/agentName/);

    expect(await listConnections(actingAsAcme(), agentId)).toEqual([]);
  });
});

/**
 * The second shape: the customer keeps the key pair that signs tokens for
 * their whole LiveKit project, and egma asks an endpoint of theirs for one
 * scoped token per simulation.
 *
 * What is pinned here is the same three things mode A pins — what lands, what
 * a read shows, and what the resolver hands the simulator — because the
 * headers that authenticate egma to that endpoint are a credential exactly as
 * the key pair is, and nothing about them being headers makes them less so.
 */
describe("a livekit connection that asks an endpoint for its tokens", () => {
  const HEADERS = '{"Authorization":"Bearer SENTINEL-endpoint-token-91af"}';

  function atEndpoint(overrides: Partial<NewConnection> = {}): NewConnection {
    return {
      name: `livekit-endpoint-${newId("con").slice(-8)}`,
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      credentials: { headers: HEADERS },
      ...overrides,
    };
  }

  it("lands with the endpoint in its config, hinted by the header's name", async () => {
    const agentId = await agentNamed("LiveKit Endpoint");
    const added = await addConnection(actingAsAcme(), agentId, atEndpoint());

    const fetched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(fetched).toMatchObject({
      agentPlatform: "livekit_agents",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      productLabel: "LiveKit token endpoint",
      topology: "agent-dials-out",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://acme.example/egma/livekit-token",
      },
      // The name of the header and no part of its value: a bearer token has
      // no public half whose tail would be safe to print.
      credentialsHint: "Authorization",
    });
    expect(fetched).not.toHaveProperty("credentials");
  });

  it("seals the headers, and they are nowhere in the row", async () => {
    const agentId = await agentNamed("LiveKit Endpoint Sealed");
    const added = await addConnection(actingAsAcme(), agentId, atEndpoint());

    const { rows } = await database.sql<{
      credentials: string;
      config: Record<string, string>;
    }>("select credentials, config from connection where id = $1", [added?.id]);

    expect(rows[0]?.credentials).toMatch(/^v1\./);
    expect(rows[0]?.credentials).not.toContain("SENTINEL-endpoint-token");
    // Config is readable by design, which is exactly why a credential may
    // never be put in it.
    expect(JSON.stringify(rows[0]?.config)).not.toContain("SENTINEL");
  });

  it("refuses a public endpoint with no auth headers", async () => {
    const agentId = await agentNamed("LiveKit Open Endpoint");
    await expect(
      addConnection(
        actingAsAcme(),
        agentId,
        atEndpoint({ credentials: undefined }),
      ),
    ).rejects.toThrow(
      "a livekit connection whose config names a tokenEndpoint asks that " +
        "endpoint for every token, so it holds no key pair of its own: its " +
        "credentials are the endpoint's auth headers, shaped { headers }. " +
        "Send those, or drop the tokenEndpoint and Egma will mint its own " +
        "tokens from an apiKey and apiSecret.",
    );

    expect(await listConnections(actingAsAcme(), agentId)).toEqual([]);
  });

  /**
   * The shape a connection is in is written down when it is created and never
   * derived again, so there is no edit that moves one between the shapes.
   *
   * This used to be allowed when the new shape's credentials came along, and
   * that was one rule short: the credential rule a Restore is held to is read
   * from the stored shape, so a connection that changed shape underneath its
   * stored id would be held to one shape's rule while carrying the other's
   * credential. The two shapes hold different config keys and different
   * credentials, which is what makes them a different connection rather than a
   * different setting.
   */
  it("refuses config keys outside the stored access variant", async () => {
    const agentId = await agentNamed("LiveKit Shape Change");
    const added = await addConnection(actingAsAcme(), agentId, livekitConnection());

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
      }),
    ).rejects.toThrow('config has no key "tokenEndpoint"');

    // Nothing moved: the row is the shape it was, with the credential it had.
    expect(
      (await getConnection(actingAsAcme(), agentId, added?.id ?? ""))?.config,
    ).toEqual({ url: "wss://acme.livekit.cloud" });
  });

  it("refuses it even when the new shape's credentials come with it", async () => {
    const agentId = await agentNamed("LiveKit Shape Moved");
    const added = await addConnection(actingAsAcme(), agentId, livekitConnection());

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        config: {
          url: "wss://acme.livekit.cloud",
          tokenEndpoint: "https://acme.example/egma/livekit-token",
        },
        credentials: { headers: HEADERS },
      }),
    ).rejects.toThrow(/config has no key "tokenEndpoint"/);

    const untouched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(untouched?.accessVariant).toBe("livekit_room.project_credentials");
    expect(untouched?.config).toEqual({ url: "wss://acme.livekit.cloud" });
  });

  /**
   * Credentials changed on their own are gated against the shape the *stored*
   * config is in, so a key pair cannot be rotated onto a connection that has
   * no way to use one.
   */
  it("refuses a key pair rotated onto a connection that asks an endpoint", async () => {
    const agentId = await agentNamed("LiveKit Endpoint Rotated");
    const added = await addConnection(actingAsAcme(), agentId, atEndpoint());

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        credentials: {
          apiKey: "livekit-key-A1B2C3D4WXYZ",
          apiSecret: "livekit-secret-E5F6G7H8QRST",
        },
      }),
    ).rejects.toThrow(/holds no key pair of its own/);
  });
});

describe("the sealed credential", () => {
  it("never appears in any read; the last-4 hint does", async () => {
    const agentId = await agentNamed("Sealed Reads");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const fetched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    const [listed] = (await listConnections(actingAsAcme(), agentId)) ?? [];

    for (const shape of [added, fetched, listed]) {
      expect(shape).toBeDefined();
      expect(shape).not.toHaveProperty("credentials");
      expect(shape?.credentialsHint).toBe("WXYZ");
    }
  });

  it("lands in the row as a v1. envelope, not as the key", async () => {
    const agentId = await agentNamed("Sealed Row");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const { rows } = await database.sql<{
      credentials: string;
      credentials_hint: string;
    }>("select credentials, credentials_hint from connection where id = $1", [
      added?.id,
    ]);

    expect(rows[0]?.credentials).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(rows[0]?.credentials).not.toContain("retell-secret");
    expect(rows[0]?.credentials_hint).toBe("WXYZ");
  });

  // What the plaintext opens back into — a fresh seal, a rotation, a padded
  // paste — is proven where the one door to it now lives: the dispatch path's
  // resolver, in `simulation-claims.test.ts`, which walks seal → store →
  // claim → unseal through the same rows these tests write.

  it("stores the key trimmed, so a padded paste still authenticates", async () => {
    const agentId = await agentNamed("Padded Key");
    const added = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ credentials: { apiKey: "  retell-secret-padded-1234  " } }),
    );

    // The hint is the stored value's own tail, so a hint without the pasted
    // whitespace is the trim having happened before the seal.
    expect(added?.credentialsHint).toBe("1234");
  });

  it("rotates by replacing the object whole, resealing envelope and hint", async () => {
    const agentId = await agentNamed("Rotated");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const before = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [added?.id],
    );

    const rotated = await updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
      credentials: { apiKey: "retell-secret-rotated-9999ABCD" },
    });
    expect(rotated?.credentialsHint).toBe("ABCD");

    const after = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [added?.id],
    );
    expect(after.rows[0]?.credentials).not.toBe(before.rows[0]?.credentials);
  });
});

describe("updating a connection", () => {
  it("changes name, environment and config; absent means keep", async () => {
    const agentId = await agentNamed("Edited");
    const added = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "before", environment: "staging" }),
    );

    const renamed = await updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
      name: "after",
      config: { retellAgentId: "agent_replacement" },
    });

    expect(renamed?.name).toBe("after");
    expect(renamed?.environment).toBe("staging");
    expect(renamed?.config).toEqual({ retellAgentId: "agent_replacement" });

    const cleared = await updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
      environment: null,
    });
    expect(cleared?.environment).toBeNull();
  });

  it("checks a config change against the type's own registry entry", async () => {
    const agentId = await agentNamed("Edited Config");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        config: { phoneNumber: "+15551234567" },
      }),
    ).rejects.toThrow(/"phoneNumber"/);
  });

  it("refuses to change type or modality: that is a new connection", async () => {
    const agentId = await agentNamed("Immutable");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        connectionType: "phone_number",
      } as never),
    ).rejects.toThrow(/new connection/);

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        modality: "voice",
      } as never),
    ).rejects.toThrow(/new connection/);

    const untouched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(untouched?.connectionType).toBe("retell_chat_api");
    expect(untouched?.modality).toBe("chat");
  });
});

describe("a connection's name", () => {
  it("is stored trimmed and refused while another living connection holds it", async () => {
    const agentId = await agentNamed("Named");

    const padded = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "  staging  " }),
    );
    expect(padded?.name).toBe("staging");

    await expect(
      addConnection(actingAsAcme(), agentId, retellConnection({ name: "staging" })),
    ).rejects.toThrow(/already/);
  });

  it("is welcome on another agent of the same project", async () => {
    const first = await agentNamed("First Owner");
    const second = await agentNamed("Second Owner");

    await addConnection(actingAsAcme(), first, retellConnection({ name: "ci" }));
    const twin = await addConnection(
      actingAsAcme(),
      second,
      retellConnection({ name: "ci" }),
    );
    expect(twin?.name).toBe("ci");
  });

  it("is released by an archived connection", async () => {
    const agentId = await agentNamed("Recycler");

    const retiring = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "staging" }),
    );
    await archiveConnection(actingAsAcme(), agentId, retiring?.id ?? "");

    const successor = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "staging" }),
    );
    expect(successor?.name).toBe("staging");
    expect(successor?.id).not.toBe(retiring?.id);
  });
});

describe("archiving a connection", () => {
  it("leaves the active list, stays readable, and answers where it went", async () => {
    const agentId = await agentNamed("Shrinking");
    const keeper = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "keeper" }),
    );
    const goner = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "goner" }),
    );

    const archived = await archiveConnection(
      actingAsAcme(),
      agentId,
      goner?.id ?? "",
    );
    expect(archived?.connection.id).toBe(goner?.id);
    expect(archived?.connection.archivedAt).toBeInstanceOf(Date);

    const remaining = await listConnections(actingAsAcme(), agentId);
    expect(remaining?.map((connection) => connection.id)).toEqual([keeper?.id]);

    // Readable on its own and under the archived filter — Archive stops it
    // being used, it does not make it disappear.
    const still = await getConnection(actingAsAcme(), agentId, goner?.id ?? "");
    expect(still?.id).toBe(goner?.id);
    const filed = await listConnections(actingAsAcme(), agentId, {
      archived: true,
    });
    expect(filed?.map((connection) => connection.id)).toEqual([goner?.id]);
  });
});

describe("reaching a connection through the wrong door", () => {
  it("is unreachable through another agent, even of the same project", async () => {
    const home = await agentNamed("Home");
    const neighbour = await agentNamed("Neighbour");
    const added = await addConnection(actingAsAcme(), home, retellConnection());

    expect(
      await getConnection(actingAsAcme(), neighbour, added?.id ?? ""),
    ).toBeUndefined();
    expect(
      await updateConnection(actingAsAcme(), neighbour, added?.id ?? "", {
        name: "hijacked",
      }),
    ).toBeUndefined();
    expect(
      await archiveConnection(actingAsAcme(), neighbour, added?.id ?? ""),
    ).toBeUndefined();
  });

  it("is unreachable under another organization's auth context, every verb", async () => {
    const agentId = await agentNamed("Acme's Alone");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    expect(
      await addConnection(actingAsGlobex(), agentId, retellConnection()),
    ).toBeUndefined();
    expect(await listConnections(actingAsGlobex(), agentId)).toBeUndefined();
    expect(
      await getConnection(actingAsGlobex(), agentId, added?.id ?? ""),
    ).toBeUndefined();
    expect(
      await updateConnection(actingAsGlobex(), agentId, added?.id ?? "", {
        name: "stolen",
      }),
    ).toBeUndefined();
    expect(
      await archiveConnection(actingAsGlobex(), agentId, added?.id ?? ""),
    ).toBeUndefined();
  });

  it("reaches the whole customer for a credential acting in no project", async () => {
    const agentId = await agentNamed("Org Wide Wiring");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getConnection(wholeCustomer, agentId, added?.id ?? "");
    expect(fetched?.id).toBe(added?.id);
  });

  it("goes archived with its agent, and stays readable under the filter", async () => {
    const agentId = await agentNamed("Doomed");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    await archiveAgent(actingAsAcme(), agentId);

    expect(await listConnections(actingAsAcme(), agentId)).toEqual([]);
    const filed = await listConnections(actingAsAcme(), agentId, {
      archived: true,
    });
    expect(filed?.map((one) => one.id)).toEqual([added?.id]);

    // A new way into an archived agent is new work over something taken out of
    // new work, so it is refused rather than quietly written.
    await expect(
      addConnection(actingAsAcme(), agentId, retellConnection({ name: "late" })),
    ).rejects.toThrow(/archived/);
  });
});

describe("creating an agent with its first connection inline", () => {
  it("writes both rows in one motion and answers both ids", async () => {
    const created = await createAgent(actingAsAcme(), {
      name: "Wired From Birth",
      connection: retellConnection({ name: "day-one" }),
    });

    expect(isId("agt", created.id)).toBe(true);
    expect(isId("con", created.connection?.id ?? "")).toBe(true);
    expect(created.connection?.agentId).toBe(created.id);

    const listed = await listConnections(actingAsAcme(), created.id);
    expect(listed?.map((connection) => connection.name)).toEqual(["day-one"]);
  });

  it("defaults the inline connection's name from its type", async () => {
    const created = await createAgent(actingAsAcme(), {
      name: "Wired Namelessly",
      connection: retellConnection({ name: undefined }),
    });

    expect(created.connection?.name).toBe("retell_chat_api-1");
  });

  it("leaves no agent behind when the connection payload is bad", async () => {
    await expect(
      createAgent(actingAsAcme(), {
        name: "Atomic",
        connection: retellConnection({ config: {} }),
      }),
    ).rejects.toThrow(/retellAgentId/);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where name = 'Atomic'",
    );
    expect(rows[0]?.count).toBe("0");

    // And the name is genuinely free: the create can be retried, fixed.
    const retried = await createAgent(actingAsAcme(), {
      name: "Atomic",
      connection: retellConnection(),
    });
    expect(retried.connection).toBeDefined();
  });

  it("still creates an agent with no connection at all", async () => {
    const created = await createAgent(actingAsAcme(), { name: "Unwired" });
    expect(created.connection).toBeUndefined();
    expect(await listConnections(actingAsAcme(), created.id)).toEqual([]);
  });
});
