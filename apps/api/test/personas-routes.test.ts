import {
  createProject,
  createAgent,
  createTest,
  archiveTest,
  editTest,
  type PersonaTraits,
} from "@egma/db";
import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The persona routes, over real HTTP against real Postgres.
 *
 * What is asserted here is what a caller observes: the shapes, the envelope,
 * who may do what, the two stale-write flows, and every refusal sentence word
 * for word. **Refusal wording is contract** — it is what a page shows somebody
 * and what tells them their next move — so a sentence that changed without
 * anybody deciding to change it fails here.
 *
 * The factory beneath has its own tests and none of them are repeated. What is
 * new at this seam is everything the wire adds: a project named on every
 * browser request, the codes a client branches on, and the fact that a
 * viewer's write is refused by the server whether or not a browser was
 * involved.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const TRAITS: PersonaTraits = {
  personality: "Calls about a bill and wants it settled today.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
};

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

type WirePersona = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  version_id: string;
  revision: string;
  archived_at: string | null;
  is_default: boolean;
  traits: Record<string, unknown>;
};

function personaIn(answer: Answer): WirePersona {
  return answer.body as unknown as WirePersona;
}

async function createPersonaThrough(
  who: Customer,
  name: string,
  traits: PersonaTraits = TRAITS,
  projectId = who.projectId,
): Promise<WirePersona> {
  const made = await browse("POST", "/api/personas", who, {
    project: projectId,
    name,
    traits,
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  return personaIn(made);
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

describe("creating and reading a persona", () => {
  it("answers the whole persona, with both expectations a write will name", async () => {
    api = await createApi("personas_create");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await createPersonaThrough(ada, "Impatient Rita", {
      ...TRAITS,
      manner: "Brisk, and talks over the end of a sentence.",
      patience: "Gives it a minute before asking for somebody else.",
      accent: "Glaswegian.",
      backgroundNoise: "A busy kitchen.",
      underFriction: "Repeats the question louder, then asks to escalate.",
    });

    expect(made.name).toBe("Impatient Rita");
    expect(made.version).toBe(1);
    expect(made.archived_at).toBeNull();
    expect(made.is_default).toBe(false);
    expect(made.revision).toEqual(expect.any(String));
    expect(made.version_id).toEqual(expect.any(String));
    expect(made.traits.manner).toBe("Brisk, and talks over the end of a sentence.");
    expect(made.traits.backgroundNoise).toBe("A busy kitchen.");
    expect(made.traits.underFriction).toBe(
      "Repeats the question louder, then asks to escalate.",
    );

    const read = await browse(
      "GET",
      `/api/personas/${made.id}?project=${ada.projectId}`,
      ada,
    );
    expect(read.statusCode).toBe(200);
    expect(personaIn(read)).toEqual(made);
  });

  it("refuses a body that could never be written, in the factory's own words", async () => {
    api = await createApi("personas_validation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const nameless = await browse("POST", "/api/personas", ada, {
      project: ada.projectId,
      name: "   ",
      traits: TRAITS,
    });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a name",
    });

    const tooFast = await browse("POST", "/api/personas", ada, {
      project: ada.projectId,
      name: "Fast Freddie",
      traits: { ...TRAITS, voice: { ...TRAITS.voice, speed: 9 } },
    });
    expect(tooFast.statusCode).toBe(422);
    expect(tooFast.body.error).toBe("unprocessable");
    expect(tooFast.body.message).toBe(
      "speaking speed must be between 0.5 and 2",
    );
  });

  /**
   * **A persona says who is calling, never what they are calling about.**
   *
   * The whole worth of a persona is that one of them calls about forty
   * different situations, and a caller carrying a goal would quietly become a
   * second copy of one test. That is a claim about behaviour, so it is shown
   * by asking the system for it: a create that smuggles a scenario in comes
   * back without one, and the stored version holds none either.
   */
  it("keeps a test's goal out of a persona, at the door and in the row", async () => {
    api = await createApi("personas_no_scenario");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await browse("POST", "/api/personas", ada, {
      project: ada.projectId,
      name: "Smuggling Sid",
      traits: {
        ...TRAITS,
        scenario: "Their Thursday cleaning has to move to next week.",
        goal: "Reschedule the appointment.",
        wants: "An afternoon slot.",
      },
    });

    expect(made.statusCode).toBe(201);
    for (const smuggled of ["scenario", "goal", "wants"]) {
      expect(made.body.traits, smuggled).not.toHaveProperty(smuggled);
    }

    const read = await browse(
      "GET",
      `/api/personas/${personaIn(made).id}?project=${ada.projectId}`,
      ada,
    );
    expect(personaIn(read).traits).toEqual(TRAITS);

    // And not merely hidden by the read: the stored version holds none of it,
    // so nothing downstream — a simulator building a caller, a run pinning a
    // version — can ever find one there.
    const { rows } = await api.database.sql<{ traits: Record<string, unknown> }>(
      "select traits from persona_version where persona_id = $1",
      [personaIn(made).id],
    );
    expect(Object.keys(rows[0]?.traits ?? {}).sort()).toEqual([
      "language",
      "personality",
      "voice",
    ]);
  });

  it("shows the project's default persona as an ordinary persona of the list", async () => {
    api = await createApi("personas_default_visible");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const starter = await defaultPersonaOf(ada.projectId);

    const listed = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}`,
      ada,
    );
    const items = listed.body.items as WirePersona[];
    const found = items.find((one) => one.id === starter);

    expect(found?.is_default).toBe(true);
    expect(items.filter((one) => one.is_default)).toHaveLength(1);

    // Ordinary means editable: a rename lands on it like any other.
    const renamed = await browse("PATCH", `/api/personas/${starter}`, ada, {
      project: ada.projectId,
      expected_revision: found?.revision,
      name: "The one everybody starts with",
    });
    expect(renamed.statusCode).toBe(200);
    expect(personaIn(renamed).name).toBe("The one everybody starts with");
    expect(personaIn(renamed).is_default).toBe(true);
  });
});

describe("the list", () => {
  it("separates active from archived and pages with a keyset cursor", async () => {
    api = await createApi("personas_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = [];
    for (const name of ["One", "Two", "Three", "Four"]) {
      made.push(await createPersonaThrough(ada, name));
    }
    const [, second] = made;
    if (second === undefined) throw new Error("nothing was made");

    await browse("POST", `/api/personas/${second.id}/archive`, ada, {
      project: ada.projectId,
      expected_revision: second.revision,
    });

    const active = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}`,
      ada,
    );
    const activeIds = (active.body.items as WirePersona[]).map((one) => one.id);
    expect(activeIds).not.toContain(second.id);

    const archive = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}&archived=true`,
      ada,
    );
    expect((archive.body.items as WirePersona[]).map((one) => one.id)).toEqual([
      second.id,
    ]);

    // The cursor is the last id of the page, so two pages hold the whole set
    // with no row seen twice and none missed.
    const first = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}&cursor=${activeIds[0]}`,
      ada,
    );
    const after = (first.body.items as WirePersona[]).map((one) => one.id);
    expect(after).toEqual(activeIds.slice(1));
    expect(first.body.next_cursor).toBeNull();
  });

  it("keeps two personas of one name apart, because a name is not an identity", async () => {
    api = await createApi("personas_same_name");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    // Two callers a team both thinks of as "the impatient one" is an ordinary
    // thing for a project to hold. Nothing refuses it, and nothing has to
    // guess which one an address means.
    const first = await createPersonaThrough(ada, "Impatient caller");
    const second = await createPersonaThrough(ada, "Impatient caller");
    expect(second.id).not.toBe(first.id);

    await browse("PATCH", `/api/personas/${second.id}`, ada, {
      project: ada.projectId,
      expected_revision: second.revision,
      description: "The second one.",
    });

    const one = await browse(
      "GET",
      `/api/personas/${first.id}?project=${ada.projectId}`,
      ada,
    );
    const other = await browse(
      "GET",
      `/api/personas/${second.id}?project=${ada.projectId}`,
      ada,
    );
    expect(personaIn(one).description).toBeNull();
    expect(personaIn(other).description).toBe("The second one.");
  });

  it("refuses a cursor this list never issued", async () => {
    api = await createApi("personas_cursor");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}&cursor=prsv_nonsense`,
      ada,
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "invalid_cursor",
      message:
        "Cursor prsv_nonsense is not valid for this list. Remove it and " +
        "start from the first page.",
    });
  });

  it("is refused when a browser names no project at all", async () => {
    api = await createApi("personas_no_project");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await browse("GET", "/api/personas", ada);
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "project_required",
      message:
        "This request did not name a project. Choose a project from the " +
        "selector and try again.",
    });
  });

  it("keeps two projects of one organization apart, and two organizations invisible", async () => {
    api = await createApi("personas_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const here = await createPersonaThrough(ada, "In Default");
    const there = await createPersonaThrough(
      ada,
      "In Outbound",
      TRAITS,
      outbound.id,
    );

    const inDefault = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}`,
      ada,
    );
    const defaultIds = (inDefault.body.items as WirePersona[]).map((o) => o.id);
    expect(defaultIds).toContain(here.id);
    expect(defaultIds).not.toContain(there.id);

    // A persona of a sibling project is not reachable under the wrong project,
    // and reads exactly as one that was never minted.
    const misfiled = await browse(
      "GET",
      `/api/personas/${there.id}?project=${ada.projectId}`,
      ada,
    );
    expect(misfiled.statusCode).toBe(404);
    expect(misfiled.body).toEqual({
      error: "not_found",
      message:
        `There is no persona ${there.id} available in this project. Check ` +
        "the link, or choose it from the current project.",
    });

    // And another organization cannot even name the project.
    const stranger = await browse(
      "GET",
      `/api/personas/${here.id}?project=${ada.projectId}`,
      grace,
    );
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body.error).toBe("project_outside_organization");
  });
});

describe("editing a persona", () => {
  it("writes name and description in place, minting no version", async () => {
    api = await createApi("personas_rename");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Renamed Rowan");

    const renamed = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      name: "Rowan",
      description: "Somebody who calls about a bill.",
    });

    expect(renamed.statusCode).toBe(200);
    const now = personaIn(renamed);
    expect(now.name).toBe("Rowan");
    expect(now.description).toBe("Somebody who calls about a bill.");
    expect(now.version).toBe(1);
    expect(now.version_id).toBe(made.version_id);
    expect(now.revision).not.toBe(made.revision);
  });

  it("mints a version for changed traits, and nothing for identical ones", async () => {
    api = await createApi("personas_version");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Versioned Vera");

    const changed = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      expected_version_id: made.version_id,
      traits: { ...TRAITS, personality: "Vera, after a long wait." },
    });
    expect(changed.statusCode).toBe(200);
    expect(personaIn(changed).version).toBe(2);

    const identical = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: personaIn(changed).revision,
      expected_version_id: personaIn(changed).version_id,
      traits: personaIn(changed).traits,
    });
    expect(identical.statusCode).toBe(200);
    expect(personaIn(identical).version).toBe(2);
    expect(personaIn(identical).version_id).toBe(personaIn(changed).version_id);

    const history = await browse(
      "GET",
      `/api/personas/${made.id}/versions?project=${ada.projectId}`,
      ada,
    );
    expect((history.body.items as { version: number }[]).map((v) => v.version))
      .toEqual([2, 1]);
  });

  it("refuses an identity write against a revision the persona has moved past", async () => {
    api = await createApi("personas_identity_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Contested Cora");

    await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      name: "Cora, renamed once",
    });

    // The second tab, still holding the revision it read before that.
    const refused = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      name: "Cora, renamed twice",
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "identity_conflict",
      message:
        `Persona ${made.id} changed after you opened it. Read it again, keep ` +
        "or reapply your edits, and send the update with expected_revision " +
        "set to its new revision.",
    });

    const now = await browse(
      "GET",
      `/api/personas/${made.id}?project=${ada.projectId}`,
      ada,
    );
    expect(personaIn(now).name).toBe("Cora, renamed once");
  });

  it("refuses a traits write against a version the content has moved past", async () => {
    api = await createApi("personas_version_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Contested Cyrus");

    const second = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      expected_version_id: made.version_id,
      traits: { ...TRAITS, language: "en-GB" },
    });

    const refused = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: personaIn(second).revision,
      expected_version_id: made.version_id,
      traits: { ...TRAITS, language: "en-AU" },
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "version_conflict",
      message:
        `this persona edit was written against version ${made.version_id}, ` +
        `and it has moved on to ${personaIn(second).version_id}. Read the ` +
        "persona again, keep or reapply your edits, and send them with " +
        `expected_version_id set to ${personaIn(second).version_id}.`,
    });
  });

  it("requires both expectations, and says which one is missing", async () => {
    api = await createApi("personas_expectations");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Guarded Gail");

    const noRevision = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      name: "Gail",
    });
    expect(noRevision.statusCode).toBe(422);
    expect(String(noRevision.body.message)).toContain("expected_revision");

    const noVersion = await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      traits: { ...TRAITS, language: "en-GB" },
    });
    expect(noVersion.statusCode).toBe(422);
    expect(String(noVersion.body.message)).toContain("expected_version_id");
  });
});

describe("cloning a persona", () => {
  it("makes a new identity with the current fields and traits, and no history", async () => {
    api = await createApi("personas_clone");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Original Olive");
    await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      expected_version_id: made.version_id,
      traits: { ...TRAITS, language: "en-GB" },
    });

    const cloned = await browse(
      "POST",
      `/api/personas/${made.id}/clone`,
      ada,
      { project: ada.projectId },
    );

    expect(cloned.statusCode).toBe(201);
    const clone = personaIn(cloned);
    expect(clone.id).not.toBe(made.id);
    expect(clone.name).toBe("Original Olive");
    expect(clone.traits.language).toBe("en-GB");
    // Its own history, starting over: the source's versions are the source's.
    expect(clone.version).toBe(1);
    expect(clone.version_id).not.toBe(made.version_id);

    const history = await browse(
      "GET",
      `/api/personas/${clone.id}/versions?project=${ada.projectId}`,
      ada,
    );
    expect(history.body.items).toHaveLength(1);
  });
});

describe("archiving a persona", () => {
  it("is refused while a current version of an active test names them", async () => {
    api = await createApi("personas_in_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Named Nadia");

    // A test always applies to at least one active agent, so a project that
    // holds none can hold no test.
    await createAgent(contextFor(ada, "member"), {
      name: `Front desk ${newId("agt").slice(-6)}`,
    });
    const named = await createTest(contextFor(ada, "member"), {
      name: "Reschedules a booked appointment",
      scenario: "Their Thursday cleaning has to move to next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [made.id],
    });

    const refused = await browse(
      "POST",
      `/api/personas/${made.id}/archive`,
      ada,
      { project: ada.projectId, expected_revision: made.revision },
    );

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "persona_in_use",
      message:
        `Persona ${made.id} is used by active tests ${named.id}. Select ` +
        "another persona on those tests, or archive the tests, then archive " +
        "this persona.",
    });

    const still = await browse(
      "GET",
      `/api/personas/${made.id}?project=${ada.projectId}`,
      ada,
    );
    expect(personaIn(still).archived_at).toBeNull();
  });

  it("is refused for the project's default until an active replacement is named", async () => {
    api = await createApi("personas_default_replacement");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const starter = await defaultPersonaOf(ada.projectId);
    const read = await browse(
      "GET",
      `/api/personas/${starter}?project=${ada.projectId}`,
      ada,
    );
    const holding = personaIn(read);

    const refused = await browse(
      "POST",
      `/api/personas/${starter}/archive`,
      ada,
      { project: ada.projectId, expected_revision: holding.revision },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "default_persona_required",
      message:
        `Persona ${starter} is this project's default. Select an active ` +
        "replacement persona in the Archive action and try again.",
    });

    const taking = await createPersonaThrough(ada, "Taking-Over Tam");
    const archived = await browse(
      "POST",
      `/api/personas/${starter}/archive`,
      ada,
      {
        project: ada.projectId,
        expected_revision: holding.revision,
        replacement_persona_id: taking.id,
      },
    );

    expect(archived.statusCode).toBe(200);
    expect(personaIn(archived).archived_at).toEqual(expect.any(String));
    expect(personaIn(archived).is_default).toBe(false);
    expect(await defaultPersonaOf(ada.projectId)).toBe(taking.id);

    // And the new default is what a test naming nobody is given.
    // A test always applies to at least one active agent, so a project that
    // holds none can hold no test.
    await createAgent(contextFor(ada, "member"), {
      name: `Front desk ${newId("agt").slice(-6)}`,
    });
    const written = await createTest(contextFor(ada, "member"), {
      name: "Takes the default",
      scenario: "Anything at all.",
      expectedBehaviors: ["answers"],
      personaIds: [],
    });
    expect(written.personas.map((one) => one.id)).toEqual([taking.id]);
  });

  it("archives an eligible persona and restores them again", async () => {
    api = await createApi("personas_archive_restore");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Filed-Away Fay");

    const archived = await browse(
      "POST",
      `/api/personas/${made.id}/archive`,
      ada,
      { project: ada.projectId, expected_revision: made.revision },
    );
    expect(archived.statusCode).toBe(200);
    expect(personaIn(archived).archived_at).toEqual(expect.any(String));

    const restored = await browse(
      "POST",
      `/api/personas/${made.id}/restore`,
      ada,
      {
        project: ada.projectId,
        expected_revision: personaIn(archived).revision,
      },
    );
    expect(restored.statusCode).toBe(200);
    expect(personaIn(restored).archived_at).toBeNull();

    const active = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}`,
      ada,
    );
    expect((active.body.items as WirePersona[]).map((one) => one.id)).toContain(
      made.id,
    );
  });

  it("is not blocked by a version the test has moved past", async () => {
    api = await createApi("personas_history_does_not_block");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const author = contextFor(ada, "member");
    const leaving = await createPersonaThrough(ada, "Leaving Lena");
    const staying = await createPersonaThrough(ada, "Staying Sam");

    // A test always applies to at least one active agent, so a project that
    // holds none can hold no test.
    await createAgent(author, {
      name: `Front desk ${newId("agt").slice(-6)}`,
    });
    const named = await createTest(author, {
      name: "Reschedules a booked appointment",
      scenario: "Their Thursday cleaning has to move to next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [leaving.id],
    });

    // The test moves off them. Version 1 goes on naming them, and a frozen
    // version has nothing left to lose.
    await editTest(author, named.id, {
      expectedVersionId: named.versionId,
      personaIds: [staying.id],
    });

    const archived = await browse(
      "POST",
      `/api/personas/${leaving.id}/archive`,
      ada,
      { project: ada.projectId, expected_revision: leaving.revision },
    );
    expect(archived.statusCode).toBe(200);
  });

  it("is not blocked by an archived test, whose current version still names them", async () => {
    api = await createApi("personas_archived_test_does_not_block");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const author = contextFor(ada, "member");
    const leaving = await createPersonaThrough(ada, "Leaving Lena");

    // A test always applies to at least one active agent, so a project that
    // holds none can hold no test.
    await createAgent(author, {
      name: `Front desk ${newId("agt").slice(-6)}`,
    });
    const named = await createTest(author, {
      name: "Reschedules a booked appointment",
      scenario: "Their Thursday cleaning has to move to next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [leaving.id],
    });

    // Nothing has moved off them: this test's **current** version still names
    // them. It is the test itself that is out of circulation, and a test that
    // is not going to run cannot lose a simulation.
    const blocked = await browse(
      "POST",
      `/api/personas/${leaving.id}/archive`,
      ada,
      { project: ada.projectId, expected_revision: leaving.revision },
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error).toBe("persona_in_use");

    await archiveTest(author, named.id);

    const archived = await browse(
      "POST",
      `/api/personas/${leaving.id}/archive`,
      ada,
      { project: ada.projectId, expected_revision: leaving.revision },
    );
    expect(archived.statusCode, JSON.stringify(archived.body)).toBe(200);
    expect(personaIn(archived).archived_at).toEqual(expect.any(String));
  });
});

describe("what a viewer is refused", () => {
  it("reads everything and is refused every write, in the role's own words", async () => {
    api = await createApi("personas_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const reader = await colleagueOf(api.app, ada, "reader@acme.example", "viewer");
    const made = await createPersonaThrough(ada, "Readable Rae");

    const read = await browse(
      "GET",
      `/api/personas/${made.id}?project=${ada.projectId}`,
      reader,
    );
    expect(read.statusCode).toBe(200);

    const history = await browse(
      "GET",
      `/api/personas/${made.id}/versions?project=${ada.projectId}`,
      reader,
    );
    expect(history.statusCode).toBe(200);

    const writes: readonly [string, string, Record<string, unknown>, string][] = [
      [
        "POST",
        "/api/personas",
        { project: ada.projectId, name: "Nope", traits: TRAITS },
        "create personas",
      ],
      [
        "PATCH",
        `/api/personas/${made.id}`,
        {
          project: ada.projectId,
          expected_revision: made.revision,
          name: "Nope",
        },
        "edit personas",
      ],
      [
        "POST",
        `/api/personas/${made.id}/clone`,
        { project: ada.projectId },
        "clone personas",
      ],
      [
        "POST",
        `/api/personas/${made.id}/archive`,
        { project: ada.projectId, expected_revision: made.revision },
        "archive personas",
      ],
      [
        "POST",
        `/api/personas/${made.id}/restore`,
        { project: ada.projectId, expected_revision: made.revision },
        "restore personas",
      ],
    ];

    for (const [method, url, payload, action] of writes) {
      const refused = await browse(
        method as "POST" | "PATCH",
        url,
        reader,
        payload,
      );
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.body).toEqual({
        error: "not_permitted",
        message:
          `Your viewer role cannot ${action}. Ask an organization admin to ` +
          "change your role, then try again.",
      });
    }

    // Nothing landed, which is the half that matters: the server is the
    // boundary, and a browser was never part of the decision.
    const listed = await browse(
      "GET",
      `/api/personas?project=${ada.projectId}`,
      ada,
    );
    expect((listed.body.items as WirePersona[]).map((one) => one.name)).toEqual([
      "Readable Rae",
      "Starter",
    ]);
  });
});

describe("history and usage", () => {
  it("reads one older version on its own, and says what uses the persona now", async () => {
    api = await createApi("personas_history_usage");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Historic Hana");

    await browse("PATCH", `/api/personas/${made.id}`, ada, {
      project: ada.projectId,
      expected_revision: made.revision,
      expected_version_id: made.version_id,
      traits: { ...TRAITS, language: "en-GB" },
    });

    const older = await browse(
      "GET",
      `/api/persona-versions/${made.version_id}?project=${ada.projectId}`,
      ada,
    );
    expect(older.statusCode).toBe(200);
    expect(older.body.version).toBe(1);
    expect((older.body.traits as Record<string, unknown>).language).toBe("en-US");

    const before = await browse(
      "GET",
      `/api/personas/${made.id}/usage?project=${ada.projectId}`,
      ada,
    );
    expect(before.body.tests).toEqual([]);

    // A test always applies to at least one active agent, so a project that
    // holds none can hold no test.
    await createAgent(contextFor(ada, "member"), {
      name: `Front desk ${newId("agt").slice(-6)}`,
    });
    const named = await createTest(contextFor(ada, "member"), {
      name: "Reschedules a booked appointment",
      scenario: "Their Thursday cleaning has to move to next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [made.id],
    });

    const after = await browse(
      "GET",
      `/api/personas/${made.id}/usage?project=${ada.projectId}`,
      ada,
    );
    expect(after.body.tests).toEqual([
      { id: named.id, name: "Reschedules a booked appointment" },
    ]);
  });

  it("says the same thing about a persona nobody here has, whichever read asked", async () => {
    api = await createApi("personas_absent");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const nobody = newId("prs");

    const expected = {
      error: "not_found",
      message:
        `There is no persona ${nobody} available in this project. Check the ` +
        "link, or choose it from the current project.",
    };

    for (const url of [
      `/api/personas/${nobody}?project=${ada.projectId}`,
      `/api/personas/${nobody}/versions?project=${ada.projectId}`,
      `/api/personas/${nobody}/usage?project=${ada.projectId}`,
    ]) {
      const refused = await browse("GET", url, ada);
      expect(refused.statusCode, url).toBe(404);
      expect(refused.body, url).toEqual(expected);
    }
  });
});
