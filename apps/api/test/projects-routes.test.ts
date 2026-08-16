import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp } from "./support/traces.ts";

/**
 * The Settings surface over HTTP: the organization a session is in, and the
 * projects it holds.
 *
 * **These are the routes a Settings page administers rather than works in**, so
 * the two things worth proving are who may and what is answered to somebody who
 * may not. Every refusal here is quoted word for word: a page shows the
 * sentence unchanged, so the wording is the contract and not decoration.
 *
 * The role is real rather than asserted. A colleague is invited, follows the
 * link and mints their own key exactly the way the product does it, because a
 * key carries no role of its own and acts at its creator's current one.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const THE_PLATFORMS_JUDGE = {
  provider: "openai",
  model: "gpt-4o",
  key: "sk-the-self-hoster-supplied-this-WXYZ",
} as const;

type Answer = { status: number; body: Record<string, unknown> };

async function request(
  method: "GET" | "POST" | "PATCH",
  url: string,
  headers: Record<string, string>,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

describe("listing the organization's projects", () => {
  it("answers every project, and says whether this role may make another", async () => {
    api = await createApi("projects_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Outbound",
    });

    const listed = await request("GET", "/api/projects", { cookie: ada.cookie });
    expect(listed.status).toBe(200);
    const items = listed.body.items as { name: string; revision: string }[];
    expect(items.map((one) => one.name)).toEqual(["Default", "Outbound"]);
    // The revision travels with every row, because a Settings form has to send
    // back the one it was opened at.
    expect(items.every((one) => one.revision.startsWith("rev_"))).toBe(true);
    expect(listed.body.may_manage_projects).toBe(true);
  });

  /**
   * Reading the list is not what roles are for: every member of an organization
   * may work in every project of it, so a viewer who could not list them could
   * not choose one. What the answer withholds is the *control*, not the data.
   */
  it("lets a viewer read the list and tells them they may not add to it", async () => {
    api = await createApi("projects_list_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const val = await colleagueOf(api.app, ada, "val@acme.example", "viewer");

    const listed = await request("GET", "/api/projects", { cookie: val.cookie });
    expect(listed.status).toBe(200);
    expect((listed.body.items as unknown[]).length).toBe(1);
    expect(listed.body.may_manage_projects).toBe(false);
  });

  it("does not answer with another organization's project", async () => {
    api = await createApi("projects_list_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await signUp(api.app, "bob@globex.example", "Globex");

    const theirs = await request("POST", "/api/projects", { cookie: bob.cookie }, {
      name: "Theirs",
    });
    expect(theirs.status).toBe(201);

    const listed = await request("GET", "/api/projects", { cookie: ada.cookie });
    const ids = (listed.body.items as { id: string }[]).map((one) => one.id);
    expect(ids).not.toContain(theirs.body.id);
  });

  /**
   * A project of another organization is an absence, in the selector's own
   * words. Following a stranger's link must never reveal whether the thing on
   * the other end exists.
   */
  it("answers a project of another organization as one that is not here", async () => {
    api = await createApi("projects_read_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await signUp(api.app, "bob@globex.example", "Globex");

    const read = await request(
      "GET",
      `/api/projects/${bob.projectId}`,
      { cookie: ada.cookie },
    );

    expect(read.status).toBe(404);
    expect(read.body.error).toBe("project_outside_organization");
    expect(read.body.message).toBe(
      `There is no project ${bob.projectId} available to this organization. ` +
        "Choose a project from the selector and try again.",
    );
  });
});

describe("creating a project", () => {
  it("derives the slug from the name and numbers it past a collision", async () => {
    api = await createApi("projects_create_slug");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const first = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Outbound sales",
      description: "  Cold calls.  ",
    });
    const second = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Outbound sales",
    });

    expect(first.status).toBe(201);
    expect(first.body.slug).toBe("outbound-sales");
    expect(first.body.description).toBe("Cold calls.");
    expect(second.body.slug).toBe("outbound-sales-2");
  });

  it("refuses a slug an admin typed that a living project already holds", async () => {
    api = await createApi("projects_create_slug_taken");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Outbound",
      slug: "outbound",
    });
    const again = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Outbound again",
      slug: "outbound",
    });

    expect(again.status).toBe(409);
    expect(again.body.error).toBe("project_slug_taken");
    expect(again.body.message).toBe(
      "Project slug outbound is already in use in this organization. " +
        "Choose a different slug and save the project again.",
    );
  });

  /**
   * The whole factory, proven from outside: the project the route made is
   * usable, which means it has a default persona to give the first test and a
   * judge to grade the first run.
   */
  it("makes a project that is born with a default persona and this deployment's judge", async () => {
    api = await createApi("projects_create_whole", {
      defaultJudge: THE_PLATFORMS_JUDGE,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Whole",
    });
    expect(made.status).toBe(201);

    const personas = await request(
      "GET",
      `/api/personas?project=${String(made.body.id)}`,
      { cookie: ada.cookie },
    );
    expect((personas.body.items as unknown[]).length).toBe(1);

    const judge = await request(
      "GET",
      `/api/judge?project=${String(made.body.id)}`,
      { cookie: ada.cookie },
    );
    expect(judge.body.state).toBe("configured");
    expect(judge.body.source).toBe("platform");
  });

  it("starts a project in needs_setup where the deployment configured no judge", async () => {
    api = await createApi("projects_create_needs_setup", {
      defaultJudge: null,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "Unjudged",
    });

    const judge = await request(
      "GET",
      `/api/judge?project=${String(made.body.id)}`,
      { cookie: ada.cookie },
    );
    expect(judge.body.state).toBe("needs_setup");
  });

  it("refuses a project with no name", async () => {
    api = await createApi("projects_create_unnamed");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await request("POST", "/api/projects", { cookie: ada.cookie }, {
      name: "   ",
    });
    expect(made.status).toBe(422);
  });
});

describe("who may change project settings", () => {
  /**
   * The server is the boundary and the browser is not. Every one of these is a
   * request made with no page involved.
   */
  it.each(["viewer", "member"] as const)("refuses a %s creating one", async (role) => {
    api = await createApi(`projects_create_${role}`);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const them = await colleagueOf(api.app, ada, `${role}@acme.example`, role);

    const made = await request("POST", "/api/projects", { cookie: them.cookie }, {
      name: "Not yours to make",
    });

    expect(made.status).toBe(403);
    expect(made.body.error).toBe("not_permitted");
    expect(made.body.message).toBe(
      `Your ${role} role cannot create a project. Ask an organization admin ` +
        "to change your role, then try again.",
    );

    const listed = await request("GET", "/api/projects", { cookie: ada.cookie });
    expect((listed.body.items as { name: string }[]).map((one) => one.name)).toEqual([
      "Default",
    ]);
  });

  it.each(["viewer", "member"] as const)("refuses a %s editing one", async (role) => {
    api = await createApi(`projects_edit_${role}`);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const them = await colleagueOf(api.app, ada, `${role}@acme.example`, role);

    const edited = await request(
      "PATCH",
      `/api/projects/${ada.projectId}`,
      { cookie: them.cookie },
      { name: "Renamed by somebody who may not" },
    );

    expect(edited.status).toBe(403);
    expect(edited.body.message).toBe(
      `Your ${role} role cannot change project settings. Ask an organization ` +
        "admin to change your role, then try again.",
    );

    const read = await request("GET", `/api/projects/${ada.projectId}`, {
      cookie: ada.cookie,
    });
    expect(read.body.name).toBe("Default");
  });

  it("refuses an admin of another organization, without confirming the project exists", async () => {
    api = await createApi("projects_edit_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await signUp(api.app, "bob@globex.example", "Globex");

    const edited = await request(
      "PATCH",
      `/api/projects/${ada.projectId}`,
      { cookie: bob.cookie },
      { name: "Ours now" },
    );

    expect(edited.status).toBe(404);
    expect(edited.body.error).toBe("project_outside_organization");

    const read = await request("GET", `/api/projects/${ada.projectId}`, {
      cookie: ada.cookie,
    });
    expect(read.body.name).toBe("Default");
  });
});

describe("editing a project", () => {
  it("writes only what the body named, against the revision the form was opened at", async () => {
    api = await createApi("projects_edit_partial");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const before = await request("GET", `/api/projects/${ada.projectId}`, {
      cookie: ada.cookie,
    });

    const edited = await request(
      "PATCH",
      `/api/projects/${ada.projectId}`,
      { cookie: ada.cookie },
      {
        description: "What this one is for.",
        expected_revision: String(before.body.revision),
      },
    );

    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe("Default");
    expect(edited.body.description).toBe("What this one is for.");
    expect(edited.body.revision).not.toBe(before.body.revision);
  });

  /**
   * Two admins with the same form open. The second save names the revision the
   * first one moved off and is refused with the sentence that says what to do
   * next — and the project is left as the first save made it.
   */
  it("refuses a stale write with the exact conflict sentence, and writes nothing", async () => {
    api = await createApi("projects_edit_stale");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const opened = await request("GET", `/api/projects/${ada.projectId}`, {
      cookie: ada.cookie,
    });
    const stale = String(opened.body.revision);

    await request(
      "PATCH",
      `/api/projects/${ada.projectId}`,
      { cookie: ada.cookie },
      { name: "The first tab won", expected_revision: stale },
    );

    const second = await request(
      "PATCH",
      `/api/projects/${ada.projectId}`,
      { cookie: ada.cookie },
      { name: "The second tab lost", expected_revision: stale },
    );

    expect(second.status).toBe(409);
    expect(second.body.error).toBe("identity_conflict");
    expect(second.body.message).toBe(
      `Project ${ada.projectId} changed after you opened it. Read it again, ` +
        "keep or reapply your edits, and send the update with " +
        "expected_revision set to its new revision.",
    );

    const now = await request("GET", `/api/projects/${ada.projectId}`, {
      cookie: ada.cookie,
    });
    expect(now.body.name).toBe("The first tab won");
  });
});

describe("the organization a session is in", () => {
  it("answers its name and slug, and whether this role may change them", async () => {
    api = await createApi("organization_read");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const val = await colleagueOf(api.app, ada, "val@acme.example", "viewer");

    const mine = await request("GET", "/api/organization", { cookie: ada.cookie });
    expect(mine.status).toBe(200);
    expect(mine.body.name).toBe("Acme");
    expect(mine.body.may_manage_organization).toBe(true);

    const theirs = await request("GET", "/api/organization", { cookie: val.cookie });
    expect(theirs.body.name).toBe("Acme");
    expect(theirs.body.may_manage_organization).toBe(false);
  });

  it("is renamed by an admin, and the slug is left where it was", async () => {
    api = await createApi("organization_rename");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const before = await request("GET", "/api/organization", { cookie: ada.cookie });
    const renamed = await request(
      "PATCH",
      "/api/organization",
      { cookie: ada.cookie },
      { name: "Acme Voice" },
    );

    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe("Acme Voice");
    expect(renamed.body.slug).toBe(before.body.slug);
  });

  it.each(["viewer", "member"] as const)("refuses a %s renaming it", async (role) => {
    api = await createApi(`organization_rename_${role}`);
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const them = await colleagueOf(api.app, ada, `${role}@acme.example`, role);

    const renamed = await request(
      "PATCH",
      "/api/organization",
      { cookie: them.cookie },
      { name: "Renamed by somebody who may not" },
    );

    expect(renamed.status).toBe(403);
    expect(renamed.body.message).toBe(
      `Your ${role} role cannot change organization settings. Ask an ` +
        "organization admin to change your role, then try again.",
    );

    const still = await request("GET", "/api/organization", { cookie: ada.cookie });
    expect(still.body.name).toBe("Acme");
  });

  it("refuses an empty name", async () => {
    api = await createApi("organization_rename_empty");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const renamed = await request(
      "PATCH",
      "/api/organization",
      { cookie: ada.cookie },
      { name: "  " },
    );
    expect(renamed.status).toBe(422);
  });
});
