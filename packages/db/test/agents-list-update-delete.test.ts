import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  archiveAgent,
  createAgent,
  getAgent,
  listAgents,
  listConnections,
  NotPermittedError,
  restoreAgent,
  updateAgent,
  type Agent,
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
 * List, update, Archive and Restore — through the factory functions only, like the create
 * and fetch tests before them. Raw SQL appears in fixtures and in the one read
 * proving a deleted agent's connection rows are still in the table, which is
 * precisely what no seam may show; every id an assertion needs comes off the
 * seam itself.
 *
 * Each concern acts in a project of its own, so no assertion here depends on
 * what another describe block created.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  listing: newId("prj"),
  updating: newId("prj"),
  deleting: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingIn(
  projectId: string | undefined,
  role: Role = "member",
): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId,
    role,
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: ada,
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

beforeAll(async () => {
  database = await createConnectedDatabase("agents_list_update_delete");

  await seedOrganization(database, acme.organization, [
    { id: acme.listing, slug: "listing" },
    { id: acme.updating, slug: "updating" },
    { id: acme.deleting, slug: "deleting" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("listing agents", () => {
  const created: Agent[] = [];
  let neighbour: Agent;
  let stranger: Agent;

  beforeAll(async () => {
    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      created.push(await createAgent(actingIn(acme.listing), { agentPlatform: "retell", name }));
    }
    // One in a sibling project and one at another customer, so "only the
    // acting project's" is a claim the assertions can actually falsify.
    neighbour = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Neighbour",
    });
    stranger = await createAgent(actingAsGlobex(), { agentPlatform: "retell", name: "Stranger" });
  });

  it("returns only the acting project's agents, newest first", async () => {
    const page = await listAgents(actingIn(acme.listing));

    expect(page.items.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Three",
      "Two",
      "One",
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("pages across the whole set with no overlap and no missed row", async () => {
    const first = await listAgents(actingIn(acme.listing), { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await listAgents(actingIn(acme.listing), {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(second.items[1]?.id);

    const third = await listAgents(actingIn(acme.listing), {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();

    const walked = [...first.items, ...second.items, ...third.items];
    expect(walked.map((item) => item.id)).toEqual(
      created.map((item) => item.id).reverse(),
    );
  });

  it("refuses a page size outside the range and a cursor that is not an agt_ id", async () => {
    await expect(
      listAgents(actingIn(acme.listing), { limit: 0 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listAgents(actingIn(acme.listing), { limit: 201 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      listAgents(actingIn(acme.listing), { cursor: "con_nonsense" }),
    ).rejects.toThrow(/cursor/);
  });

  it("shows a credential for the whole organization every project, and no other customer", async () => {
    const page = await listAgents(actingIn(undefined));

    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(6);
    expect(ids).toContain(neighbour.id);
    expect(ids).not.toContain(stranger.id);
    expect(
      page.items.every((item) =>
        [acme.listing, acme.updating].includes(item.projectId),
      ),
    ).toBe(true);
  });

  it("shows another customer none of them", async () => {
    const page = await listAgents(actingAsGlobex());
    expect(page.items.map((item) => item.id)).toEqual([stranger.id]);
  });

  it("drops an archived agent from the list immediately", async () => {
    const [three] = created.filter((item) => item.name === "Three");
    if (three === undefined) throw new Error("Three was never created");

    await archiveAgent(actingIn(acme.listing), three.id);

    const page = await listAgents(actingIn(acme.listing));
    expect(page.items.map((item) => item.name)).toEqual([
      "Five",
      "Four",
      "Two",
      "One",
    ]);
  });
});

describe("updating an agent", () => {
  it("changes the name in place, and fetch round-trips it", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Draft",
    });

    const updated = await updateAgent(actingIn(acme.updating), created.id, {
      name: "Front Desk",
    });

    expect(updated?.id).toBe(created.id);
    expect(updated?.projectId).toBe(created.projectId);
    expect(updated?.name).toBe("Front Desk");

    const fetched = await getAgent(actingIn(acme.updating), created.id);
    expect(fetched?.name).toBe("Front Desk");
  });

  it("treats an empty change as no edit: nothing written, not even updated_at", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Unmoved",
    });
    const before = await getAgent(actingIn(acme.updating), created.id);

    const unchanged = await updateAgent(actingIn(acme.updating), created.id, {});
    expect(unchanged?.name).toBe("Unmoved");
    expect(unchanged?.updatedAt).toEqual(before?.updatedAt);

    const after = await getAgent(actingIn(acme.updating), created.id);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("stores the new name trimmed, and refuses one that is only whitespace", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Untrimmed",
    });

    const updated = await updateAgent(actingIn(acme.updating), created.id, {
      name: "  Trimmed  ",
    });
    expect(updated?.name).toBe("Trimmed");

    await expect(
      updateAgent(actingIn(acme.updating), created.id, { name: "   " }),
    ).rejects.toThrow(/name/);
  });

  it("refuses a name a living agent in the project holds, and leaves both untouched", async () => {
    await createAgent(actingIn(acme.updating), { agentPlatform: "retell", name: "Reception" });
    const rival = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Rival",
    });

    await expect(
      updateAgent(actingIn(acme.updating), rival.id, { name: "Reception" }),
    ).rejects.toThrow(/already/);

    const untouched = await getAgent(actingIn(acme.updating), rival.id);
    expect(untouched?.name).toBe("Rival");
  });

  it("takes a name an archived agent released", async () => {
    const vacating = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Vacated",
    });
    const heir = await createAgent(actingIn(acme.updating), { agentPlatform: "retell", name: "Heir" });

    await archiveAgent(actingIn(acme.updating), vacating.id);

    const renamed = await updateAgent(actingIn(acme.updating), heir.id, {
      name: "Vacated",
    });
    expect(renamed?.name).toBe("Vacated");
  });

  it("lands for a credential acting in no project: the row names its own", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Org Editable",
    });

    const updated = await updateAgent(actingIn(undefined), created.id, {
      name: "Edited for the whole customer",
    });
    expect(updated?.id).toBe(created.id);
    expect(updated?.name).toBe("Edited for the whole customer");
  });

  it("returns nothing for another customer's agent, and leaves it untouched", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Acme Held",
    });

    expect(
      await updateAgent(actingAsGlobex(), created.id, { name: "Taken" }),
    ).toBeUndefined();

    const untouched = await getAgent(actingIn(acme.updating), created.id);
    expect(untouched?.name).toBe("Acme Held");
  });

  it("returns nothing for an archived agent, which is out of new work", async () => {
    const gone = await createAgent(actingIn(acme.updating), { agentPlatform: "retell", name: "Gone" });
    await archiveAgent(actingIn(acme.updating), gone.id);

    expect(
      await updateAgent(actingIn(acme.updating), gone.id, { name: "Back" }),
    ).toBeUndefined();

    // Archive is not deletion: the agent still reads, which is what makes
    // Restore reachable and what keeps its runs openable.
    const readable = await getAgent(actingIn(acme.updating), gone.id);
    expect(readable?.name).toBe("Gone");
    expect(readable?.archivedAt).toBeInstanceOf(Date);
  });

  it("is refused to a viewer", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      agentPlatform: "retell",
      name: "Read Only",
    });

    await expect(
      updateAgent(actingIn(acme.updating, "viewer"), created.id, {
        name: "Written",
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("archiving an agent", () => {
  it("is refused to a credential acting in no project, like create", async () => {
    const standing = await createAgent(actingIn(acme.deleting), {
      agentPlatform: "retell",
      name: "Standing",
    });

    await expect(archiveAgent(actingIn(undefined), standing.id)).rejects.toThrow(
      /project/,
    );

    const stillThere = await getAgent(actingIn(acme.deleting), standing.id);
    expect(stillThere?.archivedAt).toBeNull();
  });

  it("takes it out of the list while it still reads on its own", async () => {
    const retired = await createAgent(actingIn(acme.deleting), {
      agentPlatform: "retell",
      name: "Retired",
    });

    const archived = await archiveAgent(actingIn(acme.deleting), retired.id);
    expect(archived?.agent.id).toBe(retired.id);
    expect(archived?.agent.archivedAt).toBeInstanceOf(Date);

    const page = await listAgents(actingIn(acme.deleting));
    expect(page.items.map((item) => item.id)).not.toContain(retired.id);

    // The whole difference from the delete this replaced: it is still there.
    const readable = await getAgent(actingIn(acme.deleting), retired.id);
    expect(readable?.id).toBe(retired.id);
  });

  it("shows up under the archived filter, and only there", async () => {
    const filed = await createAgent(actingIn(acme.deleting), { agentPlatform: "retell", name: "Filed" });
    await archiveAgent(actingIn(acme.deleting), filed.id);

    const archived = await listAgents(actingIn(acme.deleting), {
      archived: true,
    });
    expect(archived.items.map((item) => item.id)).toContain(filed.id);

    const active = await listAgents(actingIn(acme.deleting));
    expect(active.items.map((item) => item.id)).not.toContain(filed.id);
  });

  it("archives its active connections with it, in the same operation", async () => {
    const wired = await createAgent(actingIn(acme.deleting), {
      agentPlatform: "retell",
      name: "Wired Til The End",
    });
    const attached = await addConnection(
      actingIn(acme.deleting),
      wired.id,
      retellConnection({ name: "staging" }),
    );
    if (attached === undefined) throw new Error("the connection never attached");

    const archived = await archiveAgent(actingIn(acme.deleting), wired.id);
    expect(archived?.connections).toEqual([attached.id]);

    // Active list empty, archived list holding it: the child went with the
    // parent, so restoring the parent cannot bring a credential back by itself.
    expect(await listConnections(actingIn(acme.deleting), wired.id)).toEqual([]);
    const archivedChildren = await listConnections(
      actingIn(acme.deleting),
      wired.id,
      { archived: true },
    );
    expect(archivedChildren?.map((one) => one.id)).toEqual([attached.id]);
  });

  it("leaves its connections archived when the agent is restored", async () => {
    const back = await createAgent(actingIn(acme.deleting), { agentPlatform: "retell", name: "Back" });
    const attached = await addConnection(
      actingIn(acme.deleting),
      back.id,
      retellConnection({ name: "staging" }),
    );
    if (attached === undefined) throw new Error("the connection never attached");

    await archiveAgent(actingIn(acme.deleting), back.id);
    const restored = await restoreAgent(actingIn(acme.deleting), back.id);
    expect(restored?.archivedAt).toBeNull();

    expect(await listConnections(actingIn(acme.deleting), back.id)).toEqual([]);
  });

  it("archives only once: a second archive changes nothing", async () => {
    const once = await createAgent(actingIn(acme.deleting), { agentPlatform: "retell", name: "Once" });

    const first = await archiveAgent(actingIn(acme.deleting), once.id);
    const again = await archiveAgent(actingIn(acme.deleting), once.id);
    expect(again?.agent.archivedAt).toEqual(first?.agent.archivedAt);
    expect(again?.connections).toEqual([]);
  });

  it("returns nothing for another customer's agent, and leaves it active", async () => {
    const bystander = await createAgent(actingIn(acme.deleting), {
      agentPlatform: "retell",
      name: "Bystander",
    });

    expect(await archiveAgent(actingAsGlobex(), bystander.id)).toBeUndefined();

    const fetched = await getAgent(actingIn(acme.deleting), bystander.id);
    expect(fetched?.archivedAt).toBeNull();
  });

  it("is refused to a viewer", async () => {
    const guarded = await createAgent(actingIn(acme.deleting), {
      agentPlatform: "retell",
      name: "Guarded",
    });

    await expect(
      archiveAgent(actingIn(acme.deleting, "viewer"), guarded.id),
    ).rejects.toThrow(NotPermittedError);
  });
});
