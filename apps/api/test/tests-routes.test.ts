import {
  createPersona,
  createProject,
  createTest,
  deletePersona,
  editTest,
  type AuthContext,
  type PersonaTraits,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  mintKey,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The test routes, over real HTTP against real Postgres.
 *
 * This is the surface a developer's folder syncs against, so what is asserted
 * here is what a caller observes: the shapes, the envelope, who may do what, the
 * version-conflict flow, and every refusal sentence word for word. Refusal
 * wording is contract — a coding agent reads it and decides what to do next —
 * so a sentence that changed without somebody deciding to change it fails here.
 *
 * The factory beneath has its own tests and none of them are repeated. What is
 * new at this seam is everything the wire adds: names resolved into identity, a
 * project resolved from a credential that named none, and the codes and
 * sentences a client branches on.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** A persona, authored the only way there is: no route ships for one. */
async function personaFor(
  person: Customer,
  name: string,
  projectId = person.projectId,
): Promise<string> {
  const created = await createPersona(
    { ...contextFor(person, "member"), projectId },
    { name, traits: NEUTRAL_TRAITS },
  );
  return created.id;
}

/** Who a project points at when a test names nobody. */
async function defaultPersonaOf(projectId: string): Promise<string> {
  const { rows } = await api.database.sql<{ default_persona_id: string }>(
    "select default_persona_id from project where id = $1",
    [projectId],
  );
  const found = rows[0]?.default_persona_id;
  if (found === undefined) throw new Error("the project points at nobody");
  return found;
}

/** Which project a test landed in — a fact the wire deliberately does not say. */
async function projectOf(testId: string): Promise<string | undefined> {
  const { rows } = await api.database.sql<{ project_id: string }>(
    "select project_id from test where id = $1",
    [testId],
  );
  return rows[0]?.project_id;
}

/** How many versions a test holds — the proof that an edit minted one, or none. */
async function versionCount(testId: string): Promise<number> {
  const { rows } = await api.database.sql<{ count: string }>(
    "select count(*) as count from test_version where test_id = $1",
    [testId],
  );
  return Number(rows[0]?.count);
}

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: [
    "verifies who it is speaking to before discussing the booking",
    "confirms the new time back before finishing",
  ],
} as const;

/** The shared helper, with the app this file is driving already in hand. */
function request(
  method: "GET" | "POST" | "PATCH",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

async function createTestThrough(
  key: string,
  body: Record<string, unknown>,
): Promise<Answer> {
  return request("POST", "/api/tests", key, body);
}

describe("creating a test", () => {
  it("answers the whole test, with the version a file will pin", async () => {
    api = await createApi("tests_create");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const created = await createTestThrough(key, { ...RESCHEDULING });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: RESCHEDULING.name,
      version: 1,
      scenario: RESCHEDULING.scenario,
      expected_behaviors: [...RESCHEDULING.expected_behaviors],
    });
    expect(String(created.body.id)).toMatch(/^tst_/u);
    expect(String(created.body.version_id)).toMatch(/^tstv_/u);
    expect(created.body.created_at).toBeTypeOf("string");
    expect(await projectOf(String(created.body.id))).toBe(ada.projectId);
  });

  it("takes the project's default persona when the file names nobody", async () => {
    api = await createApi("tests_default_persona");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const starter = await defaultPersonaOf(ada.projectId);

    const named = await createTestThrough(key, { ...RESCHEDULING, personas: [] });
    const absent = await createTestThrough(key, { ...RESCHEDULING });

    for (const created of [named, absent]) {
      expect(created.statusCode).toBe(201);
      expect(created.body.personas).toEqual([
        { id: starter, name: expect.any(String) },
      ]);
    }
  });

  it("resolves personas by name, in the order the file named them", async () => {
    api = await createApi("tests_persona_names");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const omar = await personaFor(ada, "Omar");
    const rita = await personaFor(ada, "Impatient Rita");

    const created = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Impatient Rita", "Omar"],
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.personas).toEqual([
      { id: rita, name: "Impatient Rita" },
      { id: omar, name: "Omar" },
    ]);
  });

  it("resolves an identifier too, so a client holding one needs no name", async () => {
    api = await createApi("tests_persona_ids");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const omar = await personaFor(ada, "Omar");

    const created = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: [omar],
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.personas).toEqual([{ id: omar, name: "Omar" }]);
  });

  it("refuses a persona nobody in this project answers to", async () => {
    api = await createApi("tests_persona_unknown");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
      personas: ["Impatient Rita"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        'Egma has no persona called "Impatient Rita" in this project. Name a persona this project already has, or name none and Egma takes the project\'s default.',
    });

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });

  it("refuses a persona who has been deleted, in the factory's own words", async () => {
    api = await createApi("tests_persona_deleted");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const leaving = await personaFor(ada, "Leaving Soon");
    await deletePersona(contextFor(ada, "admin"), leaving);

    const byName = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Leaving Soon"],
    });

    expect(byName.statusCode).toBe(422);
    expect(byName.body).toEqual({
      error: "unprocessable",
      message: `persona ${leaving} is deleted, and a test cannot name a deleted persona`,
    });

    // Their identifier reads the same way, because it is the same problem.
    const byId = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: [leaving],
    });
    expect(byId.body).toEqual(byName.body);
  });

  it("refuses one persona named twice, because that asks for one simulation twice", async () => {
    api = await createApi("tests_persona_twice");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    await personaFor(ada, "Omar");

    const refused = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Omar", "Omar"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: 'persona "Omar" is named twice on one test; name each persona once',
    });
  });

  it("refuses personas sent as anything but text, rather than quietly dropping them", async () => {
    api = await createApi("tests_persona_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const omar = await personaFor(ada, "Omar");

    // The shape a read answers with, sent back as though it were a write's.
    const structured = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: [{ id: omar, name: "Omar" }],
    });

    expect(structured.statusCode).toBe(422);
    expect(structured.body).toEqual({
      error: "unprocessable",
      message:
        "a test names each persona as text — their name, or their prs_ " +
        'identifier — and one entry in personas is neither. Send it as a ' +
        'list of text, like ["impatient-caller"].',
    });

    const notAList = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: "Omar",
    });
    expect(notAList.statusCode).toBe(422);
    expect(notAList.body).toEqual({
      error: "unprocessable",
      message:
        "personas is the list of people who call about this test, by name. " +
        'Send it as a list of text, like ["impatient-caller"], or leave it ' +
        "out and Egma takes the project's default persona.",
    });

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });

  it("relays the factory's own words for a test that could never be red", async () => {
    api = await createApi("tests_validation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const nameless = await createTestThrough(key, { ...RESCHEDULING, name: "  " });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.body).toEqual({
      error: "unprocessable",
      message: "a test needs a name",
    });

    const situationless = await createTestThrough(key, {
      ...RESCHEDULING,
      scenario: "",
    });
    expect(situationless.body).toEqual({
      error: "unprocessable",
      message: "a test needs a scenario: the situation the agent is put in",
    });

    const unfalsifiable = await createTestThrough(key, {
      ...RESCHEDULING,
      expected_behaviors: [],
    });
    expect(unfalsifiable.body).toEqual({
      error: "unprocessable",
      message:
        "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    });

    const empty = await createTestThrough(key, {
      ...RESCHEDULING,
      expected_behaviors: ["   "],
    });
    expect(empty.body).toEqual({
      error: "unprocessable",
      message: "an expected behavior needs to say something",
    });

    // The shape that retired with the P0/P1/P2 ladder, named rather than
    // reported as a sentence that says nothing: somebody sending last month's
    // body is told what changed instead of being sent to look at their own
    // words for a problem that is in the envelope.
    const retired = await createTestThrough(key, {
      ...RESCHEDULING,
      expected_behaviors: [
        { behavior: "confirms the new time back", priority: "P0" },
      ],
    });
    expect(retired.body).toEqual({
      error: "unprocessable",
      message:
        'an expected behavior is a plain sentence now; the {"behavior", ' +
        '"priority"} shape retired with the P0/P1/P2 ladder. Send each ' +
        "sentence on its own.",
    });
  });
});

describe("the list of tests", () => {
  /**
   * A page holds fifty, and there is no parameter to ask for fewer: a list this
   * API answers is followed by its cursor and by nothing else. So the page size
   * is what this seeds past, and it is written here because a change to it is a
   * change a client would see.
   */
  const A_PAGE = 50;

  it("answers one envelope, newest first, and pages through with its cursor", async () => {
    api = await createApi("tests_list_envelope");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    // Seeded through the factory rather than the route: what is under test is
    // the page and its cursor, and fifty-one requests to arrange that would be
    // fifty-one requests proving nothing.
    const auth = contextFor(ada, "admin");
    const written: string[] = [];
    for (let index = 1; index <= A_PAGE + 1; index += 1) {
      const seeded = await createTest(auth, {
        name: `test ${String(index).padStart(2, "0")}`,
        scenario: RESCHEDULING.scenario,
        expectedBehaviors: [...RESCHEDULING.expected_behaviors],
      });
      written.push(seeded.id);
    }

    const page = await request("GET", "/api/tests", key);
    expect(page.statusCode).toBe(200);
    const items = page.body.items as { id: string; name: string }[];
    expect(items).toHaveLength(A_PAGE);
    // Newest first, so the last one written is the first one read.
    expect(items[0]?.id).toBe(written.at(-1));
    expect(page.body.next_cursor).toBe(items.at(-1)?.id);

    const rest = await request(
      "GET",
      `/api/tests?cursor=${String(page.body.next_cursor)}`,
      key,
    );
    const remaining = rest.body.items as { id: string }[];
    expect(remaining.map((test) => test.id)).toEqual([written[0]]);
    // Null rather than absent, so "no next page" is told from "an older shape".
    expect(rest.body.next_cursor).toBeNull();

    expect(new Set([...items, ...remaining].map((test) => test.id))).toEqual(
      new Set(written),
    );
  });

  it("shows a customer their own tests and nobody else's", async () => {
    api = await createApi("tests_list_tenancy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
      name: "Acme's",
    });

    const listed = await request(
      "GET",
      "/api/tests",
      await projectKeyFor(api.app, grace),
    );

    expect(listed.statusCode).toBe(200);
    expect(listed.body).toEqual({ items: [], next_cursor: null });
  });

  it("reads the project the credential acts in, and no sibling of it", async () => {
    api = await createApi("tests_list_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
      name: "in the default",
    });

    const there = await mintKey(api.app, ada.cookie, "outbound", outbound.id);
    const listed = await request("GET", "/api/tests", there);

    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toEqual([]);
  });

  it("refuses a filter naming another customer's project, confirming nothing about it", async () => {
    api = await createApi("tests_list_across");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await request(
      "GET",
      `/api/tests?project=${grace.projectId}`,
      ada.secret,
    );

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        `this credential may not act in project ${grace.projectId}. A ` +
        `credential authorized for one project acts in that one, and a key ` +
        `for the whole organization acts in any project of that organization. ` +
        `Leave project out to use the project this credential already acts in.`,
    });
  });

  it("refuses a cursor it never issued, rather than answering a page nobody asked for", async () => {
    api = await createApi("tests_list_cursor");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await request(
      "GET",
      "/api/tests?cursor=not-a-cursor",
      await projectKeyFor(api.app, ada),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        '"not-a-cursor" is not a cursor this list issued. Send the next_cursor an earlier page answered with, or leave it out to start at the newest test.',
    });
  });
});

describe("one frozen version", () => {
  it("says which test it belongs to and that the test still stands on it", async () => {
    api = await createApi("tests_version_current");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });

    const frozen = await request(
      "GET",
      `/api/test-versions/${String(created.body.version_id)}`,
      key,
    );

    expect(frozen.statusCode).toBe(200);
    expect(frozen.body).toMatchObject({
      id: created.body.version_id,
      test_id: created.body.id,
      test_name: RESCHEDULING.name,
      version: 1,
      current: true,
      scenario: RESCHEDULING.scenario,
      expected_behaviors: [...RESCHEDULING.expected_behaviors],
    });
  });

  it("says the test has moved on once a later version exists", async () => {
    api = await createApi("tests_version_behind");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const pinned = String(created.body.version_id);

    const edited = await request(
      "PATCH",
      `/api/tests/${String(created.body.id)}`,
      key,
      {
        name: "Reschedules, renamed",
        scenario: "They want the Wednesday slot instead.",
        expected_version_id: pinned,
      },
    );
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);

    const stale = await request("GET", `/api/test-versions/${pinned}`, key);

    expect(stale.statusCode).toBe(200);
    expect(stale.body).toMatchObject({
      id: pinned,
      current: false,
      version: 1,
      // The name is identity and was never versioned, so a stale pin still
      // names the test somebody has to go and look at.
      test_name: "Reschedules, renamed",
      scenario: RESCHEDULING.scenario,
    });
  });

  it("is not found for a version this Egma never issued", async () => {
    api = await createApi("tests_version_unknown");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const missing = newId("tstv");

    const refused = await request(
      "GET",
      `/api/test-versions/${missing}`,
      await projectKeyFor(api.app, ada),
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test version ${missing} on this Egma. List the tests to see the version each of them stands on now.`,
    });
  });

  it("is not found for another customer's version, which confirms nothing", async () => {
    api = await createApi("tests_version_tenancy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const created = await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
    });
    const theirs = String(created.body.version_id);

    const refused = await request(
      "GET",
      `/api/test-versions/${theirs}`,
      await projectKeyFor(api.app, grace),
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test version ${theirs} on this Egma. List the tests to see the version each of them stands on now.`,
    });
  });
});

describe("editing a test", () => {
  it("mints the next version and leaves the one it left behind alone", async () => {
    api = await createApi("tests_edit_versions");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const edited = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "They want the Wednesday slot instead.",
      expected_version_id: created.body.version_id,
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.body).toMatchObject({
      id: testId,
      version: 2,
      scenario: "They want the Wednesday slot instead.",
    });
    expect(edited.body.version_id).not.toBe(created.body.version_id);
    expect(await versionCount(testId)).toBe(2);
  });

  it("refuses an edit that names no version, before it reads anything", async () => {
    api = await createApi("tests_edit_no_token");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const refused = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "written against nothing at all",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        "an edit says which version it was written against, and this one " +
        "named no expected_version_id. Send the version_id you last read " +
        "for this test, or read the test again and send the version it " +
        "names now.",
    });
    expect(await versionCount(testId)).toBe(1);

    // An empty one is a version nobody named, and reads the same way.
    const blank = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "written against nothing at all",
      expected_version_id: "",
    });
    expect(blank.body).toEqual(refused.body);

    // And the same edit naming the version goes through, so what was refused
    // was the missing version and nothing else about the body.
    const named = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "written against nothing at all",
      expected_version_id: created.body.version_id,
    });
    expect(named.statusCode, JSON.stringify(named.body)).toBe(200);
    expect(await versionCount(testId)).toBe(2);
  });

  it("refuses an edit written against a version the test has moved past", async () => {
    api = await createApi("tests_edit_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);
    const stale = String(created.body.version_id);

    // The teammate in the dashboard, who got there first.
    const moved = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "They want the Wednesday slot instead.",
      expected_version_id: stale,
    });
    const current = String(moved.body.version_id);

    const refused = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "They want the Friday slot instead.",
      expected_version_id: stale,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "conflict",
      message:
        `this edit was written against version ${stale}, and the test has ` +
        `moved on to ${current}. Read the test again and send the edit with ` +
        `expected_version_id set to the version it names now.`,
      test: { id: testId, name: RESCHEDULING.name },
      expected_version_id: stale,
      current_version_id: current,
    });

    // Refused and not merged: the refused edit wrote nothing at all.
    expect(await versionCount(testId)).toBe(2);
    const still = await request("GET", `/api/test-versions/${current}`, key);
    expect(still.body.scenario).toBe("They want the Wednesday slot instead.");
  });

  it("mints nothing for content byte-identical to the current version", async () => {
    api = await createApi("tests_edit_identical");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const again = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      personas: (created.body.personas as { name: string }[]).map(
        (persona) => persona.name,
      ),
      expected_version_id: created.body.version_id,
    });

    expect(again.statusCode).toBe(200);
    expect(again.body.version_id).toBe(created.body.version_id);
    expect(again.body.version).toBe(1);
    expect(await versionCount(testId)).toBe(1);
  });

  it("writes a name in place, because a name is identity and versions nothing", async () => {
    api = await createApi("tests_edit_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const renamed = await request("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      name: "Moves a booked appointment",
      personas: (created.body.personas as { name: string }[]).map(
        (persona) => persona.name,
      ),
      expected_version_id: created.body.version_id,
    });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.body.name).toBe("Moves a booked appointment");
    expect(renamed.body.version).toBe(1);
    expect(renamed.body.version_id).toBe(created.body.version_id);
    expect(await versionCount(testId)).toBe(1);
  });

  it("keeps what the body left out, so an edit to the scenario is only that", async () => {
    api = await createApi("tests_edit_partial");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });

    const edited = await request(
      "PATCH",
      `/api/tests/${String(created.body.id)}`,
      key,
      {
        scenario: "They want the Wednesday slot instead.",
        expected_version_id: created.body.version_id,
      },
    );

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({
      name: RESCHEDULING.name,
      expected_behaviors: [...RESCHEDULING.expected_behaviors],
      personas: created.body.personas,
      version: 2,
    });
  });

  it("is not found for a test this credential could not have read", async () => {
    api = await createApi("tests_edit_tenancy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const created = await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
    });
    const theirs = String(created.body.id);

    const refused = await request(
      "PATCH",
      `/api/tests/${theirs}`,
      await projectKeyFor(api.app, grace),
      {
        ...RESCHEDULING,
        scenario: "reaching across",
        expected_version_id: created.body.version_id,
      },
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test ${theirs} on this Egma. List the tests to see what this project holds, or create this one instead of editing it.`,
    });
    expect(await versionCount(theirs)).toBe(1);
  });
});

describe("who may do what", () => {
  it("lets a viewer read every test and write none of them", async () => {
    api = await createApi("tests_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const vic = await colleagueOf(api.app, ada, "vic@acme.example", "viewer");
    const authored = await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
    });
    const theirs = await projectKeyFor(api.app, vic);

    const listed = await request("GET", "/api/tests", theirs);
    expect(listed.statusCode).toBe(200);
    expect((listed.body.items as unknown[]).length).toBe(1);

    const frozen = await request(
      "GET",
      `/api/test-versions/${String(authored.body.version_id)}`,
      theirs,
    );
    expect(frozen.statusCode).toBe(200);

    const written = await createTestThrough(theirs, { ...RESCHEDULING });
    expect(written.statusCode).toBe(403);
    expect(written.body).toEqual({
      error: "not_permitted",
      message: "a viewer may not author_definitions",
    });

    const edited = await request(
      "PATCH",
      `/api/tests/${String(authored.body.id)}`,
      theirs,
      {
        ...RESCHEDULING,
        scenario: "a viewer's edit",
        expected_version_id: authored.body.version_id,
      },
    );
    expect(edited.statusCode).toBe(403);
    expect(edited.body).toEqual({
      error: "not_permitted",
      message: "a viewer may not author_definitions",
    });

    expect(await versionCount(String(authored.body.id))).toBe(1);
  });

  it("lets a member write with their own key, because day-to-day work needs no admin", async () => {
    api = await createApi("tests_member");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const mia = await colleagueOf(api.app, ada, "mia@acme.example", "member");

    const created = await createTestThrough(await projectKeyFor(api.app, mia), {
      ...RESCHEDULING,
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  });

  it("refuses a key it never minted before it reads anything at all", async () => {
    api = await createApi("tests_unknown_key");
    await signUp(api.app, "ada@acme.example", "Acme");

    // A body the door would refuse as unprocessable if it ever looked at one.
    const refused = await createTestThrough(
      "egma_sk_this-was-never-a-key-anybody-was-given",
      { name: "", scenario: "", expected_behaviors: [] },
    );

    expect(refused.statusCode).toBe(401);
    expect(refused.body).toEqual({
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an Egma key.",
    });
  });

  it("refuses an unknown key before the body is even parsed", async () => {
    api = await createApi("tests_unknown_key_unparsed");
    await signUp(api.app, "ada@acme.example", "Acme");

    // A body that is not JSON at all. If anything read it first, the answer
    // would be a parse error in a shape this API never speaks — the door
    // answers who-is-asking before a single byte of the body is looked at.
    const refused = await api.app.inject({
      method: "POST",
      url: "/api/tests",
      headers: {
        authorization: "Bearer egma_sk_this-was-never-a-key-anybody-was-given",
        "content-type": "application/json",
      },
      payload: "{this was never json",
    });

    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toEqual({
      error: "not_authenticated",
      message:
        "this request carried no session and no usable API key. " +
        "Sign in, or send Authorization: Bearer with an Egma key.",
    });
  });
});

describe("the project a write lands in", () => {
  it("is the organization's own for a key minted for the whole customer", async () => {
    api = await createApi("tests_project_default");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const created = await createTestThrough(ada.secret, { ...RESCHEDULING });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(await projectOf(String(created.body.id))).toBe(ada.projectId);

    const listed = await request("GET", "/api/tests", ada.secret);
    expect((listed.body.items as { id: string }[])[0]?.id).toBe(created.body.id);
  });

  it("is asked for rather than guessed at once the organization holds two", async () => {
    api = await createApi("tests_project_ambiguous");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const written = await createTestThrough(ada.secret, { ...RESCHEDULING });
    const listed = await request("GET", "/api/tests", ada.secret);

    for (const answer of [written, listed]) {
      expect(answer.statusCode).toBe(400);
      expect(answer.body).toEqual({
        error: "invalid_request",
        message:
          "this organization holds more than one project and this credential " +
          "names none, so Egma cannot tell which project this is about. Send " +
          "project with the one you mean, or use a key minted for that project.",
      });
    }

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });

  it("is the one the body named, when that is a project this credential may act in", async () => {
    api = await createApi("tests_project_named");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const omar = await personaFor(ada, "Omar", outbound.id);

    const created = await createTestThrough(ada.secret, {
      ...RESCHEDULING,
      project: outbound.id,
      personas: ["Omar"],
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(await projectOf(String(created.body.id))).toBe(outbound.id);
    expect(created.body.personas).toEqual([{ id: omar, name: "Omar" }]);
  });

  it("is never another customer's, and the refusal confirms nothing about it", async () => {
    api = await createApi("tests_project_across");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const refused = await createTestThrough(ada.secret, {
      ...RESCHEDULING,
      project: grace.projectId,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        `this credential may not act in project ${grace.projectId}. A ` +
        `credential authorized for one project acts in that one, and a key ` +
        `for the whole organization acts in any project of that organization. ` +
        `Leave project out to use the project this credential already acts in.`,
    });

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });

  it("is never a sibling project a project-scoped credential was not minted for", async () => {
    api = await createApi("tests_project_sibling");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const refused = await createTestThrough(await projectKeyFor(api.app, ada), {
      ...RESCHEDULING,
      project: outbound.id,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body).toEqual({
      error: "not_permitted",
      message:
        `this credential may not act in project ${outbound.id}. A credential ` +
        `authorized for one project acts in that one, and a key for the whole ` +
        `organization acts in any project of that organization. Leave project ` +
        `out to use the project this credential already acts in.`,
    });
  });
});

describe("the concurrency token, under the lock", () => {
  it("refuses the second of two edits that both named the version they read", async () => {
    api = await createApi("tests_edit_race");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);
    const read = String(created.body.version_id);

    // Both writers hold the version they last read, which is the case the token
    // exists for. They are sent at once, and neither knows about the other.
    const [dashboard, file] = await Promise.all([
      editTest(contextFor(ada, "admin"), testId, {
        scenario: "the dashboard's words",
        expectedVersionId: read,
      }).then(
        () => ({ refused: false }),
        () => ({ refused: true }),
      ),
      request("PATCH", `/api/tests/${testId}`, key, {
        scenario: "the file's words",
        expected_version_id: read,
      }),
    ]);

    // Exactly one of them won. Whichever reached the row second found the
    // version the first had committed rather than the one it read itself, which
    // is only true because the comparison happens under the lock.
    const refused = [dashboard.refused, file.statusCode !== 200];
    expect(refused.filter(Boolean)).toHaveLength(1);
    expect(await versionCount(testId)).toBe(2);

    if (file.statusCode !== 200) {
      expect(file.statusCode).toBe(409);
      expect(file.body).toMatchObject({
        error: "conflict",
        expected_version_id: read,
        test: { id: testId, name: RESCHEDULING.name },
      });
      expect(file.body.current_version_id).not.toBe(read);
    }
  });
});
