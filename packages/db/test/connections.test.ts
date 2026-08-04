import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  createAgent,
  getConnection,
  listConnections,
  NotPermittedError,
  removeConnection,
  resolveConnectionCredentials,
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
    type: "retell",
    modality: "chat",
    config: { retellAgentId: "agent_in_retell_1" },
    credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
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
      type: "retell",
      modality: "voice",
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
      type: "retell",
      modality: "voice",
      topology: "hosted-broker",
      environment: "staging",
      config: { retellAgentId: "agent_abc" },
      credentialsHint: "WXYZ",
      capabilities: null,
    });
  });

  it("derives the topology from the type, so a phone connection dials in", async () => {
    const agentId = await agentNamed("Topology");

    const added = await addConnection(actingAsAcme(), agentId, {
      name: "production-line",
      type: "phone",
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

    expect(first?.name).toBe("retell-1");
    expect(second?.name).toBe("retell-2");
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
        type: "phone",
        modality: "chat",
        config: { phoneNumber: "+15551234567" },
      }),
    ).rejects.toThrow(/phone connection speaks voice/);
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
        type: "phone",
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
        type: "phone",
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

  it("round-trips through the resolver, the one door to the plaintext", async () => {
    const agentId = await agentNamed("Resolved");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const resolved = await resolveConnectionCredentials(
      actingAsAcme(),
      agentId,
      added?.id ?? "",
    );
    expect(resolved).toEqual({ apiKey: "retell-secret-A1B2C3D4WXYZ" });
  });

  it("resolves to null for a type that holds no secret", async () => {
    const agentId = await agentNamed("Resolved Phone");
    const added = await addConnection(actingAsAcme(), agentId, {
      name: "hotline",
      type: "phone",
      modality: "voice",
      config: { phoneNumber: "+15559876543" },
    });

    const resolved = await resolveConnectionCredentials(
      actingAsAcme(),
      agentId,
      added?.id ?? "",
    );
    expect(resolved).toBeNull();
  });

  it("refuses the resolver to a viewer, who cannot start a run", async () => {
    const agentId = await agentNamed("Resolver Gate");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    await expect(
      resolveConnectionCredentials(
        actingAsAcme("viewer"),
        agentId,
        added?.id ?? "",
      ),
    ).rejects.toThrow(NotPermittedError);
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

    const resolved = await resolveConnectionCredentials(
      actingAsAcme(),
      agentId,
      added?.id ?? "",
    );
    expect(resolved).toEqual({ apiKey: "retell-secret-rotated-9999ABCD" });
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
        type: "phone",
      } as never),
    ).rejects.toThrow(/new connection/);

    await expect(
      updateConnection(actingAsAcme(), agentId, added?.id ?? "", {
        modality: "voice",
      } as never),
    ).rejects.toThrow(/new connection/);

    const untouched = await getConnection(actingAsAcme(), agentId, added?.id ?? "");
    expect(untouched?.type).toBe("retell");
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

  it("is released by a removed connection", async () => {
    const agentId = await agentNamed("Recycler");

    const retiring = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "staging" }),
    );
    await removeConnection(actingAsAcme(), agentId, retiring?.id ?? "");

    const successor = await addConnection(
      actingAsAcme(),
      agentId,
      retellConnection({ name: "staging" }),
    );
    expect(successor?.name).toBe("staging");
    expect(successor?.id).not.toBe(retiring?.id);
  });
});

describe("removing a connection", () => {
  it("vanishes from fetch and list, and answers what was removed", async () => {
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

    const removed = await removeConnection(actingAsAcme(), agentId, goner?.id ?? "");
    expect(removed?.id).toBe(goner?.id);
    expect(removed?.deletedAt).toBeInstanceOf(Date);

    expect(await getConnection(actingAsAcme(), agentId, goner?.id ?? "")).toBeUndefined();
    const remaining = await listConnections(actingAsAcme(), agentId);
    expect(remaining?.map((connection) => connection.id)).toEqual([keeper?.id]);
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
      await removeConnection(actingAsAcme(), neighbour, added?.id ?? ""),
    ).toBeUndefined();
    expect(
      await resolveConnectionCredentials(actingAsAcme(), neighbour, added?.id ?? ""),
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
      await removeConnection(actingAsGlobex(), agentId, added?.id ?? ""),
    ).toBeUndefined();
    expect(
      await resolveConnectionCredentials(actingAsGlobex(), agentId, added?.id ?? ""),
    ).toBeUndefined();
  });

  it("reaches the whole customer for a credential acting in no project", async () => {
    const agentId = await agentNamed("Org Wide Wiring");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getConnection(wholeCustomer, agentId, added?.id ?? "");
    expect(fetched?.id).toBe(added?.id);
  });

  it("vanishes with its agent: a deleted agent's connections answer nothing", async () => {
    const agentId = await agentNamed("Doomed");
    const added = await addConnection(actingAsAcme(), agentId, retellConnection());

    // The agent's delete verb is the next issue's; until then the mark is made
    // by hand.
    await database.sql("update agent set deleted_at = now() where id = $1", [
      agentId,
    ]);

    expect(await listConnections(actingAsAcme(), agentId)).toBeUndefined();
    expect(
      await getConnection(actingAsAcme(), agentId, added?.id ?? ""),
    ).toBeUndefined();
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

    expect(created.connection?.name).toBe("retell-1");
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
