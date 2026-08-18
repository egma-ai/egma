import {
  archiveAgent,
  archivePersona,
  createAgent,
  createPersona,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  NEUTRAL_TRAITS,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The browser's half of the test surface, over real HTTP against real Postgres:
 * the applicable-agent editor, the lifecycle, clone, the version history, and
 * the capability catalog the editor draws from.
 *
 * What is asserted here is what a page observes — the codes, the sentences word
 * for word, and which control a viewer's request is refused by. The factory
 * beneath has its own tests and none of them are repeated; what is new at this
 * seam is the wire.
 *
 * Every request carries its project in the address or its body, because every
 * product page does: there is no chosen project anywhere but the address.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: [
    "verifies who it is speaking to before discussing the booking",
    "confirms the new time back before finishing",
  ],
} as const;

/** One browser request: a session cookie, and the project in the address. */
async function browse(
  method: "GET" | "POST" | "PATCH",
  url: string,
  who: Customer,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: { cookie: who.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function author(person: Customer): AuthContext {
  return contextFor(person, "member");
}

/** An agent for the project's tests to apply to. */
async function anAgent(person: Customer, name: string): Promise<string> {
  const created = await createAgent(author(person), { name });
  return created.id;
}

type WireTest = {
  id: string;
  version: number;
  version_id: string;
  revision: string;
  applicability_revision: string;
  archived_at: string | null;
  archive_reason: string | null;
  agents: { id: string; name: string; archived_at: string | null }[];
  required_capabilities: string[];
  override_count: number;
};

function testIn(answer: Answer): WireTest {
  return answer.body as unknown as WireTest;
}

/** A world with one agent and one test applying to it. */
async function aProjectWithATest(
  label: string,
): Promise<{ ada: Customer; agentId: string; test: WireTest }> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const agentId = await anAgent(ada, "Front desk");

  const created = await browse("POST", "/api/tests", ada, {
    ...RESCHEDULING,
    project: ada.projectId,
    agents: [agentId],
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

  return { ada, agentId, test: testIn(created) };
}

describe("the capability catalog a test editor draws from", () => {
  it("is the server's own list, with a label and a sentence for each key", async () => {
    api = await createApi("tests_capability_catalog");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // The catalog the connection forms already draw from, and deliberately not
    // a second one: a requirement and a measurement have to name the same key.
    const listed = await browse("GET", "/api/capabilities", ada);

    expect(listed.statusCode).toBe(200);
    const items = listed.body.items as { key: string; label: string }[];
    // The editor is told rather than knowing: a form with its own copy would be
    // free to offer a key the platform refuses.
    expect(items.map((entry) => entry.key)).toEqual([
      "dtmf",
      "barge_in",
      "raw_audio",
    ]);
    for (const entry of items) {
      expect(entry.label).not.toBe("");
    }
  });

  it("refuses a key that is not on it, and names the key", async () => {
    const { ada, agentId } = await aProjectWithATest("tests_capability_unknown");

    const refused = await browse("POST", "/api/tests", ada, {
      ...RESCHEDULING,
      name: "Needs telepathy",
      project: ada.projectId,
      agents: [agentId],
      required_capabilities: ["telepathy"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unknown_capability",
      message:
        "Capability telepathy is not in this Egma capability catalog. Choose " +
        "a capability offered by the test editor and save the test again.",
    });
  });
});

describe("creating a test from a browser", () => {
  it("refuses one that names no agent, in the product's own words", async () => {
    api = await createApi("tests_create_needs_agent");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await browse("POST", "/api/tests", ada, {
      ...RESCHEDULING,
      project: ada.projectId,
      agents: [],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "test_needs_agent",
      message:
        "Every test must apply to at least one active agent. Select an " +
        "active agent and save the test again.",
    });
  });

  it("answers the agents it applies to, and its three tokens", async () => {
    const { agentId, test } = await aProjectWithATest("tests_create_agents");

    expect(test.agents).toEqual([
      { id: agentId, name: "Front desk", archived_at: null },
    ]);
    expect(test.revision).toMatch(/^rev_/u);
    expect(test.applicability_revision).toMatch(/^rev_/u);
    // Three tokens, never two of one: an edit written against one must not be
    // accepted against another.
    expect(test.revision).not.toBe(test.applicability_revision);
    expect(test.archived_at).toBeNull();
  });
});

describe("the agents a test applies to", () => {
  it("is set through its own door, and mints no version", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_link_agents");
    const second = await anAgent(ada, "Front desk, weekend");

    const linked = await browse(
      "POST",
      `/api/tests/${test.id}/agents?project=${ada.projectId}`,
      ada,
      {
        agents: [agentId, second],
        expected_applicability_revision: test.applicability_revision,
      },
    );

    expect(linked.statusCode, JSON.stringify(linked.body)).toBe(200);
    const changed = testIn(linked);
    expect(changed.agents.map((applies) => applies.id).sort()).toEqual(
      [agentId, second].sort(),
    );
    // Target coverage is not test content and not the test's live identity.
    expect(changed.version_id).toBe(test.version_id);
    expect(changed.revision).toBe(test.revision);
    expect(changed.applicability_revision).not.toBe(
      test.applicability_revision,
    );
  });

  it("refuses removing the last one, and names the agent going out", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_last_link");

    const refused = await browse("POST", `/api/tests/${test.id}/agents`, ada, {
      project: ada.projectId,
      agents: [],
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "last_test_agent",
      message:
        `Test ${test.id} must apply to at least one agent. Link another ` +
        `active agent before you remove ${agentId}.`,
    });
  });

  it("refuses an agent that is not active in this project", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_link_archived");
    const retiring = await anAgent(ada, "Retiring desk");
    await archiveAgent(author(ada), retiring);

    const refused = await browse("POST", `/api/tests/${test.id}/agents`, ada, {
      project: ada.projectId,
      agents: [agentId, retiring],
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "agent_not_available",
      message:
        `Agent ${retiring} is not active in this project. Choose an active ` +
        "agent from this project's Agents page.",
    });
  });

  it("refuses a link edit written against an applicability revision it has moved past", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_link_stale");
    const second = await anAgent(ada, "Front desk, weekend");

    await browse("POST", `/api/tests/${test.id}/agents`, ada, {
      project: ada.projectId,
      agents: [agentId, second],
      expected_applicability_revision: test.applicability_revision,
    });

    const refused = await browse("POST", `/api/tests/${test.id}/agents`, ada, {
      project: ada.projectId,
      agents: [second],
      expected_applicability_revision: test.applicability_revision,
    });

    // Its own code beside the identity and version conflicts, because the
    // caller's next move is different: reread the links, not the name.
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "applicability_conflict",
      message:
        `Test ${test.id}'s applicable agents changed after you opened it. ` +
        "Read the test again, keep or reapply your link changes, and send " +
        "them with expected_applicability_revision set to its new " +
        "applicability revision.",
    });
  });

  it("is refused to a viewer, whatever the browser sent", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_link_viewer");
    const val = await colleagueOf(api.app, ada, "val@acme.example", "viewer");

    const refused = await browse("POST", `/api/tests/${test.id}/agents`, val, {
      project: ada.projectId,
      agents: [agentId],
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        "Your viewer role cannot change which agents a test applies to. Ask " +
        "an organization admin to change your role, then try again.",
    });
  });
});

describe("the two stale-write refusals a test editor can meet", () => {
  it("answers an identity conflict for a rename written against an old revision", async () => {
    const { ada, test } = await aProjectWithATest("tests_identity_conflict");

    const renamed = await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      name: "Renamed once",
      expected_revision: test.revision,
    });
    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);

    const refused = await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      name: "Renamed twice",
      expected_revision: test.revision,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "identity_conflict",
      message:
        `Test ${test.id} changed after you opened it. Read it again, keep or ` +
        "reapply your edits, and send the update with expected_revision set " +
        "to its new revision.",
    });
  });

  it("lets a rename through while somebody else is editing the scenario", async () => {
    const { ada, test } = await aProjectWithATest("tests_two_tokens");

    // One tab sharpens the scenario…
    const moved = await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      scenario: "They call from the station, and the line is poor.",
      expected_version_id: test.version_id,
    });
    expect(moved.statusCode).toBe(200);

    // …and the other saves a name typed before that landed. Two tokens is
    // exactly what makes this work: the identity has not moved.
    const renamed = await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      name: "Renamed while the scenario moved",
      expected_revision: test.revision,
    });
    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
    expect(testIn(renamed).version).toBe(2);
  });
});

describe("archiving and restoring a test", () => {
  it("keeps its links and its history, and shows it under the archive filter", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_archive");

    const archived = await browse(
      "POST",
      `/api/tests/${test.id}/archive?project=${ada.projectId}`,
      ada,
      { expected_revision: test.revision },
    );

    expect(archived.statusCode, JSON.stringify(archived.body)).toBe(200);
    expect(testIn(archived).archived_at).toEqual(expect.any(String));
    // Nobody was owed a reason: a person archiving a test knows why.
    expect(testIn(archived).archive_reason).toBeNull();
    expect(testIn(archived).agents.map((applies) => applies.id)).toEqual([
      agentId,
    ]);

    const active = await browse(
      "GET",
      `/api/tests?project=${ada.projectId}`,
      ada,
    );
    expect((active.body.items as WireTest[]).map((one) => one.id)).not.toContain(
      test.id,
    );

    const shelved = await browse(
      "GET",
      `/api/tests?project=${ada.projectId}&archived=true`,
      ada,
    );
    expect((shelved.body.items as WireTest[]).map((one) => one.id)).toEqual([
      test.id,
    ]);
  });

  it("refuses Restore while the current version names an archived persona", async () => {
    const { ada, agentId } = await aProjectWithATest("tests_restore_blocked");
    const leaving = await createPersona(author(ada), {
      name: "Leaving Lena",
      traits: NEUTRAL_TRAITS,
    });

    const created = await browse("POST", "/api/tests", ada, {
      ...RESCHEDULING,
      name: "Names somebody who leaves",
      project: ada.projectId,
      agents: [agentId],
      personas: ["Leaving Lena"],
    });
    const subject = testIn(created);

    await browse("POST", `/api/tests/${subject.id}/archive`, ada, {
      project: ada.projectId,
    });
    await archivePersona(author(ada), leaving.id);

    const refused = await browse("POST", `/api/tests/${subject.id}/restore`, ada, {
      project: ada.projectId,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("test_dependency_inactive");
    expect(String(refused.body.message)).toContain(
      `Test ${subject.id} cannot be restored because persona ${leaving.id}`,
    );
    expect(String(refused.body.message)).toContain(
      "in its current version are archived. Restore those resources, then " +
        "restore the test.",
    );
  });

  it("brings it back, with a linkless one taking an agent in the same request", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_restore_links");

    await browse("POST", `/api/tests/${test.id}/archive`, ada, {
      project: ada.projectId,
    });
    // The state only an upgrade can produce: archived, with nothing to run
    // against.
    await api.database.sql("delete from test_agent where test_id = $1", [
      test.id,
    ]);

    const refused = await browse("POST", `/api/tests/${test.id}/restore`, ada, {
      project: ada.projectId,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe("test_needs_agent");

    const restored = await browse(
      "POST",
      `/api/tests/${test.id}/restore?project=${ada.projectId}`,
      ada,
      { agents: [agentId] },
    );
    expect(restored.statusCode, JSON.stringify(restored.body)).toBe(200);
    expect(testIn(restored).archived_at).toBeNull();
    expect(testIn(restored).agents.map((applies) => applies.id)).toEqual([
      agentId,
    ]);
  });
});

describe("cloning a test from a browser", () => {
  it("copies the content and the active links, and no history", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_clone");

    // A second version, so the source has a history for the clone not to copy.
    await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      scenario: "They call twice about the same booking.",
      expected_version_id: test.version_id,
    });

    const cloned = await browse(
      "POST",
      `/api/tests/${test.id}/clone?project=${ada.projectId}`,
      ada,
    );

    expect(cloned.statusCode, JSON.stringify(cloned.body)).toBe(201);
    const copy = testIn(cloned);
    expect(copy.id).not.toBe(test.id);
    expect(copy.version).toBe(1);
    expect(copy.agents.map((applies) => applies.id)).toEqual([agentId]);

    const history = await browse(
      "GET",
      `/api/tests/${copy.id}/versions?project=${ada.projectId}`,
      ada,
    );
    expect((history.body.items as unknown[]).length).toBe(1);
  });

  it("keeps the hidden mock-tool overrides, and says how many there are", async () => {
    const { ada, agentId } = await aProjectWithATest("tests_clone_overrides");

    const created = await browse("POST", "/api/tests", ada, {
      ...RESCHEDULING,
      name: "Forces the calendar's failure branch",
      project: ada.projectId,
      agents: [agentId],
      mock_tools: [
        { tool: "check_availability", error: "the calendar is unreachable" },
      ],
    });
    const subject = testIn(created);
    expect(subject.override_count).toBe(1);

    // A browser write never mentions them — the form does not edit them — and
    // leaving the field out has to mean keep.
    const renamed = await browse("PATCH", `/api/tests/${subject.id}`, ada, {
      project: ada.projectId,
      name: "Renamed, overrides untouched",
      expected_revision: subject.revision,
    });
    expect(testIn(renamed).override_count).toBe(1);

    const cloned = await browse("POST", `/api/tests/${subject.id}/clone`, ada, {
      project: ada.projectId,
    });
    expect(testIn(cloned).override_count).toBe(1);
  });
});

describe("reading a test's history", () => {
  it("answers every version, newest first, saying which one is current", async () => {
    const { ada, test } = await aProjectWithATest("tests_history");

    const second = await browse("PATCH", `/api/tests/${test.id}`, ada, {
      project: ada.projectId,
      scenario: "They call from the station, and the line is poor.",
      expected_version_id: test.version_id,
    });

    const history = await browse(
      "GET",
      `/api/tests/${test.id}/versions?project=${ada.projectId}`,
      ada,
    );

    expect(history.statusCode).toBe(200);
    const items = history.body.items as {
      id: string;
      version: number;
      current: boolean;
      scenario: string;
    }[];
    expect(items.map((one) => one.version)).toEqual([2, 1]);
    expect(items[0]?.current).toBe(true);
    expect(items[1]?.current).toBe(false);
    // The older version reads exactly as it was written, which is the whole
    // point of keeping it.
    expect(items[1]?.scenario).toBe(RESCHEDULING.scenario);
    expect(items[0]?.id).toBe(testIn(second).version_id);
  });

  it("is not found for a test this credential could not have read", async () => {
    const { ada, test } = await aProjectWithATest("tests_history_tenancy");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await browse(
      "GET",
      `/api/tests/${test.id}/versions?project=${grace.projectId}`,
      grace,
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message:
        `There is no test ${test.id} available in this project. Check the ` +
        "link, or choose it from the current project.",
    });
    expect(ada.projectId).not.toBe(grace.projectId);
  });
});

describe("filtering the list", () => {
  it("narrows to the tests that apply to one agent", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_filter_agent");
    const second = await anAgent(ada, "Front desk, weekend");
    const elsewhere = await browse("POST", "/api/tests", ada, {
      ...RESCHEDULING,
      name: "Applies to the weekend desk alone",
      project: ada.projectId,
      agents: [second],
    });

    const page = await browse(
      "GET",
      `/api/tests?project=${ada.projectId}&agent=${agentId}`,
      ada,
    );

    expect((page.body.items as WireTest[]).map((one) => one.id)).toEqual([
      test.id,
    ]);
    expect(testIn(elsewhere).id).not.toBe(test.id);
  });

  it("narrows by name, ignoring case", async () => {
    const { ada, test } = await aProjectWithATest("tests_filter_name");

    const page = await browse(
      "GET",
      `/api/tests?project=${ada.projectId}&name=${encodeURIComponent("reschedules a")}`,
      ada,
    );

    expect((page.body.items as WireTest[]).map((one) => one.id)).toEqual([
      test.id,
    ]);
  });

  it("refuses a request that named no project, because a page has a selector", async () => {
    const { ada } = await aProjectWithATest("tests_filter_no_project");

    const refused = await browse("GET", "/api/tests", ada);

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "project_required",
      message:
        "This request did not name a project. Choose a project from the " +
        "selector and try again.",
    });
  });

  it("answers an absence for a project this organization does not hold", async () => {
    const { ada } = await aProjectWithATest("tests_filter_stranger");
    const stranger = newId("prj");

    const refused = await browse("GET", `/api/tests?project=${stranger}`, ada);

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "project_outside_organization",
      message:
        `There is no project ${stranger} available to this organization. ` +
        "Choose a project from the selector and try again.",
    });
  });
});

describe("a viewer", () => {
  it("reads every test and its history, and writes none of it", async () => {
    const { ada, agentId, test } = await aProjectWithATest("tests_viewer");
    const val = await colleagueOf(api.app, ada, "val@acme.example", "viewer");

    const read = await browse(
      "GET",
      `/api/tests/${test.id}?project=${ada.projectId}`,
      val,
    );
    expect(read.statusCode).toBe(200);

    const history = await browse(
      "GET",
      `/api/tests/${test.id}/versions?project=${ada.projectId}`,
      val,
    );
    expect(history.statusCode).toBe(200);

    // Hiding a control is not authorization: the server refuses each of these
    // whether or not a browser was involved.
    for (const [url, action] of [
      [`/api/tests/${test.id}/clone`, "clone tests"],
      [`/api/tests/${test.id}/archive`, "archive tests"],
      [`/api/tests/${test.id}/restore`, "restore tests"],
    ] as const) {
      const refused = await browse("POST", url, val, {
        project: ada.projectId,
      });
      expect(refused.statusCode, url).toBe(403);
      expect(refused.body).toEqual({
        error: "not_permitted",
        message:
          `Your viewer role cannot ${action}. Ask an organization admin to ` +
          "change your role, then try again.",
      });
    }

    const created = await browse("POST", "/api/tests", val, {
      ...RESCHEDULING,
      name: "A viewer's test",
      project: ada.projectId,
      agents: [agentId],
    });
    expect(created.statusCode).toBe(403);
  });
});
