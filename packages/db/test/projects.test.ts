import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createProject,
  getProjectJudge,
  IdentityConflictError,
  listPersonas,
  listProjects,
  NotPermittedError,
  ProjectSlugTakenError,
  readOrganization,
  readProject,
  UnprocessableInputError,
  updateOrganization,
  updateProject,
  type AuthContext,
  type Role,
} from "@egma/db";

import { createConnectedDatabase, type MigratedDatabase } from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Creating a project, editing one, and renaming the organization that holds
 * them.
 *
 * **The whole of this file is about one claim: a project is created whole or
 * not at all.** A project is not a row — it is a row, the persona a first test
 * gets when it names none, the pointer that makes that persona the default, and
 * whatever judge the deployment can give it. Signup has always written all four
 * together. An admin creating a second project used to write one of them, and
 * everything downstream of that gap failed later and somewhere else: the first
 * test in the new project refused because the project pointed at nobody, and
 * the first run came back errored because there was no judge to ask.
 *
 * So the create is proven by what it leaves behind rather than by what it
 * returns, and the failure case is proven by the absence of every one of those
 * rows.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const bob = newId("usr");

const THE_PLATFORMS_JUDGE = {
  provider: "openai",
  model: "gpt-4o",
  key: "sk-the-self-hoster-supplied-this-WXYZ",
};

function actingIn(
  organizationId: string,
  projectId: string,
  role: Role,
  userId = ada,
): AuthContext {
  return { userId, organizationId, projectId, role, via: "session" };
}

const acmeAdmin = () => actingIn(acme.organization, acme.project, "admin");

beforeAll(async () => {
  database = await createConnectedDatabase("projects");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, bob, "bob@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("creating a project", () => {
  it("writes the project and its shared default-persona pointer together", async () => {
    const made = await createProject(acmeAdmin(), {
      name: "Outbound sales",
      defaultJudge: THE_PLATFORMS_JUDGE,
    });

    expect(made.name).toBe("Outbound sales");
    expect(made.organizationId).toBe(acme.organization);

    const inside = actingIn(acme.organization, made.id, "admin");
    const personas = await listPersonas(inside, {});
    expect(personas.items).toHaveLength(1);

    // The pointer, read the way the persona factory reads it: the shared
    // persona is the project's default, so the first test written here has a
    // persona when it names none.
    expect(personas.items[0]?.isDefault).toBe(true);
  });

  it("gives the new project the deployment's own judge when there is one", async () => {
    const made = await createProject(acmeAdmin(), {
      name: "With a judge",
      defaultJudge: THE_PLATFORMS_JUDGE,
    });

    const judge = await getProjectJudge(actingIn(acme.organization, made.id, "admin"));
    expect(judge.state).toBe("configured");
    if (judge.state !== "configured") throw new Error("unreachable");
    expect(judge.judge.source).toBe("platform");
    expect(judge.judge.model).toBe("gpt-4o");
  });

  /**
   * A deployment that configured no judge of its own gives a new project none,
   * and that is a state rather than a gap. `needs_setup` is what the settings
   * page says out loud; a project silently born unjudged would look configured
   * and return errored verdicts after real calls had been paid for.
   */
  it("starts a project in needs_setup on a deployment with no judge of its own", async () => {
    const made = await createProject(acmeAdmin(), { name: "No judge here" });

    const judge = await getProjectJudge(actingIn(acme.organization, made.id, "admin"));
    expect(judge.state).toBe("needs_setup");
  });

  /**
   * The transaction, proven by breaking something inside it.
   *
   * A key too short to be any provider's is refused by the judge row's own
   * validation — which happens after the project row and seeded grader have
   * already been inserted. If those writes used separate transactions, the
   * project and grader would survive; because they use one, nothing does.
   */
  it("writes nothing at all when any part of the create is refused", async () => {
    const before = await listProjects(acmeAdmin());

    await expect(
      createProject(acmeAdmin(), {
        name: "Half a project",
        defaultJudge: { ...THE_PLATFORMS_JUDGE, key: "short" },
      }),
    ).rejects.toThrow(UnprocessableInputError);

    const after = await listProjects(acmeAdmin());
    expect(after.map((one) => one.name)).toEqual(before.map((one) => one.name));
    expect(after.some((one) => one.name === "Half a project")).toBe(false);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from persona where project_id not in (select id from project)",
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("refuses a project with no name", async () => {
    await expect(createProject(acmeAdmin(), { name: "   " })).rejects.toThrow(
      UnprocessableInputError,
    );
  });
});

describe("the slug a project is known by", () => {
  it("comes from the name, and is numbered past whatever already holds it", async () => {
    const first = await createProject(acmeAdmin(), { name: "Support desk" });
    const second = await createProject(acmeAdmin(), { name: "Support desk" });
    const third = await createProject(acmeAdmin(), { name: "Support desk!" });

    expect(first.slug).toBe("support-desk");
    expect(second.slug).toBe("support-desk-2");
    expect(third.slug).toBe("support-desk-3");
  });

  /**
   * The numbering is worked out from the name and from what the organization
   * already holds, and from nothing else — so it is the same answer every time
   * rather than a random suffix nobody could have predicted or typed.
   */
  it("gives the same answer twice for the same name and the same neighbours", async () => {
    const mine = await createProject(acmeAdmin(), { name: "Deterministic" });
    const theirs = await createProject(
      actingIn(globex.organization, globex.project, "admin", bob),
      { name: "Deterministic" },
    );

    // One organization's slugs are not the other's, so both take the first.
    expect(mine.slug).toBe("deterministic");
    expect(theirs.slug).toBe("deterministic");
  });

  it("refuses a slug an admin typed that a living project already holds", async () => {
    await createProject(acmeAdmin(), { name: "Taken", slug: "taken" });

    await expect(
      createProject(acmeAdmin(), { name: "Also taken", slug: "taken" }),
    ).rejects.toThrow(ProjectSlugTakenError);
  });
});

describe("editing a project", () => {
  it("writes the name, the description and the slug, and moves the revision", async () => {
    const made = await createProject(acmeAdmin(), { name: "Before" });

    const edited = await updateProject(acmeAdmin(), made.id, {
      name: "After",
      description: "  What this one is for.  ",
      slug: "After Renamed",
      expectedRevision: made.revision,
    });

    expect(edited?.name).toBe("After");
    expect(edited?.description).toBe("What this one is for.");
    expect(edited?.slug).toBe("after-renamed");
    expect(edited?.revision).not.toBe(made.revision);
  });

  it("keeps a field the edit did not name", async () => {
    const made = await createProject(acmeAdmin(), {
      name: "Partial",
      description: "Kept",
    });

    const edited = await updateProject(acmeAdmin(), made.id, { name: "Renamed" });
    expect(edited?.description).toBe("Kept");
  });

  /**
   * Two admins with the same project open in two tabs. The second write names
   * the revision the first one moved off, and is refused **without writing** —
   * which is the half worth proving, because a refusal that had already written
   * would be a refusal in name only.
   */
  it("refuses a write against a revision the project has moved off, and changes nothing", async () => {
    const made = await createProject(acmeAdmin(), { name: "Contested" });
    const stale = made.revision;

    await updateProject(acmeAdmin(), made.id, {
      name: "The first tab won",
      expectedRevision: stale,
    });

    await expect(
      updateProject(acmeAdmin(), made.id, {
        name: "The second tab lost",
        expectedRevision: stale,
      }),
    ).rejects.toThrow(IdentityConflictError);

    const now = await readProject(actingIn(acme.organization, made.id, "admin"));
    expect(now?.name).toBe("The first tab won");
  });

  it("refuses a slug another living project of the organization already holds", async () => {
    const held = await createProject(acmeAdmin(), { name: "Holds it", slug: "held" });
    const other = await createProject(acmeAdmin(), { name: "Wants it" });

    await expect(
      updateProject(acmeAdmin(), other.id, {
        slug: "held",
        expectedRevision: other.revision,
      }),
    ).rejects.toThrow(ProjectSlugTakenError);

    expect(held.slug).toBe("held");
  });

  /**
   * The project boundary, from the other side. Globex's admin naming Acme's
   * project is answered the way reading it would be — nothing there — rather
   * than with a refusal that confirms the id names something.
   */
  it("answers nothing for a project of another organization", async () => {
    const acmes = await createProject(acmeAdmin(), { name: "Not theirs" });

    const edited = await updateProject(
      actingIn(globex.organization, globex.project, "admin", bob),
      acmes.id,
      { name: "Theirs now" },
    );

    expect(edited).toBeUndefined();

    const still = await readProject(actingIn(acme.organization, acmes.id, "admin"));
    expect(still?.name).toBe("Not theirs");
  });
});

describe("who may create and edit a project", () => {
  const refused: readonly Role[] = ["viewer", "member"];

  it.each(refused)("refuses a %s creating one", async (role) => {
    await expect(
      createProject(actingIn(acme.organization, acme.project, role), {
        name: "Not yours to make",
      }),
    ).rejects.toThrow(NotPermittedError);
  });

  it.each(refused)("refuses a %s editing one", async (role) => {
    const made = await createProject(acmeAdmin(), { name: `Guarded from ${role}` });

    await expect(
      updateProject(actingIn(acme.organization, acme.project, role), made.id, {
        name: "Renamed by somebody who may not",
      }),
    ).rejects.toThrow(NotPermittedError);

    const still = await readProject(actingIn(acme.organization, made.id, "admin"));
    expect(still?.name).toBe(`Guarded from ${role}`);
  });
});

describe("the organization's own name", () => {
  it("is changed by an admin, and the slug is left alone", async () => {
    const before = await readOrganization(acmeAdmin());

    const renamed = await updateOrganization(acmeAdmin(), { name: "Acme Voice" });

    expect(renamed?.name).toBe("Acme Voice");
    expect(renamed?.slug).toBe(before?.slug);
  });

  it("refuses an empty name", async () => {
    await expect(
      updateOrganization(acmeAdmin(), { name: "  " }),
    ).rejects.toThrow(UnprocessableInputError);
  });

  it.each(["viewer", "member"] as const)("refuses a %s", async (role) => {
    await expect(
      updateOrganization(actingIn(acme.organization, acme.project, role), {
        name: "Renamed by somebody who may not",
      }),
    ).rejects.toThrow(NotPermittedError);

    const still = await readOrganization(acmeAdmin());
    expect(still?.name).not.toBe("Renamed by somebody who may not");
  });
});
