import {
  createProject,
  createTest,
  createTestSuite,
  EGMA_PROVIDED_PERSONAS,
  RECOMMENDED_PERSONA_MODELS as INTERNAL_RECOMMENDED_PERSONA_MODELS,
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
 * Persona HTTP coverage for payloads, permissions, project selection, and
 * refusal codes and messages. Reject traits wrappers and obsolete identity
 * revision fields; behavior edits use expectedVersionId.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** The authored person, as a create body carries them. */
const BEHAVIOR = {
  identityName: "Rita Alvarez",
  personality: "Calls about a bill and wants it settled today.",
} as const;

const CONTROLS = {
  language: "en-US",
  backgroundSoundId: "rain-v1",
  interruptionLevel: "occasional",
} as const;

const DEFAULT_CONTROLS = {
  language: "en-US",
  backgroundSoundId: "none",
  interruptionLevel: "none",
} as const;

const RECOMMENDED_PERSONA_MODELS = {
  ...INTERNAL_RECOMMENDED_PERSONA_MODELS,
  tts: {
    provider: INTERNAL_RECOMMENDED_PERSONA_MODELS.tts.provider,
    model: INTERNAL_RECOMMENDED_PERSONA_MODELS.tts.model,
    voiceId: INTERNAL_RECOMMENDED_PERSONA_MODELS.tts.voiceId,
  },
} as const;

type Behavior = {
  readonly identityName: string;
  readonly personality: string;
};

/** One browser request: a session cookie, and the project in the address. */
async function browse(
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
    // A 204 carries no body at all, which is the whole of what Delete answers.
    body:
      response.body === ""
        ? {}
        : (response.json() as Record<string, unknown>),
  };
}

type WirePersona = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  versionId: string;
  archivedAt: string | null;
  owner: "egma" | "organization";
  identityName: string;
  personality: string;
  language: string;
  settings: { id: string; models: typeof RECOMMENDED_PERSONA_MODELS; controls: { language: string; backgroundSoundId: string; interruptionLevel?: string } } | null;
};

function personaIn(answer: Answer): WirePersona {
  return answer.body as unknown as WirePersona;
}

async function createPersonaThrough(
  who: Customer,
  name: string,
  behavior: Behavior = BEHAVIOR,
  projectId = who.projectId,
): Promise<WirePersona> {
  const made = await browse("POST", "/v1/personas", who, {
    projectId: projectId,
    name,
    ...behavior,
    models: RECOMMENDED_PERSONA_MODELS,
    controls: DEFAULT_CONTROLS,
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  return personaIn(made);
}

/** Use the shared persona catalog ID; projects store no default-persona pointer. */
const PREDEFINED_PERSONA = EGMA_PROVIDED_PERSONAS.defaultPersona;

/** Refusal message for protected Egma-provided persona edits. */
function predefinedRefusal(personaId: string): Record<string, unknown> {
  return {
    error: "egma_provided_persona",
    message:
      `Persona ${personaId} is Predefined. Its core and metadata cannot be changed, and it cannot be deleted. ` +
      "Clone it to make a changed Custom persona.",
  };
}

describe("creating and reading a persona", () => {
  it("saves GPT Live with an independent reasoning model and no inactive speech services", async () => {
    api = await createApi("personas_gpt_live_authoring");
    const ada = await signUp(api.app, "live-author@acme.example", "Acme");
    const models = {
      mode: "live" as const,
      llm: { provider: "openai", model: "gpt-5.6-sol" },
      live: { provider: "openai" as const, model: "gpt-live-1" as const, adapter: "openai_live" as const, voiceId: "beacon" },
    };
    const liveControls = { language: "en-US", backgroundSoundId: "rain-v1" } as const;
    const made = await browse("POST", "/v1/personas", ada, { projectId: ada.projectId, name: "Live caller", ...BEHAVIOR, models, controls: liveControls });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    expect(personaIn(made).settings?.models).toEqual(models);
    expect(personaIn(made).settings?.models).not.toHaveProperty("stt");
    expect(personaIn(made).settings?.models).not.toHaveProperty("tts");
    const read = await browse("GET", `/v1/personas/${personaIn(made).id}?projectId=${ada.projectId}`, ada);
    expect(personaIn(read).settings?.models).toEqual(models);

    const refused = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Invalid Live voice",
      ...BEHAVIOR,
      models: { ...models, live: { ...models.live, voiceId: "nova" } },
      controls: liveControls,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toMatchObject({ message: expect.stringContaining("models.live.voiceId") });
  });
  it("refuses a body that could never be written, in the factory's own words", async () => {
    api = await createApi("personas_validation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const nameless = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "   ",
      ...BEHAVIOR,
    });
    expect(nameless.statusCode).toBe(422);
    expect(nameless.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a name",
    });

    const anonymous = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No name to give",
      ...BEHAVIOR,
      identityName: "   ",
    });
    expect(anonymous.statusCode).toBe(422);
    expect(anonymous.body).toEqual({
      error: "unprocessable",
      message:
        "a persona needs an identity name, because the agent is told who is " +
        "calling",
    });

    const blankPersonality = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Fast Freddie",
      ...BEHAVIOR,
      personality: "   ",
    });
    expect(blankPersonality.statusCode).toBe(422);
    expect(blankPersonality.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a personality",
    });

    const defaultLanguage = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Default English language",
      identityName: BEHAVIOR.identityName,
      personality: BEHAVIOR.personality,
    });
    expect(defaultLanguage.statusCode).toBe(201);
    expect(personaIn(defaultLanguage).language).toBe("en-US");

    const missingModels = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Recommended project settings",
      ...BEHAVIOR,
    });
    expect(missingModels.statusCode).toBe(201);
    expect(personaIn(missingModels).settings?.models).toEqual(RECOMMENDED_PERSONA_MODELS);

    const mismatchedStt = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No mismatched adapter",
      ...BEHAVIOR,
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        stt: { provider: "openai", model: "nova-3-general" },
      },
      controls: DEFAULT_CONTROLS,
    });
    expect(mismatchedStt.statusCode).toBe(422);
    expect(String(mismatchedStt.body.message)).toContain(
      "openai/nova-3-general",
    );

    const modelsOnly = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No discarded models",
      ...BEHAVIOR,
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(modelsOnly.statusCode).toBe(422);
    expect(modelsOnly.body).toEqual({
      error: "unprocessable",
      message:
        "models and controls must be sent together when creating a persona with custom settings.",
    });

    const controlsOnly = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No discarded controls",
      ...BEHAVIOR,
      controls: DEFAULT_CONTROLS,
    });
    expect(controlsOnly.statusCode).toBe(422);
    expect(controlsOnly.body).toEqual({
      error: "unprocessable",
      message:
        "models and controls must be sent together when creating a persona with custom settings.",
    });

    const listed = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    expect(listed.body.personas).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "No discarded models" }),
        expect.objectContaining({ name: "No discarded controls" }),
      ]),
    );
  });

  /**
   * Reject obsolete traits, accent, background-noise, and revision fields.
   * Behavior edits use expectedVersionId; unknown fields must not be silently ignored.
   */
  it("refuses every key the old persona shape carried", async () => {
    api = await createApi("personas_no_old_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Shapely Sam");

    const carries =
      "a persona body carries projectId, name, description, identityName, " +
      "personality, models, controls.";

    const retired = {
      traits: { personality: "Old shape.", language: "en-US" },
      accent: "Neutral American English.",
      backgroundNoise: "A quiet room.",
      // Old authoring tokens have no minter. A stale client must get a clear
      // refusal instead of a successful write that ignores them.
      revision: "rev_01M0E4EVJ6ECGVJEA4NSBTC0CC",
      expectedRevision: "rev_01M0E4EVJ6ECGVJEA4NSBTC0CC",
      voiceAccessProof: "retired-preview-proof",
      isDefault: true,
      scenario: "Their Thursday cleaning has to move to next week.",
      goal: "Reschedule the appointment.",
    };

    for (const [field, value] of Object.entries(retired)) {
      const created = await browse("POST", "/v1/personas", ada, {
        projectId: ada.projectId,
        name: `No ${field}`,
        ...BEHAVIOR,
        models: RECOMMENDED_PERSONA_MODELS,
        [field]: value,
      });
      expect(created.statusCode, field).toBe(422);
      expect(created.body, field).toEqual({
        error: "unprocessable",
        message: `a persona has no key "${field}"; ${carries}`,
      });

    }

    const retiredUpdate = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      name: "No saved edits",
    });
    expect(retiredUpdate.statusCode).toBe(404);

    // Nothing landed: the name is still the one it was created with.
    const still = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(still).name).toBe("Shapely Sam");
  });
});

describe("the list", () => {
  it("holds only living personas, and pages with a keyset cursor", async () => {
    api = await createApi("personas_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = [];
    for (const name of ["One", "Two", "Three", "Four"]) {
      made.push(await createPersonaThrough(ada, name));
    }
    const [, second] = made;
    if (second === undefined) throw new Error("nothing was made");

    const deleted = await browse(
      "DELETE",
      `/v1/personas/${second.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(deleted.statusCode).toBe(204);

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
    // "Two" was deleted, and the Egma-provided persona carries no `o` in its
    // name, so what one letter leaves is the two rows that do hold it.
    expect(
      (searched.body.personas as WirePersona[]).map((one) => one.name),
    ).toEqual(["Four", "One"]);

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
    const outbound = await createProject(contextFor(ada, "admin"), {
      name: "Outbound",
      slug: "outbound",
    });

    const here = await createPersonaThrough(ada, "In Default");
    const there = await createPersonaThrough(
      ada,
      "In Outbound",
      BEHAVIOR,
      outbound.id,
    );

    const inDefault = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    const defaultIds = (inDefault.body.personas as WirePersona[]).map((o) => o.id);
    // Egma's own persona is shared into every project of every organization.
    const sharedPersona = (inDefault.body.personas as WirePersona[]).find(
      (one) => one.id === PREDEFINED_PERSONA,
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

describe("forking a persona", () => {
  it("creates and clones the complete settings sent by the persona form", async () => {
    api = await createApi("personas_complete_create_and_fork");
    const ada = await signUp(api.app, "complete@acme.example", "Acme");
    const models = {
      ...RECOMMENDED_PERSONA_MODELS,
      tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: "alloy" },
    };

    const createdAnswer = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Configured caller",
      ...BEHAVIOR,
      models,
      controls: CONTROLS,
    });
    expect(createdAnswer.statusCode, JSON.stringify(createdAnswer.body)).toBe(201);
    const created = personaIn(createdAnswer);
    expect(created.settings).toMatchObject({ models, controls: CONTROLS });

    const forkedAnswer = await browse("POST", `/v1/personas/${created.id}/fork`, ada, {
      projectId: ada.projectId,
    });
    expect(forkedAnswer.statusCode, JSON.stringify(forkedAnswer.body)).toBe(201);
    expect(personaIn(forkedAnswer).settings).toMatchObject({
      models,
      controls: CONTROLS,
    });
  });

  it("validates complete model and control overrides on a clone", async () => {
    api = await createApi("personas_models_only_validation");
    const ada = await signUp(api.app, "model-validation@acme.example", "Acme");
    const privateVoice = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Private voice",
      ...BEHAVIOR,
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: "customer-private-voice" },
      },
      controls: DEFAULT_CONTROLS,
    });
    expect(privateVoice.statusCode).toBe(422);
    expect(privateVoice.body.message).toBe("models.tts.voiceId: Choose one of the available voices.");
    const incompatibleStandard = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId, name: "Invalid standard voice", ...BEHAVIOR,
      models: { ...RECOMMENDED_PERSONA_MODELS, tts: { provider: "openai", model: "tts-1", voiceId: "cedar" } },
      controls: DEFAULT_CONTROLS,
    });
    expect(incompatibleStandard.statusCode).toBe(422);
    expect(incompatibleStandard.body.message).toBe("models.tts.voiceId: cedar is not supported by tts-1.");

    const retained = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId, name: "Retained controls", ...BEHAVIOR,
      models: RECOMMENDED_PERSONA_MODELS, controls: CONTROLS,
    });
    expect(retained.statusCode, JSON.stringify(retained.body)).toBe(201);
    const changedModels = { ...RECOMMENDED_PERSONA_MODELS, llm: { provider: "openai", model: "gpt-5.6-terra" } };
    const changed = await browse("POST", `/v1/personas/${personaIn(retained).id}/fork`, ada, {
      projectId: ada.projectId,
      name: "Changed model clone",
      description: "",
      identityName: "Morgan Chen",
      personality: "Asks for a short answer and stays calm.",
      models: changedModels,
      controls: CONTROLS,
    });
    expect(changed.statusCode, JSON.stringify(changed.body)).toBe(201);
    expect(personaIn(changed).settings).toMatchObject({
      models: changedModels,
      controls: CONTROLS,
    });
    expect(personaIn(changed)).toMatchObject({
      name: "Changed model clone",
      description: "",
      identityName: "Morgan Chen",
      personality: "Asks for a short answer and stays calm.",
    });
    const source = await browse(
      "GET",
      `/v1/personas/${personaIn(retained).id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(source).settings?.models).toEqual(RECOMMENDED_PERSONA_MODELS);

    const incomplete = await browse("POST", `/v1/personas/${personaIn(retained).id}/fork`, ada, {
      projectId: ada.projectId,
      models: changedModels,
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.body.message).toContain("models and controls must be sent together");
  });

  it("keeps the source speech mode and refuses interruptions for Live clones", async () => {
    api = await createApi("personas_clone_mode_lock");
    const ada = await signUp(api.app, "clone-mode@acme.example", "Acme");
    const liveModels = {
      mode: "live" as const,
      llm: { provider: "openai", model: "gpt-5.6-sol" },
      live: { provider: "openai" as const, model: "gpt-live-1" as const, adapter: "openai_live" as const, voiceId: "beacon" },
    };
    const source = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Live source",
      ...BEHAVIOR,
      models: liveModels,
      controls: { language: "en-US", backgroundSoundId: "none" },
    });
    expect(source.statusCode).toBe(201);

    const changedMode = await browse("POST", `/v1/personas/${personaIn(source).id}/fork`, ada, {
      projectId: ada.projectId,
      models: RECOMMENDED_PERSONA_MODELS,
      controls: CONTROLS,
    });
    expect(changedMode.statusCode).toBe(422);
    expect(changedMode.body.message).toContain("must keep the source speech mode");

    const interruptedLive = await browse("POST", `/v1/personas/${personaIn(source).id}/fork`, ada, {
      projectId: ada.projectId,
      models: liveModels,
      controls: { language: "en-US", backgroundSoundId: "none", interruptionLevel: "none" },
    });
    expect(interruptedLive.statusCode).toBe(422);
    expect(interruptedLive.body.message).toContain("live personas do not support interruptions");
  });

  it("returns 422 for invalid controls and leaves saved settings unchanged", async () => {
    api = await createApi("personas_invalid_controls");
    const ada = await signUp(api.app, "invalid-controls@acme.example", "Acme");
    const invalidCreate = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId, name: "Invalid", ...BEHAVIOR,
      models: RECOMMENDED_PERSONA_MODELS,
      controls: { ...CONTROLS, speechVolume: 99 },
    });
    expect(invalidCreate.statusCode).toBe(422);
    expect(invalidCreate.body.message).toContain("controls.speechVolume");

    const created = await createPersonaThrough(ada, "Stable settings");
    const before = created.settings;
    const invalidUpdate = await browse("POST", `/v1/personas/${created.id}/fork`, ada, {
      projectId: ada.projectId,
      models: RECOMMENDED_PERSONA_MODELS,
      controls: { ...CONTROLS, executionPolicyVersion: 9 },
    });
    expect(invalidUpdate.statusCode).toBe(422);
    expect(invalidUpdate.body.message).toContain("server owns policy versions");
    const after = await browse("GET", `/v1/personas/${created.id}?projectId=${ada.projectId}`, ada);
    expect(personaIn(after).settings).toEqual(before);

  });
});

describe("deleting a persona", () => {
  it("takes them out of every list and leaves every version readable", async () => {
    api = await createApi("personas_delete");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Filed-Away Fay");

    const deleted = await browse(
      "DELETE",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toEqual({});

    const listed = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    expect(
      (listed.body.personas as WirePersona[]).map((one) => one.id),
    ).not.toContain(made.id);

    // Read directly they are still there, carrying the stamp that says they
    // have gone — which is what keeps a run that pinned them interpretable.
    const read = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(read.statusCode).toBe(200);
    expect(personaIn(read).archivedAt).toEqual(expect.any(String));

    const history = await browse(
      "GET",
      `/v1/personas/${made.id}/versions?projectId=${ada.projectId}`,
      ada,
    );
    expect(history.statusCode).toBe(200);
    expect(history.body.versions).toHaveLength(1);

    // Two tabs pressing Delete is an ordinary thing to happen, and the second
    // one has nothing to complain about.
    const again = await browse(
      "DELETE",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(again.statusCode).toBe(204);
  });

  /**
   * **A live test naming them does not refuse it.**
   *
   * That guard belonged to the days when a test created naming nobody was
   * silently given the project's default, so one Delete could quietly empty a
   * page of tests. Tests name their personas out loud now, and the protection
   * sits where the loss would happen: a run for a test naming a deleted
   * persona is refused, and that test's next write has to name somebody alive.
   */
  it("is not refused by an active test that names them", async () => {
    api = await createApi("personas_delete_in_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Named Nadia");

    const author = contextFor(ada, "member");
    const suite = await createTestSuite(author, { name: "Persona use" });
    await createTest(author, {
      suiteId: suite.id,
      name: "Reschedules a booked appointment",
      scenario: "Their Thursday cleaning has to move to next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [made.id],
    });

    const deleted = await browse(
      "DELETE",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(deleted.statusCode, JSON.stringify(deleted.body)).toBe(204);

    const read = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(read).archivedAt).toEqual(expect.any(String));
  });

  it("refuses to delete a Predefined persona, in the word every screen uses", async () => {
    api = await createApi("personas_predefined_undeletable");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await browse(
      "DELETE",
      `/v1/personas/${PREDEFINED_PERSONA}?projectId=${ada.projectId}`,
      ada,
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual(predefinedRefusal(PREDEFINED_PERSONA));

    const still = await browse(
      "GET",
      `/v1/personas/${PREDEFINED_PERSONA}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(still).archivedAt).toBeNull();
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

    const writes: readonly [
      "POST" | "DELETE",
      string,
      Record<string, unknown> | undefined,
      string,
    ][] = [
      [
        "POST",
        "/v1/personas",
        {
          projectId: ada.projectId,
          name: "Nope",
          ...BEHAVIOR,
          models: RECOMMENDED_PERSONA_MODELS,
        },
        "create personas",
      ],
      [
        "POST",
        `/v1/personas/${made.id}/fork`,
        { projectId: ada.projectId },
        "fork personas",
      ],
      [
        "DELETE",
        `/v1/personas/${made.id}?projectId=${ada.projectId}`,
        undefined,
        "delete personas",
      ],
    ];

    for (const [method, url, payload, action] of writes) {
      const refused = await browse(method, url, reader, payload);
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
  it("reads the immutable version on its own, and says what uses the persona now", async () => {
    api = await createApi("personas_history_usage");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Historic Hana");

    const older = await browse(
      "GET",
      `/v1/persona-versions/${made.versionId}?projectId=${ada.projectId}`,
      ada,
    );
    expect(older.statusCode).toBe(200);
    expect(older.body.version).toBe(1);
    expect(older.body.personality).toBe(BEHAVIOR.personality);
    expect(older.body.identityName).toBe(BEHAVIOR.identityName);

    const before = await browse(
      "GET",
      `/v1/personas/${made.id}/usage?projectId=${ada.projectId}`,
      ada,
    );
    expect(before.body.tests).toEqual([]);

    const author = contextFor(ada, "member");
    const suite = await createTestSuite(author, { name: "Usage" });
    const named = await createTest(author, {
      suiteId: suite.id,
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
