import { createProject } from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, mintKey, signUp } from "./support/traces.ts";

/**
 * Which project a **browser** request works in.
 *
 * A browser names its project in the request, every request, because the
 * project a tab is looking at lives in that tab's address and nowhere else.
 * Two tabs on two projects are an ordinary thing for one person to have open,
 * and neither can be right if the server keeps one chosen project per session.
 *
 * So a session's project is a **default, not a scope**: every member of an
 * organization holds their organization role on every project in it, and
 * naming a sibling is what the selector does. An API key is the opposite — one
 * minted for a project is bounded by it — and the two are proved apart here.
 *
 * The refusal is quoted word for word. It is the sentence a page shows
 * somebody who followed a link into a project that is not theirs, so the
 * wording is the contract.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function listAgentsAs(
  cookieOrKey: Record<string, string>,
  project: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "GET",
    url: `/api/agents?project=${project}`,
    headers: cookieOrKey,
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function registration(name: string, project: string): Record<string, unknown> {
  return {
    name,
    project,
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: `agent_for_${name.replace(/\W/g, "")}` },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  };
}

describe("a browser naming a project", () => {
  it("reads any project of its own organization, not only the oldest", async () => {
    api = await createApi("browser_sibling_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    await api.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Front desk", ada.projectId),
    });
    await api.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${ada.secret}` },
      payload: registration("Outbound desk", outbound.id),
    });

    const first = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect(first.status).toBe(200);
    expect((first.body.items as { name: string }[]).map((one) => one.name)).toEqual([
      "Front desk",
    ]);

    // The second tab. Nothing about the first request narrowed this one.
    const second = await listAgentsAs({ cookie: ada.cookie }, outbound.id);
    expect(second.status).toBe(200);
    expect(
      (second.body.items as { name: string }[]).map((one) => one.name),
    ).toEqual(["Outbound desk"]);

    // And the first tab still reads its own project afterwards.
    const again = await listAgentsAs({ cookie: ada.cookie }, ada.projectId);
    expect((again.body.items as { name: string }[]).map((one) => one.name)).toEqual([
      "Front desk",
    ]);
  });

  it("is refused a project of another organization, and told so as an absence", async () => {
    api = await createApi("browser_foreign_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await listAgentsAs({ cookie: ada.cookie }, grace.projectId);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${grace.projectId} available to this ` +
        "organization. Choose a project from the selector and try again.",
    });
  });

  it("is refused a project that never existed, in the same words", async () => {
    api = await createApi("browser_unknown_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const invented = newId("prj");

    const refused = await listAgentsAs({ cookie: ada.cookie }, invented);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${invented} available to this organization. ` +
        "Choose a project from the selector and try again.",
    });
  });

  /**
   * The asymmetry, stated as its own promise. A key minted for one project may
   * not use the browser's rule to reach a sibling — the selector's freedom
   * belongs to a person's membership, not to a credential's scope.
   */
  it("does not widen an API key minted for one project", async () => {
    api = await createApi("browser_does_not_widen_keys");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const forDefault = await mintKey(
      api.app,
      ada.cookie,
      "default only",
      ada.projectId,
    );

    const refused = await listAgentsAs(
      { authorization: `Bearer ${forDefault}` },
      outbound.id,
    );

    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_permitted");
  });
});
