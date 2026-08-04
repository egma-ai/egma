import { isId, newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAgent,
  getAgent,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  type AuthContext,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  errorCodeOf,
  POSTGRES_ERROR,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The factory functions are the seam: every assertion goes through create and
 * get, never through table internals. Raw SQL appears only in fixtures, in the
 * soft-delete marks that stand in for ticket 03's delete verb, and in the
 * inserts that bypass the module on purpose to show the database refuses what
 * the module never attempts.
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

beforeAll(async () => {
  database = await createConnectedDatabase("agents");

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

describe("creating an agent", () => {
  it("returns an agt_ id and fetch round-trips name and description", async () => {
    const created = await createAgent(actingAsAcme(), {
      name: "Front Desk",
      description: "Books appointments for the clinic",
    });

    expect(isId("agt", created.id)).toBe(true);

    const fetched = await getAgent(actingAsAcme(), created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe("Front Desk");
    expect(fetched?.description).toBe("Books appointments for the clinic");
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("takes no description as none: the fetch answers null", async () => {
    const created = await createAgent(actingAsAcme(), { name: "Terse" });

    const fetched = await getAgent(actingAsAcme(), created.id);
    expect(fetched?.description).toBeNull();
  });

  it("needs a name that is more than whitespace", async () => {
    await expect(createAgent(actingAsAcme(), { name: "   " })).rejects.toThrow(
      /name/,
    );
  });

  it("is allowed to a member and refused to a viewer, per the permission table", async () => {
    await expect(
      createAgent(actingAsAcme("viewer"), { name: "Viewer's Try" }),
    ).rejects.toThrow(NotPermittedError);

    const fetchedByViewer = await createAgent(actingAsAcme("member"), {
      name: "Member's Agent",
    }).then((created) => getAgent(actingAsAcme("viewer"), created.id));
    expect(fetchedByViewer?.name).toBe("Member's Agent");
  });

  it("is refused to a credential acting in no project", async () => {
    await expect(
      createAgent({ ...actingAsAcme(), projectId: undefined }, { name: "Nowhere" }),
    ).rejects.toThrow(/project/);
  });

  it("is refused when the acting project belongs to another customer", async () => {
    await expect(
      createAgent(
        { ...actingAsAcme(), projectId: globex.project },
        { name: "Stray" },
      ),
    ).rejects.toThrow(ProjectOutsideOrganizationError);
  });
});

describe("an agent's name", () => {
  it("is refused while another live agent in the project holds it", async () => {
    await createAgent(actingAsAcme(), { name: "Reception" });

    await expect(
      createAgent(actingAsAcme(), { name: "Reception" }),
    ).rejects.toThrow(/already/);
  });

  it("is welcome in another project of the same customer", async () => {
    await createAgent(actingAsAcme(), { name: "Concierge" });

    const inOtherProject = await createAgent(
      { ...actingAsAcme(), projectId: acme.secondProject },
      { name: "Concierge" },
    );
    expect(inOtherProject.projectId).toBe(acme.secondProject);
  });

  it("is welcome in another customer's project", async () => {
    await createAgent(actingAsAcme(), { name: "Switchboard" });

    const elsewhere = await createAgent(actingAsGlobex(), {
      name: "Switchboard",
    });
    expect(elsewhere.projectId).toBe(globex.project);
  });

  it("is released by a deleted agent, which also vanishes from fetch", async () => {
    const retiring = await createAgent(actingAsAcme(), { name: "Retiring" });

    // Ticket 03 brings the delete verb; until then the mark is made by hand.
    await database.sql("update agent set deleted_at = now() where id = $1", [
      retiring.id,
    ]);

    expect(await getAgent(actingAsAcme(), retiring.id)).toBeUndefined();

    const successor = await createAgent(actingAsAcme(), { name: "Retiring" });
    expect(successor.id).not.toBe(retiring.id);
  });
});

describe("fetching an agent", () => {
  it("returns nothing under another organization's auth context", async () => {
    const created = await createAgent(actingAsAcme(), { name: "Acme Only" });

    expect(await getAgent(actingAsGlobex(), created.id)).toBeUndefined();
  });

  it("reaches the whole customer for a credential acting in no project", async () => {
    const created = await createAgent(actingAsAcme(), { name: "Org Wide" });

    const wholeCustomer = { ...actingAsAcme(), projectId: undefined };
    const fetched = await getAgent(wholeCustomer, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.projectId).toBe(acme.project);
  });

  it("returns nothing from a project the caller is not acting in", async () => {
    const created = await createAgent(actingAsAcme(), { name: "Project Bound" });

    const actingElsewhere = { ...actingAsAcme(), projectId: acme.secondProject };
    expect(await getAgent(actingElsewhere, created.id)).toBeUndefined();
  });
});

describe("the database itself", () => {
  it("rejects an agent row pairing one customer with another customer's project", async () => {
    await expect(
      database.sql(
        `insert into agent (id, organization_id, project_id, name)
         values ($1, $2, $3, 'Mismatched')`,
        [newId("agt"), acme.organization, globex.project],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("rejects a connection row pairing one customer with another customer's project", async () => {
    const anchor = await createAgent(actingAsAcme(), { name: "Anchor" });

    await expect(
      database.sql(
        `insert into connection
           (id, organization_id, project_id, agent_id, name, type, modality, topology, config)
         values ($1, $2, $3, $4, 'staging', 'retell', 'chat', 'hosted-broker', '{}')`,
        [newId("con"), acme.organization, globex.project, anchor.id],
      ),
    ).rejects.toSatisfy(
      (error) => errorCodeOf(error) === POSTGRES_ERROR.foreignKeyViolation,
    );
  });

  it("carries UNIQUE (id, agent_id) on connection — the future run table's composite-FK target", async () => {
    const { rows } = await database.sql<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname = 'connection_id_agent_id_unique'`,
    );
    expect(rows[0]?.definition).toBe("UNIQUE (id, agent_id)");
  });
});
