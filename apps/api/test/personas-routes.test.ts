import {
  createProject,
  createAgent,
  createTest,
  archiveTest,
  editTest,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  type PersonaModels,
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
  manner: "Clear and direct.",
  patience: "Waits once before asking again.",
  accent: "Neutral American English.",
  backgroundNoise: "A quiet room.",
  underFriction: "Asks for a manager without becoming rude.",
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
  versionId: string;
  revision: string;
  archivedAt: string | null;
  isDefault: boolean;
  owner: "egma" | "organization";
  traits: Record<string, unknown>;
  models: PersonaModels;
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
  const made = await browse("POST", "/v1/personas", who, {
    projectId: projectId,
    name,
    traits,
    models: RECOMMENDED_PERSONA_MODELS,
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
  it("exports the closed model catalog and the release recommendations", async () => {
    api = await createApi("personas_model_catalog");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const form = await browse(
      "GET",
      `/v1/persona-form?projectId=${ada.projectId}`,
      ada,
    );

    expect(form.statusCode).toBe(200);
    expect(form.body.recommendedModels).toEqual(RECOMMENDED_PERSONA_MODELS);
    expect(form.body.speedRange).toEqual(SPEED_RANGE);
    expect(form.body.modelCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job: "stt",
          provider: "openai",
          model: "gpt-live-transcribe",
        }),
        expect.objectContaining({
          job: "stt",
          provider: "deepgram",
          model: "nova-3-general",
        }),
      ]),
    );
  });

  it("answers the whole persona, with both expectations a write will name", async () => {
    api = await createApi("personas_create");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await createPersonaThrough(ada, "Impatient Rita");

    expect(made.name).toBe("Impatient Rita");
    expect(made.version).toBe(1);
    expect(made.archivedAt).toBeNull();
    expect(made.isDefault).toBe(false);
    expect(made.owner).toBe("organization");
    expect(made.revision).toEqual(expect.any(String));
    expect(made.versionId).toEqual(expect.any(String));
    expect(made.traits).toEqual(TRAITS);
    expect(made.models).toEqual(RECOMMENDED_PERSONA_MODELS);

    const read = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(read.statusCode).toBe(200);
    expect(personaIn(read)).toEqual(made);
  });

  it("refuses a body that could never be written, in the factory's own words", async () => {
    api = await createApi("personas_validation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const nameless = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "   ",
      traits: TRAITS,
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a name",
    });

    const blankPersonality = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Fast Freddie",
      traits: { ...TRAITS, personality: "   " },
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(blankPersonality.statusCode).toBe(422);
    expect(blankPersonality.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a personality",
    });

    const missingLanguage = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No silent language default",
      traits: { personality: TRAITS.personality },
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(missingLanguage.statusCode).toBe(422);
    expect(missingLanguage.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a language",
    });

    const removedControl = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No dummy controls",
      traits: {
        ...TRAITS,
        voice: { provider: "cartesia", voiceId: "wrong-owner", speed: 1 },
      },
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(removedControl.statusCode).toBe(422);
    expect(removedControl.body).toEqual({
      error: "unprocessable",
      message:
        "persona traits have unsupported fields voice. " +
        "Provider, model, voice id, and speed belong in models.",
    });

    const unknownControl = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No silent controls",
      traits: { ...TRAITS, background_noise: "A busy kitchen." },
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(unknownControl.statusCode).toBe(422);
    expect(unknownControl.body).toEqual({
      error: "unprocessable",
      message:
        "persona traits have unsupported fields background_noise. " +
        "Provider, model, voice id, and speed belong in models.",
    });

    const missingModels = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No implicit execution",
      traits: TRAITS,
    });
    expect(missingModels.statusCode).toBe(422);
    expect(missingModels.body).toEqual({
      error: "unprocessable",
      message:
        "a persona needs one complete models value with llm, stt and tts",
    });

    const mismatchedStt = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No mismatched adapter",
      traits: TRAITS,
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model: "nova-3-general" },
      },
    });
    expect(mismatchedStt.statusCode).toBe(422);
    expect(String(mismatchedStt.body.message)).toContain(
      "openai/nova-3-general",
    );
  });

  it("accepts only speaking speeds that can reach the simulator", async () => {
    api = await createApi("personas_speed_range");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    for (const speed of [SPEED_RANGE.slowest, SPEED_RANGE.fastest]) {
      const made = await browse("POST", "/v1/personas", ada, {
        projectId: ada.projectId,
        name: `Speed ${speed}`,
        traits: TRAITS,
        models: {
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        },
      });
      expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
      expect(personaIn(made).models.tts.speed).toBe(speed);
    }

    for (const speed of [
      SPEED_RANGE.slowest - 0.0001,
      SPEED_RANGE.fastest + 0.0001,
    ]) {
      const refused = await browse("POST", "/v1/personas", ada, {
        projectId: ada.projectId,
        name: `Speed ${speed}`,
        traits: TRAITS,
        models: {
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.body).toEqual({
        error: "unprocessable",
        message:
          `speaking speed must be between ${SPEED_RANGE.slowest} and ` +
          `${SPEED_RANGE.fastest}`,
      });
    }
  });

  /**
   * **A persona says who is calling, never what they are calling about.**
   *
   * The whole worth of a persona is that one of them calls about forty
   * different situations, and a caller carrying a goal would quietly become a
   * second copy of one test. Refusing those keys is safer than silently
   * dropping them, because a successful write would claim the control worked.
   */
  it("refuses a test's scenario and goal at the persona door", async () => {
    api = await createApi("personas_no_scenario");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Smuggling Sid",
      traits: {
        ...TRAITS,
        scenario: "Their Thursday cleaning has to move to next week.",
        goal: "Reschedule the appointment.",
        wants: "An afternoon slot.",
      },
      models: RECOMMENDED_PERSONA_MODELS,
    });

    expect(made.statusCode).toBe(422);
    expect(made.body).toEqual({
      error: "unprocessable",
      message:
        "persona traits have unsupported fields scenario, goal, wants. " +
        "Provider, model, voice id, and speed belong in models.",
    });
  });

  it("shows the project's Egma-provided default in the list", async () => {
    api = await createApi("personas_default_visible");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const defaultPersonaId = await defaultPersonaOf(ada.projectId);

    const listed = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    const items = listed.body.personas as WirePersona[];
    const found = items.find((one) => one.id === defaultPersonaId);

    expect(found).toMatchObject({
      name: "Default Persona",
      description: "Regular conversationalist persona",
      version: 1,
      isDefault: true,
      owner: "egma",
      traits: {
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        manner: "Clear, natural, and conversational.",
        patience: "Starts patient and gives the agent time to explain.",
        accent: "Neutral American English.",
        backgroundNoise: "None.",
        underFriction:
          "Becomes firmer if the agent is confusing or repetitive, without becoming rude.",
      },
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(Object.keys(found?.traits ?? {}).sort()).toEqual(
      [
        "accent",
        "backgroundNoise",
        "language",
        "manner",
        "patience",
        "personality",
        "underFriction",
      ].sort(),
    );
    expect(items.filter((one) => one.isDefault)).toHaveLength(1);

    const refused = await browse(
      "PATCH",
      `/v1/personas/${defaultPersonaId}`,
      ada,
      {
        projectId: ada.projectId,
        expectedRevision: found?.revision,
        name: "The one everybody starts with",
      },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "egma_provided_persona",
      message:
        `Persona ${defaultPersonaId} is Egma-provided and cannot be changed. ` +
        "Fork it to make a Custom persona you can edit.",
    });
  });
});

describe("choosing the project default", () => {
  it("moves the project choice between a Custom and Egma-provided persona", async () => {
    api = await createApi("personas_choose_default");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const egmaProvidedId = await defaultPersonaOf(ada.projectId);
    const custom = await createPersonaThrough(ada, "Default Dana");

    const selectedCustom = await browse(
      "POST",
      `/v1/personas/${custom.id}/default`,
      ada,
      { projectId: ada.projectId },
    );
    expect(selectedCustom.statusCode).toBe(200);
    expect(personaIn(selectedCustom)).toMatchObject({
      id: custom.id,
      owner: "organization",
      isDefault: true,
    });
    expect(await defaultPersonaOf(ada.projectId)).toBe(custom.id);

    const selectedEgma = await browse(
      "POST",
      `/v1/personas/${egmaProvidedId}/default`,
      ada,
      { projectId: ada.projectId },
    );
    expect(selectedEgma.statusCode).toBe(200);
    expect(personaIn(selectedEgma)).toMatchObject({
      id: egmaProvidedId,
      owner: "egma",
      isDefault: true,
    });
    expect(await defaultPersonaOf(ada.projectId)).toBe(egmaProvidedId);
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

    await browse("POST", `/v1/personas/${second.id}/archive`, ada, {
      projectId: ada.projectId,
      expectedRevision: second.revision,
    });

    const active = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    const activeIds = (active.body.personas as WirePersona[]).map((one) => one.id);
    expect(activeIds).not.toContain(second.id);

    const searched = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}&search=O`,
      ada,
    );
    expect(
      (searched.body.personas as WirePersona[]).map((one) => one.name),
    ).toEqual(["Four", "One", "Default Persona"]);

    const archive = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}&archived=true`,
      ada,
    );
    expect((archive.body.personas as WirePersona[]).map((one) => one.id)).toEqual([
      second.id,
    ]);

    // The cursor is the last id of the page, so two pages hold the whole set
    // with no row seen twice and none missed.
    const first = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}&pageToken=${activeIds[0]}`,
      ada,
    );
    const after = (first.body.personas as WirePersona[]).map((one) => one.id);
    expect(after).toEqual(activeIds.slice(1));
    expect(first.body.nextPageToken).toBeNull();
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

    await browse("PATCH", `/v1/personas/${second.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: second.revision,
      description: "The second one.",
    });

    const one = await browse(
      "GET",
      `/v1/personas/${first.id}?projectId=${ada.projectId}`,
      ada,
    );
    const other = await browse(
      "GET",
      `/v1/personas/${second.id}?projectId=${ada.projectId}`,
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
      `/v1/personas?projectId=${ada.projectId}&pageToken=prsv_nonsense`,
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

    const refused = await browse("GET", "/v1/personas", ada);
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
    const shared = await defaultPersonaOf(ada.projectId);
    expect(await defaultPersonaOf(grace.projectId)).toBe(shared);
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
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    const defaultIds = (inDefault.body.personas as WirePersona[]).map((o) => o.id);
    const sharedPersona = (inDefault.body.personas as WirePersona[]).find(
      (one) => one.id === shared,
    );
    expect(sharedPersona?.owner).toBe("egma");
    expect(defaultIds).toContain(here.id);
    expect(defaultIds).not.toContain(there.id);

    // A persona of a sibling project is not reachable under the wrong project,
    // and reads exactly as one that was never minted.
    const misfiled = await browse(
      "GET",
      `/v1/personas/${there.id}?projectId=${ada.projectId}`,
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
      `/v1/personas/${here.id}?projectId=${ada.projectId}`,
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

    const renamed = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      name: "Rowan",
      description: "Somebody who calls about a bill.",
    });

    expect(renamed.statusCode).toBe(200);
    const now = personaIn(renamed);
    expect(now.name).toBe("Rowan");
    expect(now.description).toBe("Somebody who calls about a bill.");
    expect(now.version).toBe(1);
    expect(now.versionId).toBe(made.versionId);
    expect(now.revision).not.toBe(made.revision);
  });

  it("mints a version for changed traits, and nothing for identical ones", async () => {
    api = await createApi("personas_version");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Versioned Vera");

    const changed = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      expectedVersionId: made.versionId,
      traits: { ...TRAITS, personality: "Vera, after a long wait." },
    });
    expect(changed.statusCode).toBe(200);
    expect(personaIn(changed).version).toBe(2);

    const identical = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: personaIn(changed).revision,
      expectedVersionId: personaIn(changed).versionId,
      traits: personaIn(changed).traits,
    });
    expect(identical.statusCode).toBe(200);
    expect(personaIn(identical).version).toBe(2);
    expect(personaIn(identical).versionId).toBe(personaIn(changed).versionId);

    const history = await browse(
      "GET",
      `/v1/personas/${made.id}/versions?projectId=${ada.projectId}`,
      ada,
    );
    expect(
      (history.body.versions as { version: number }[]).map((v) => v.version),
    ).toEqual([2, 1]);
  });

  it("mints one version for one complete models change", async () => {
    api = await createApi("personas_models_version");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Modelled Maya");
    const models: PersonaModels = {
      ...made.models,
      tts: {
        provider: "openai",
        model: "gpt-4o-mini-tts",
        voiceId: "alloy",
        speed: 1.25,
      },
    };

    const changed = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      expectedVersionId: made.versionId,
      models,
    });

    expect(changed.statusCode).toBe(200);
    expect(personaIn(changed)).toMatchObject({ version: 2, models });

    const history = await browse(
      "GET",
      `/v1/personas/${made.id}/versions?projectId=${ada.projectId}`,
      ada,
    );
    expect(history.body.versions).toMatchObject([
      { version: 2, traits: TRAITS, models },
      { version: 1, traits: TRAITS, models: RECOMMENDED_PERSONA_MODELS },
    ]);
  });

  it("refuses an identity write against a revision the persona has moved past", async () => {
    api = await createApi("personas_identity_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Contested Cora");

    await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      name: "Cora, renamed once",
    });

    // The second tab, still holding the revision it read before that.
    const refused = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      name: "Cora, renamed twice",
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "identity_conflict",
      message:
        `Persona ${made.id} changed after you opened it. Read it again, keep ` +
        "or reapply your edits, and send the update with expectedRevision " +
        "set to its new revision.",
    });

    const now = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(now).name).toBe("Cora, renamed once");
  });

  it("refuses a traits write against a version the content has moved past", async () => {
    api = await createApi("personas_version_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Contested Cyrus");

    const second = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      expectedVersionId: made.versionId,
      traits: {
        ...TRAITS,
        personality: "Cyrus waits once, then asks for a manager.",
      },
    });

    const refused = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: personaIn(second).revision,
      expectedVersionId: made.versionId,
      traits: {
        ...TRAITS,
        personality: "Cyrus asks for a manager immediately.",
      },
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({
      error: "version_conflict",
      message:
        `this persona edit was written against version ${made.versionId}, ` +
        `and it has moved on to ${personaIn(second).versionId}. Read the ` +
        "persona again, keep or reapply your edits, and send them with " +
        `expectedVersionId set to ${personaIn(second).versionId}.`,
    });
  });

  it("requires both expectations, and says which one is missing", async () => {
    api = await createApi("personas_expectations");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Guarded Gail");

    const noRevision = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      name: "Gail",
    });
    expect(noRevision.statusCode).toBe(422);
    expect(String(noRevision.body.message)).toContain("expectedRevision");

    const noVersion = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      traits: { ...TRAITS, personality: "Gail is still waiting." },
    });
    expect(noVersion.statusCode).toBe(422);
    expect(String(noVersion.body.message)).toContain("expectedVersionId");

    const noModelsVersion = await browse(
      "PATCH",
      `/v1/personas/${made.id}`,
      ada,
      {
        projectId: ada.projectId,
        expectedRevision: made.revision,
        models: RECOMMENDED_PERSONA_MODELS,
      },
    );
    expect(noModelsVersion.statusCode).toBe(422);
    expect(String(noModelsVersion.body.message)).toContain(
      "expectedVersionId",
    );
  });
});

describe("forking a persona", () => {
  it("makes an editable project persona from the current definition, with no history", async () => {
    api = await createApi("personas_fork");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = personaIn(
      await browse(
        "GET",
        `/v1/personas/${await defaultPersonaOf(ada.projectId)}?projectId=${ada.projectId}`,
        ada,
      ),
    );

    const forked = await browse("POST", `/v1/personas/${made.id}/fork`, ada, {
      projectId: ada.projectId,
    });

    expect(forked.statusCode).toBe(201);
    const fork = personaIn(forked);
    expect(fork.id).not.toBe(made.id);
    expect(fork.name).toBe(made.name);
    expect(fork.traits).toEqual(made.traits);
    expect(fork.models).toEqual(made.models);
    expect(fork.owner).toBe("organization");
    // Its own history, starting over: the source's versions are the source's.
    expect(fork.version).toBe(1);
    expect(fork.versionId).not.toBe(made.versionId);

    const history = await browse(
      "GET",
      `/v1/personas/${fork.id}/versions?projectId=${ada.projectId}`,
      ada,
    );
    expect(history.body.versions).toHaveLength(1);
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
      `/v1/personas/${made.id}/archive`,
      ada,
      { projectId: ada.projectId, expectedRevision: made.revision },
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
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(still).archivedAt).toBeNull();
  });

  it("refuses every lifecycle write to an Egma-provided persona", async () => {
    api = await createApi("personas_egma_provided_lifecycle");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const defaultPersonaId = await defaultPersonaOf(ada.projectId);
    const read = await browse(
      "GET",
      `/v1/personas/${defaultPersonaId}?projectId=${ada.projectId}`,
      ada,
    );
    const holding = personaIn(read);

    for (const action of ["archive", "restore"] as const) {
      const refused = await browse(
        "POST",
        `/v1/personas/${defaultPersonaId}/${action}`,
        ada,
        { projectId: ada.projectId, expectedRevision: holding.revision },
      );
      expect(refused.statusCode, action).toBe(422);
      expect(refused.body, action).toEqual({
        error: "egma_provided_persona",
        message:
          `Persona ${defaultPersonaId} is Egma-provided and cannot be changed. ` +
          "Fork it to make a Custom persona you can edit.",
      });
    }
  });

  it("archives an eligible persona and restores them again", async () => {
    api = await createApi("personas_archive_restore");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Filed-Away Fay");

    const archived = await browse(
      "POST",
      `/v1/personas/${made.id}/archive`,
      ada,
      { projectId: ada.projectId, expectedRevision: made.revision },
    );
    expect(archived.statusCode).toBe(200);
    expect(personaIn(archived).archivedAt).toEqual(expect.any(String));

    const restored = await browse(
      "POST",
      `/v1/personas/${made.id}/restore`,
      ada,
      {
        projectId: ada.projectId,
        expectedRevision: personaIn(archived).revision,
      },
    );
    expect(restored.statusCode).toBe(200);
    expect(personaIn(restored).archivedAt).toBeNull();

    const active = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    expect((active.body.personas as WirePersona[]).map((one) => one.id)).toContain(
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
      `/v1/personas/${leaving.id}/archive`,
      ada,
      { projectId: ada.projectId, expectedRevision: leaving.revision },
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
      `/v1/personas/${leaving.id}/archive`,
      ada,
      { projectId: ada.projectId, expectedRevision: leaving.revision },
    );
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error).toBe("persona_in_use");

    await archiveTest(author, named.id);

    const archived = await browse(
      "POST",
      `/v1/personas/${leaving.id}/archive`,
      ada,
      { projectId: ada.projectId, expectedRevision: leaving.revision },
    );
    expect(archived.statusCode, JSON.stringify(archived.body)).toBe(200);
    expect(personaIn(archived).archivedAt).toEqual(expect.any(String));
  });
});

describe("what a viewer is refused", () => {
  it("reads everything and is refused every write, in the role's own words", async () => {
    api = await createApi("personas_viewer");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const reader = await colleagueOf(
      api.app,
      ada,
      "reader@acme.example",
      "viewer",
    );
    const made = await createPersonaThrough(ada, "Readable Rae");

    const read = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      reader,
    );
    expect(read.statusCode).toBe(200);

    const history = await browse(
      "GET",
      `/v1/personas/${made.id}/versions?projectId=${ada.projectId}`,
      reader,
    );
    expect(history.statusCode).toBe(200);

    const writes: readonly [string, string, Record<string, unknown>, string][] =
      [
        [
          "POST",
          "/v1/personas",
          { projectId: ada.projectId, name: "Nope", traits: TRAITS },
          "create personas",
        ],
        [
          "PATCH",
          `/v1/personas/${made.id}`,
          {
            projectId: ada.projectId,
            expectedRevision: made.revision,
            name: "Nope",
          },
          "edit personas",
        ],
        [
          "POST",
          `/v1/personas/${made.id}/fork`,
          { projectId: ada.projectId },
          "fork personas",
        ],
        [
          "POST",
          `/v1/personas/${made.id}/default`,
          { projectId: ada.projectId },
          "change the project default persona",
        ],
        [
          "POST",
          `/v1/personas/${made.id}/archive`,
          { projectId: ada.projectId, expectedRevision: made.revision },
          "archive personas",
        ],
        [
          "POST",
          `/v1/personas/${made.id}/restore`,
          { projectId: ada.projectId, expectedRevision: made.revision },
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
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    expect(
      (listed.body.personas as WirePersona[]).map((one) => one.name),
    ).toContain("Readable Rae");
  });
});

describe("history and usage", () => {
  it("reads one older version on its own, and says what uses the persona now", async () => {
    api = await createApi("personas_history_usage");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Historic Hana");

    await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      expectedRevision: made.revision,
      expectedVersionId: made.versionId,
      traits: {
        ...TRAITS,
        personality: "Hana has waited too long and is now blunt.",
      },
    });

    const older = await browse(
      "GET",
      `/v1/persona-versions/${made.versionId}?projectId=${ada.projectId}`,
      ada,
    );
    expect(older.statusCode).toBe(200);
    expect(older.body.version).toBe(1);
    expect((older.body.traits as Record<string, unknown>).personality).toBe(
      TRAITS.personality,
    );

    const before = await browse(
      "GET",
      `/v1/personas/${made.id}/usage?projectId=${ada.projectId}`,
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
      `/v1/personas/${made.id}/usage?projectId=${ada.projectId}`,
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
      `/v1/personas/${nobody}?projectId=${ada.projectId}`,
      `/v1/personas/${nobody}/versions?projectId=${ada.projectId}`,
      `/v1/personas/${nobody}/usage?projectId=${ada.projectId}`,
    ]) {
      const refused = await browse("GET", url, ada);
      expect(refused.statusCode, url).toBe(404);
      expect(refused.body, url).toEqual(expected);
    }
  });
});
