import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addConnection,
  createAgent,
  deleteAgent,
  getAgent,
  getConnection,
  listAgents,
  listConnections,
  NotPermittedError,
  removeConnection,
  updateAgent,
  updateConnection,
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
 * List, update, delete — through the factory functions only, like the create
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
    type: "retell",
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
      created.push(await createAgent(actingIn(acme.listing), { name }));
    }
    // One in a sibling project and one at another customer, so "only the
    // acting project's" is a claim the assertions can actually falsify.
    neighbour = await createAgent(actingIn(acme.updating), {
      name: "Neighbour",
    });
    stranger = await createAgent(actingAsGlobex(), { name: "Stranger" });
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

  it("drops a deleted agent from the list immediately", async () => {
    const [three] = created.filter((item) => item.name === "Three");
    if (three === undefined) throw new Error("Three was never created");

    await deleteAgent(actingIn(acme.listing), three.id);

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
  it("changes name and description in place, and fetch round-trips both", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Draft",
      description: "First try",
    });

    const updated = await updateAgent(actingIn(acme.updating), created.id, {
      name: "Front Desk",
      description: "Books appointments for the clinic",
    });

    expect(updated?.id).toBe(created.id);
    expect(updated?.projectId).toBe(created.projectId);
    expect(updated?.name).toBe("Front Desk");
    expect(updated?.description).toBe("Books appointments for the clinic");

    const fetched = await getAgent(actingIn(acme.updating), created.id);
    expect(fetched?.name).toBe("Front Desk");
    expect(fetched?.description).toBe("Books appointments for the clinic");
  });

  it("treats an empty change as no edit: nothing written, not even updated_at", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Unmoved",
      description: "As it was",
    });
    const before = await getAgent(actingIn(acme.updating), created.id);

    const unchanged = await updateAgent(actingIn(acme.updating), created.id, {});
    expect(unchanged?.name).toBe("Unmoved");
    expect(unchanged?.updatedAt).toEqual(before?.updatedAt);

    const after = await getAgent(actingIn(acme.updating), created.id);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("keeps what a change leaves absent, and clears a description set to null", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Keeper",
      description: "Still here",
    });

    const renamed = await updateAgent(actingIn(acme.updating), created.id, {
      name: "Kept",
    });
    expect(renamed?.description).toBe("Still here");

    const cleared = await updateAgent(actingIn(acme.updating), created.id, {
      description: null,
    });
    expect(cleared?.name).toBe("Kept");
    expect(cleared?.description).toBeNull();
  });

  it("stores the new name trimmed, and refuses one that is only whitespace", async () => {
    const created = await createAgent(actingIn(acme.updating), {
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
    await createAgent(actingIn(acme.updating), { name: "Reception" });
    const rival = await createAgent(actingIn(acme.updating), {
      name: "Rival",
    });

    await expect(
      updateAgent(actingIn(acme.updating), rival.id, { name: "Reception" }),
    ).rejects.toThrow(/already/);

    const untouched = await getAgent(actingIn(acme.updating), rival.id);
    expect(untouched?.name).toBe("Rival");
  });

  it("takes a name a deleted agent released", async () => {
    const vacating = await createAgent(actingIn(acme.updating), {
      name: "Vacated",
    });
    const heir = await createAgent(actingIn(acme.updating), { name: "Heir" });

    await deleteAgent(actingIn(acme.updating), vacating.id);

    const renamed = await updateAgent(actingIn(acme.updating), heir.id, {
      name: "Vacated",
    });
    expect(renamed?.name).toBe("Vacated");
  });

  it("lands for a credential acting in no project: the row names its own", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Org Editable",
    });

    const updated = await updateAgent(actingIn(undefined), created.id, {
      description: "Edited for the whole customer",
    });
    expect(updated?.id).toBe(created.id);
    expect(updated?.description).toBe("Edited for the whole customer");
  });

  it("returns nothing for another customer's agent, and leaves it untouched", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Acme Held",
    });

    expect(
      await updateAgent(actingAsGlobex(), created.id, { name: "Taken" }),
    ).toBeUndefined();

    const untouched = await getAgent(actingIn(acme.updating), created.id);
    expect(untouched?.name).toBe("Acme Held");
  });

  it("returns nothing for a deleted agent", async () => {
    const gone = await createAgent(actingIn(acme.updating), { name: "Gone" });
    await deleteAgent(actingIn(acme.updating), gone.id);

    expect(
      await updateAgent(actingIn(acme.updating), gone.id, { name: "Back" }),
    ).toBeUndefined();
  });

  it("is refused to a viewer", async () => {
    const created = await createAgent(actingIn(acme.updating), {
      name: "Read Only",
    });

    await expect(
      updateAgent(actingIn(acme.updating, "viewer"), created.id, {
        name: "Written",
      }),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("deleting an agent", () => {
  it("is refused to a credential acting in no project, like create", async () => {
    const standing = await createAgent(actingIn(acme.deleting), {
      name: "Standing",
    });

    await expect(deleteAgent(actingIn(undefined), standing.id)).rejects.toThrow(
      /project/,
    );

    const stillThere = await getAgent(actingIn(acme.deleting), standing.id);
    expect(stillThere?.id).toBe(standing.id);
  });

  it("hides it from fetch and list at once, and answers what was deleted", async () => {
    const doomed = await createAgent(actingIn(acme.deleting), {
      name: "Doomed",
    });

    const deleted = await deleteAgent(actingIn(acme.deleting), doomed.id);
    expect(deleted?.id).toBe(doomed.id);
    expect(deleted?.projectId).toBe(acme.deleting);
    expect(deleted?.name).toBe("Doomed");
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    expect(await getAgent(actingIn(acme.deleting), doomed.id)).toBeUndefined();
    const page = await listAgents(actingIn(acme.deleting));
    expect(page.items.map((item) => item.id)).not.toContain(doomed.id);
  });

  it("takes its connections out of every read, while their rows stay untouched", async () => {
    const wired = await createAgent(actingIn(acme.deleting), {
      name: "Wired Til The End",
    });
    const attached = await addConnection(
      actingIn(acme.deleting),
      wired.id,
      retellConnection({ name: "staging" }),
    );
    if (attached === undefined) throw new Error("the connection never attached");

    await deleteAgent(actingIn(acme.deleting), wired.id);

    // Every read and write a connection has, answering as if none of it exists.
    expect(await listConnections(actingIn(acme.deleting), wired.id)).toBeUndefined();
    expect(
      await getConnection(actingIn(acme.deleting), wired.id, attached.id),
    ).toBeUndefined();
    expect(
      await updateConnection(actingIn(acme.deleting), wired.id, attached.id, {
        name: "renamed",
      }),
    ).toBeUndefined();
    expect(
      await removeConnection(actingIn(acme.deleting), wired.id, attached.id),
    ).toBeUndefined();
    expect(
      await addConnection(actingIn(acme.deleting), wired.id, retellConnection()),
    ).toBeUndefined();

    // The row itself is exactly as it was — not even its own soft-delete mark.
    // Hiding rode entirely on the agent's marker; the sweep is the deletion
    // worker's job, and this raw read is the one way to see the worker's input.
    const { rows } = await database.sql<{ name: string; deleted_at: Date | null }>(
      "select name, deleted_at from connection where id = $1",
      [attached.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("staging");
    expect(rows[0]?.deleted_at).toBeNull();
  });

  it("deletes only once: a second delete finds nothing", async () => {
    const once = await createAgent(actingIn(acme.deleting), { name: "Once" });

    await deleteAgent(actingIn(acme.deleting), once.id);
    expect(await deleteAgent(actingIn(acme.deleting), once.id)).toBeUndefined();
  });

  it("returns nothing for another customer's agent, and leaves it live", async () => {
    const bystander = await createAgent(actingIn(acme.deleting), {
      name: "Bystander",
    });

    expect(await deleteAgent(actingAsGlobex(), bystander.id)).toBeUndefined();

    const fetched = await getAgent(actingIn(acme.deleting), bystander.id);
    expect(fetched?.id).toBe(bystander.id);
  });

  it("is refused to a viewer", async () => {
    const guarded = await createAgent(actingIn(acme.deleting), {
      name: "Guarded",
    });

    await expect(
      deleteAgent(actingIn(acme.deleting, "viewer"), guarded.id),
    ).rejects.toThrow(NotPermittedError);
  });
});
