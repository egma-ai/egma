import {
  createApiKey,
  createPersona,
  createProject,
  type AuthContext,
  type PersonaTraits,
  type Role,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { hashApiKeySecret } from "../src/auth/api-key.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

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

type Person = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

async function signUp(email: string, organizationName: string): Promise<Person> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode, created.body).toBe(201);

  const landed = created.json() as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };

  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/** A colleague, added the way the product adds one: invited, and they follow. */
async function colleagueOf(
  host: Person,
  email: string,
  role: Role,
): Promise<Person> {
  const invited = await api.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: host.cookie },
    payload: { email, role },
  });
  expect(invited.statusCode, invited.body).toBe(201);

  const link = (invited.json() as { accept_url: string }).accept_url;
  const joined = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email,
      password: "a-long-enough-password",
      invitationToken: new URL(link).searchParams.get("token"),
    },
  });
  expect(joined.statusCode, joined.body).toBe(201);

  return {
    userId: (joined.json() as { userId: string }).userId,
    organizationId: host.organizationId,
    projectId: host.projectId,
    cookie: cookiesFrom(joined.headers["set-cookie"]),
  };
}

function contextFor(person: Person, role: Role): AuthContext {
  return {
    userId: person.userId,
    organizationId: person.organizationId,
    projectId: person.projectId,
    role,
    via: "session",
  };
}

/**
 * A key, as `egma login` leaves one: minted for one project, because a terminal
 * is authorized for a project rather than for a whole customer. `projectId:
 * null` is the other kind — a key for the whole organization, which is what
 * makes the project resolution below worth testing at all.
 */
async function keyFor(
  person: Person,
  role: Role,
  projectId: string | null = person.projectId,
): Promise<string> {
  const secret = `egma_sk_${newId("key")}`;
  await createApiKey(contextFor(person, role), {
    hash: hashApiKeySecret(secret),
    prefix: "egma_sk_",
    displaySuffix: secret.slice(-4),
    name: "a terminal",
    projectId,
  });
  return secret;
}

function withKey(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

const NEUTRAL: PersonaTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
};

/** A persona, authored the only way there is: no route ships for one. */
async function personaFor(person: Person, name: string): Promise<string> {
  const created = await createPersona(contextFor(person, "member"), {
    name,
    traits: NEUTRAL,
  });
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

type Answer = {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
};

async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: withKey(key),
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

async function createTestThrough(
  key: string,
  body: Record<string, unknown>,
): Promise<Answer> {
  return call("POST", "/api/tests", key, body);
}

describe("creating a test", () => {
  it("answers the whole test, with the version a file will pin", async () => {
    api = await createApi("tests_create");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const created = await createTestThrough(key, { ...RESCHEDULING });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      project_id: ada.projectId,
      name: RESCHEDULING.name,
      version: 1,
      scenario: RESCHEDULING.scenario,
      expected_behaviors: [...RESCHEDULING.expected_behaviors],
    });
    expect(String(created.body.id)).toMatch(/^tst_/u);
    expect(String(created.body.version_id)).toMatch(/^tstv_/u);
    expect(created.body.created_at).toBeTypeOf("string");
  });

  it("takes the project's default persona when the file names nobody", async () => {
    api = await createApi("tests_default_persona");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const starter = await defaultPersonaOf(ada.projectId);

    const named = await createTestThrough(key, { ...RESCHEDULING, personas: [] });
    const absent = await createTestThrough(key, { ...RESCHEDULING });

    for (const created of [named, absent]) {
      expect(created.statusCode).toBe(201);
      expect(created.body.personas).toEqual([
        { id: starter, name: expect.any(String), deleted_at: null },
      ]);
    }
  });

  it("resolves personas by name, in the order the file named them", async () => {
    api = await createApi("tests_persona_names");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const omar = await personaFor(ada, "Omar");
    const rita = await personaFor(ada, "Impatient Rita");

    const created = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Impatient Rita", "Omar"],
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.personas).toEqual([
      { id: rita, name: "Impatient Rita", deleted_at: null },
      { id: omar, name: "Omar", deleted_at: null },
    ]);
  });

  it("resolves an identifier too, so a client holding one needs no name", async () => {
    api = await createApi("tests_persona_ids");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const omar = await personaFor(ada, "Omar");

    const created = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: [omar],
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.personas).toEqual([
      { id: omar, name: "Omar", deleted_at: null },
    ]);
  });

  it("refuses a persona nobody in this project answers to", async () => {
    api = await createApi("tests_persona_unknown");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const refused = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Impatient Rita"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        'egma has no persona called "Impatient Rita" in this project. Name a persona this project already has, or name none and egma takes the project\'s default.',
    });

    const { rows } = await api.database.sql("select id from test");
    expect(rows).toEqual([]);
  });

  it("refuses one persona named twice, because that asks for one simulation twice", async () => {
    api = await createApi("tests_persona_twice");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    await personaFor(ada, "Omar");

    const refused = await createTestThrough(key, {
      ...RESCHEDULING,
      personas: ["Omar", "Omar"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message: 'persona "Omar" is named twice on one test; name each persona once.',
    });
  });

  it("relays the factory's own words for a test that could never be red", async () => {
    api = await createApi("tests_validation");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

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
  });
});

describe("the list of tests", () => {
  it("answers one envelope, newest first, and pages through with its cursor", async () => {
    api = await createApi("tests_list_envelope");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");

    const written: string[] = [];
    for (const name of ["first", "second", "third"]) {
      const created = await createTestThrough(key, { ...RESCHEDULING, name });
      written.push(String(created.body.id));
    }

    const page = await call("GET", "/api/tests?limit=2", key);
    expect(page.statusCode).toBe(200);
    const items = page.body.items as { id: string; name: string }[];
    expect(items.map((test) => test.name)).toEqual(["third", "second"]);
    expect(page.body.next_cursor).toBe(items[1]?.id);

    const rest = await call(
      "GET",
      `/api/tests?limit=2&cursor=${String(page.body.next_cursor)}`,
      key,
    );
    const remaining = rest.body.items as { id: string; name: string }[];
    expect(remaining.map((test) => test.name)).toEqual(["first"]);
    // Null rather than absent, so "no next page" is told from "an older shape".
    expect(rest.body.next_cursor).toBeNull();

    expect(new Set([...items, ...remaining].map((test) => test.id))).toEqual(
      new Set(written),
    );
  });

  it("shows a customer their own tests and nobody else's", async () => {
    api = await createApi("tests_list_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    await createTestThrough(await keyFor(ada, "admin"), {
      ...RESCHEDULING,
      name: "Acme's",
    });

    const listed = await call("GET", "/api/tests", await keyFor(grace, "admin"));

    expect(listed.statusCode).toBe(200);
    expect(listed.body).toEqual({ items: [], next_cursor: null });
  });

  it("reads the project the credential acts in, and no sibling of it", async () => {
    api = await createApi("tests_list_project");
    const ada = await signUp("ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const here = await keyFor(ada, "admin");
    await createTestThrough(here, { ...RESCHEDULING, name: "in the default" });

    const there = await keyFor(ada, "admin", outbound.id);
    const listed = await call("GET", "/api/tests", there);

    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toEqual([]);
  });

  it("refuses a cursor it never issued, rather than answering a page nobody asked for", async () => {
    api = await createApi("tests_list_cursor");
    const ada = await signUp("ada@acme.example", "Acme");

    const refused = await call(
      "GET",
      "/api/tests?cursor=not-a-cursor",
      await keyFor(ada, "admin"),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'cursor is the next_cursor an earlier page answered with, and "not-a-cursor" is not one. Leave it out to start at the newest test.',
    });
  });

  it("refuses a page size that is not a page size", async () => {
    api = await createApi("tests_list_limit");
    const ada = await signUp("ada@acme.example", "Acme");

    const refused = await call(
      "GET",
      "/api/tests?limit=5000",
      await keyFor(ada, "admin"),
    );

    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({
      error: "invalid_request",
      message:
        'limit is how many tests one page may carry, between 1 and 200, and "5000" is not one of those. Leave it out for the default page.',
    });
  });
});

describe("one frozen version", () => {
  it("says which test it belongs to and that the test still stands on it", async () => {
    api = await createApi("tests_version_current");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });

    const frozen = await call(
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const pinned = String(created.body.version_id);

    const edited = await call(
      "PATCH",
      `/api/tests/${String(created.body.id)}`,
      key,
      {
        ...RESCHEDULING,
        name: "Reschedules, renamed",
        scenario: "They want the Wednesday slot instead.",
        expected_version_id: pinned,
      },
    );
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);

    const stale = await call("GET", `/api/test-versions/${pinned}`, key);

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

  it("is not found for a version this egma never issued", async () => {
    api = await createApi("tests_version_unknown");
    const ada = await signUp("ada@acme.example", "Acme");
    const missing = newId("tstv");

    const refused = await call(
      "GET",
      `/api/test-versions/${missing}`,
      await keyFor(ada, "admin"),
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test version ${missing} on this egma`,
    });
  });

  it("is not found for another customer's version, which confirms nothing", async () => {
    api = await createApi("tests_version_tenancy");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const created = await createTestThrough(await keyFor(ada, "admin"), {
      ...RESCHEDULING,
    });
    const theirs = String(created.body.version_id);

    const refused = await call(
      "GET",
      `/api/test-versions/${theirs}`,
      await keyFor(grace, "admin"),
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test version ${theirs} on this egma`,
    });
  });
});

describe("editing a test", () => {
  it("mints the next version and leaves the one it left behind alone", async () => {
    api = await createApi("tests_edit_versions");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const edited = await call("PATCH", `/api/tests/${testId}`, key, {
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

  it("refuses an edit written against a version the test has moved past", async () => {
    api = await createApi("tests_edit_conflict");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);
    const stale = String(created.body.version_id);

    // The teammate in the dashboard, who got there first.
    const moved = await call("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "They want the Wednesday slot instead.",
      expected_version_id: stale,
    });
    const current = String(moved.body.version_id);

    const refused = await call("PATCH", `/api/tests/${testId}`, key, {
      ...RESCHEDULING,
      scenario: "They want the Friday slot instead.",
      expected_version_id: stale,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "conflict",
      message:
        `this edit was written against version ${stale}, and the test has ` +
        `moved on to ${current}. Fetch the test again and send the edit with ` +
        `expected_version_id set to the version it names now.`,
      test: { id: testId, name: RESCHEDULING.name },
      expected_version_id: stale,
      current_version_id: current,
    });

    // Refused and not merged: the refused edit wrote nothing at all.
    expect(await versionCount(testId)).toBe(2);
    const still = await call("GET", `/api/test-versions/${current}`, key);
    expect(still.body.scenario).toBe("They want the Wednesday slot instead.");
  });

  it("mints nothing for content byte-identical to the current version", async () => {
    api = await createApi("tests_edit_identical");
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const again = await call("PATCH", `/api/tests/${testId}`, key, {
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });
    const testId = String(created.body.id);

    const renamed = await call("PATCH", `/api/tests/${testId}`, key, {
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
    const ada = await signUp("ada@acme.example", "Acme");
    const key = await keyFor(ada, "admin");
    const created = await createTestThrough(key, { ...RESCHEDULING });

    const edited = await call(
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
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");
    const created = await createTestThrough(await keyFor(ada, "admin"), {
      ...RESCHEDULING,
    });
    const theirs = String(created.body.id);

    const refused = await call(
      "PATCH",
      `/api/tests/${theirs}`,
      await keyFor(grace, "admin"),
      { ...RESCHEDULING, scenario: "reaching across" },
    );

    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message: `there is no test ${theirs} on this egma`,
    });
    expect(await versionCount(theirs)).toBe(1);
  });
});

describe("who may do what", () => {
  it("lets a viewer read every test and write none of them", async () => {
    api = await createApi("tests_viewer");
    const ada = await signUp("ada@acme.example", "Acme");
    const vic = await colleagueOf(ada, "vic@acme.example", "viewer");
    const authored = await createTestThrough(await keyFor(ada, "admin"), {
      ...RESCHEDULING,
    });
    const theirs = await keyFor(vic, "viewer");

    const listed = await call("GET", "/api/tests", theirs);
    expect(listed.statusCode).toBe(200);
    expect((listed.body.items as unknown[]).length).toBe(1);

    const frozen = await call(
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

    const edited = await call(
      "PATCH",
      `/api/tests/${String(authored.body.id)}`,
      theirs,
      { ...RESCHEDULING, scenario: "a viewer's edit" },
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
    const ada = await signUp("ada@acme.example", "Acme");
    const mia = await colleagueOf(ada, "mia@acme.example", "member");

    const created = await createTestThrough(await keyFor(mia, "member"), {
      ...RESCHEDULING,
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
  });

  it("refuses a key it never minted before it reads anything at all", async () => {
    api = await createApi("tests_unknown_key");
    await signUp("ada@acme.example", "Acme");

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
        "Sign in, or send Authorization: Bearer with an egma key.",
    });
  });
});

describe("the project a write lands in", () => {
  it("is the organization's own for a key minted for the whole customer", async () => {
    api = await createApi("tests_project_default");
    const ada = await signUp("ada@acme.example", "Acme");
    const wholeCustomer = await keyFor(ada, "admin", null);

    const created = await createTestThrough(wholeCustomer, { ...RESCHEDULING });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.project_id).toBe(ada.projectId);

    const listed = await call("GET", "/api/tests", wholeCustomer);
    expect((listed.body.items as { id: string }[])[0]?.id).toBe(created.body.id);
  });

  it("is the one the body named, when that is a project this credential may act in", async () => {
    api = await createApi("tests_project_named");
    const ada = await signUp("ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });
    const omar = await createPersona(
      { ...contextFor(ada, "admin"), projectId: outbound.id },
      { name: "Omar", traits: NEUTRAL },
    );

    const created = await createTestThrough(await keyFor(ada, "admin", null), {
      ...RESCHEDULING,
      project: outbound.id,
      personas: ["Omar"],
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.project_id).toBe(outbound.id);
    expect(created.body.personas).toEqual([
      { id: omar.id, name: "Omar", deleted_at: null },
    ]);
  });

  it("is never another customer's, and the refusal confirms nothing about it", async () => {
    api = await createApi("tests_project_across");
    const ada = await signUp("ada@acme.example", "Acme");
    const grace = await signUp("grace@globex.example", "Globex");

    const refused = await createTestThrough(await keyFor(ada, "admin", null), {
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
    const ada = await signUp("ada@acme.example", "Acme");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const refused = await createTestThrough(await keyFor(ada, "admin"), {
      ...RESCHEDULING,
      project: outbound.id,
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.body.error).toBe("not_permitted");
    expect(refused.body.message).toBe(
      `this credential may not act in project ${outbound.id}. A credential ` +
        `authorized for one project acts in that one, and a key for the whole ` +
        `organization acts in any project of that organization. Leave project ` +
        `out to use the project this credential already acts in.`,
    );
  });
});
