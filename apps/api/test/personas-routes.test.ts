import {
  createProject,
  createTest,
  createTestSuite,
  EGMA_PROVIDED_PERSONAS,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  type PersonaModels,
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
 * who may do what, and every refusal sentence word for word. **Refusal wording
 * is contract** — it is what a page shows somebody and what tells them their
 * next move — so a sentence that changed without anybody deciding to change it
 * fails here.
 *
 * The factory beneath has its own tests and none of them are repeated. What is
 * new at this seam is everything the wire adds: a project named on every
 * browser request, the codes a client branches on, and the fact that a
 * viewer's write is refused by the server whether or not a browser was
 * involved.
 *
 * **The authored person is flat, and there is no old shape.** A body still
 * carrying a `traits` wrapper or either expectation token is refused rather
 * than half-applied, and that refusal is asserted here field by field: a
 * client written against the shape this replaced must be told, never quietly
 * answered `200` with nothing of its edit landed.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** The authored person, as a create body carries them. */
const BEHAVIOR = {
  identityName: "Rita Alvarez",
  personality: "Calls about a bill and wants it settled today.",
  language: "en-US",
} as const;

type Behavior = {
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
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
  models: PersonaModels;
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
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  return personaIn(made);
}

/**
 * Egma's own persona, readable from every project.
 *
 * It used to be found through the project's `default_persona_id` pointer. That
 * column is gone with everything that guarded it, so the catalog's fixed
 * identifier is what names them now — which is what it always was underneath.
 */
const PREDEFINED_PERSONA = EGMA_PROVIDED_PERSONAS.defaultPersona;

/** The one sentence every write to a Predefined persona is refused with. */
function predefinedRefusal(personaId: string): Record<string, unknown> {
  return {
    error: "egma_provided_persona",
    message:
      `Persona ${personaId} is Predefined and cannot be changed or deleted. ` +
      "Fork it to make a Custom persona you can edit.",
  };
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
    const catalog = form.body.modelCatalog as readonly Record<string, unknown>[];
    expect(
      catalog.map(
        (entry) => `${entry.job}:${entry.provider}:${entry.model}`,
      ),
    ).toEqual([
      "llm:openai:gpt-4o-mini",
      "llm:openai:gpt-4o",
      "llm:openai:gpt-5.6-terra",
      "llm:openai:gpt-5.6-sol",
      "llm:openai:gpt-5.6-luna",
      "llm:openai:gpt-5.5",
      "llm:openai:gpt-5.4",
      "stt:openai:gpt-live-transcribe",
      "stt:openai:gpt-realtime-whisper",
      "stt:openai:gpt-4o-transcribe",
      "stt:openai:gpt-4o-mini-transcribe",
      "stt:deepgram:nova-3-general",
      "stt:cartesia:ink-2",
      "tts:cartesia:sonic-3.5",
      "tts:cartesia:sonic-preview",
      "tts:openai:gpt-4o-mini-tts",
      "tts:openai:tts-1",
      "tts:openai:tts-1-hd",
    ]);
    for (const entry of catalog.filter((candidate) => candidate.job === "llm")) {
      expect(entry).not.toHaveProperty("reasoningEffort");
      expect(entry).not.toHaveProperty("reasoningEfforts");
      expect(entry).not.toHaveProperty("recommendedReasoningEffort");
    }
    expect(
      catalog.find((entry) => entry.model === "sonic-preview"),
    ).toMatchObject({ modelLabel: "Sonic 3.6 (Beta)" });
  });

  it("answers the whole persona flat, with two names that live different lives", async () => {
    api = await createApi("personas_create");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const made = await createPersonaThrough(ada, "Impatient Rita");

    // The team's word for the library row, and the name the agent will hear.
    expect(made.name).toBe("Impatient Rita");
    expect(made.identityName).toBe(BEHAVIOR.identityName);
    expect(made.personality).toBe(BEHAVIOR.personality);
    expect(made.language).toBe(BEHAVIOR.language);
    expect(made.version).toBe(1);
    expect(made.archivedAt).toBeNull();
    expect(made.owner).toBe("organization");
    expect(made.versionId).toEqual(expect.any(String));
    expect(made.models).toEqual(RECOMMENDED_PERSONA_MODELS);

    // The retired machinery is off the wire entirely, not merely unused.
    for (const gone of ["traits", "revision", "isDefault"]) {
      expect(made, gone).not.toHaveProperty(gone);
    }

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
      ...BEHAVIOR,
      models: RECOMMENDED_PERSONA_MODELS,
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
      models: RECOMMENDED_PERSONA_MODELS,
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
      identityName: BEHAVIOR.identityName,
      personality: BEHAVIOR.personality,
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(missingLanguage.statusCode).toBe(422);
    expect(missingLanguage.body).toEqual({
      error: "unprocessable",
      message: "a persona needs a language",
    });

    const missingModels = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No implicit execution",
      ...BEHAVIOR,
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
      ...BEHAVIOR,
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

  /**
   * **The shape this replaced is refused, never half-applied.**
   *
   * A client written against the old persona API sent a `traits` wrapper with
   * an accent and a background noise inside it, and named two expectations on
   * every edit. None of those exist. Dropping them silently would answer `201`
   * to a create whose personality nobody read, and `200` to an edit that
   * believed in a guard that is not there — so each is refused by name.
   */
  it("refuses every key the old persona shape carried", async () => {
    api = await createApi("personas_no_old_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Shapely Sam");

    const carries =
      "a persona body carries projectId, name, description, identityName, " +
      "personality, language, models.";

    const retired = {
      traits: { personality: "Old shape.", language: "en-US" },
      accent: "Neutral American English.",
      backgroundNoise: "A quiet room.",
      // The two tokens the shape this replaced named on every write. There is
      // no minter for them any more, which is the point: they are text a stale
      // client would send, and text is all this door has to refuse.
      revision: "rev_01M0E4EVJ6ECGVJEA4NSBTC0CC",
      expectedRevision: "rev_01M0E4EVJ6ECGVJEA4NSBTC0CC",
      expectedVersionId: made.versionId,
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

      const edited = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
        projectId: ada.projectId,
        name: `No ${field}`,
        [field]: value,
      });
      expect(edited.statusCode, field).toBe(422);
      expect(edited.body, field).toEqual({
        error: "unprocessable",
        message: `a persona has no key "${field}"; ${carries}`,
      });
    }

    // Nothing landed: the name is still the one it was created with.
    const still = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(still).name).toBe("Shapely Sam");
  });

  it("accepts only speaking speeds that can reach the simulator", async () => {
    api = await createApi("personas_speed_range");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    for (const speed of [SPEED_RANGE.slowest, SPEED_RANGE.fastest]) {
      const made = await browse("POST", "/v1/personas", ada, {
        projectId: ada.projectId,
        name: `Speed ${speed}`,
        ...BEHAVIOR,
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
        ...BEHAVIOR,
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

  it("keeps reasoning policy out of persona writes", async () => {
    api = await createApi("personas_reasoning_off");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const terra = {
      ...RECOMMENDED_PERSONA_MODELS,
      llm: { provider: "openai", model: "gpt-5.6-terra" },
    };

    const made = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "No-thinking Nina",
      ...BEHAVIOR,
      models: terra,
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    expect(personaIn(made).models.llm).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
    });

    const refused = await browse("POST", "/v1/personas", ada, {
      projectId: ada.projectId,
      name: "Thinking-on Tom",
      ...BEHAVIOR,
      models: {
        ...terra,
        llm: { ...terra.llm, reasoningEffort: "high" },
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toMatch(
      /unsupported fields reasoningEffort/i,
    );
  });

  it("shows Egma's Predefined persona in every project's list, read-only", async () => {
    api = await createApi("personas_predefined_visible");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const listed = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}`,
      ada,
    );
    const items = listed.body.personas as WirePersona[];
    const found = items.find((one) => one.id === PREDEFINED_PERSONA);

    expect(found).toMatchObject({
      name: "Everyday caller",
      description: "Regular conversationalist persona",
      version: 1,
      owner: "egma",
      // Catalog content, and the whole point of it: nobody ever hears
      // "Hi, I'm Everyday caller."
      identityName: "Alex Morgan",
      personality:
        "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
      language: "en-US",
      models: {
        ...RECOMMENDED_PERSONA_MODELS,
        llm: {
          provider: "openai",
          model: "gpt-5.6-terra",
        },
      },
    });

    const refused = await browse(
      "PATCH",
      `/v1/personas/${PREDEFINED_PERSONA}`,
      ada,
      {
        projectId: ada.projectId,
        name: "The one everybody starts with",
      },
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual(predefinedRefusal(PREDEFINED_PERSONA));
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
    // "Two" was deleted, and the Predefined persona carries no `o` in its
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

  /**
   * **There is no archived list, and asking for one is refused.**
   *
   * A deleted persona is gone as far as anybody authoring is concerned. A
   * request still asking `?archived=true` is a client that believes in a second
   * list; answering it with the live one would show somebody the opposite of
   * what they asked for and call it success.
   */
  it("refuses the retired archived flag rather than answering the live list", async () => {
    api = await createApi("personas_no_archived_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await browse(
      "GET",
      `/v1/personas?projectId=${ada.projectId}&archived=true`,
      ada,
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "unprocessable",
      message:
        'the persona query has no key "archived"; this query carries ' +
        "projectId, pageToken, search. A deleted persona leaves every list " +
        "for good, so there is no archived list to ask for.",
    });
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

describe("editing a persona", () => {
  it("writes name and description in place, minting no version", async () => {
    api = await createApi("personas_rename");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Renamed Rowan");

    const renamed = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      name: "Rowan",
      description: "Somebody who calls about a bill.",
    });

    expect(renamed.statusCode).toBe(200);
    const now = personaIn(renamed);
    expect(now.name).toBe("Rowan");
    expect(now.description).toBe("Somebody who calls about a bill.");
    expect(now.version).toBe(1);
    expect(now.versionId).toBe(made.versionId);
    // The name the agent hears did not move because the label on the shelf did.
    expect(now.identityName).toBe(made.identityName);
  });

  it("mints a version for each changed behavior field, and nothing for an identical save", async () => {
    api = await createApi("personas_version");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Versioned Vera");

    const changed = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      personality: "Vera, after a long wait.",
    });
    expect(changed.statusCode).toBe(200);
    expect(personaIn(changed).version).toBe(2);
    expect(personaIn(changed).personality).toBe("Vera, after a long wait.");

    // The name the agent hears is versioned exactly like the personality is.
    const renamedIdentity = await browse(
      "PATCH",
      `/v1/personas/${made.id}`,
      ada,
      { projectId: ada.projectId, identityName: "Vera Lindqvist" },
    );
    expect(renamedIdentity.statusCode).toBe(200);
    expect(personaIn(renamedIdentity).version).toBe(3);
    expect(personaIn(renamedIdentity).identityName).toBe("Vera Lindqvist");

    const identical = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      identityName: "Vera Lindqvist",
      personality: "Vera, after a long wait.",
      language: made.language,
    });
    expect(identical.statusCode).toBe(200);
    expect(personaIn(identical).version).toBe(3);
    expect(personaIn(identical).versionId).toBe(
      personaIn(renamedIdentity).versionId,
    );

    const history = await browse(
      "GET",
      `/v1/personas/${made.id}/versions?projectId=${ada.projectId}`,
      ada,
    );
    expect(
      (history.body.versions as { version: number }[]).map((v) => v.version),
    ).toEqual([3, 2, 1]);
    // Every frozen version answers with the person it pinned, flat.
    expect(history.body.versions).toMatchObject([
      { version: 3, identityName: "Vera Lindqvist" },
      { version: 2, identityName: BEHAVIOR.identityName },
      { version: 1, identityName: BEHAVIOR.identityName },
    ]);
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
      { version: 2, ...BEHAVIOR, models },
      { version: 1, ...BEHAVIOR, models: RECOMMENDED_PERSONA_MODELS },
    ]);
  });

  /**
   * **Last write wins, and nothing is asked for to prove it.**
   *
   * The revision token and the expected version id are gone from this door.
   * Two edits sent one after the other both land, and the second one is what
   * the persona says afterwards — the clobber risk this effort accepted
   * knowingly, asserted so that nobody re-adds a guard by accident.
   */
  it("takes a second edit written against what the first one replaced", async () => {
    api = await createApi("personas_last_write_wins");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Contested Cora");

    const once = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      name: "Cora, renamed once",
    });
    expect(once.statusCode).toBe(200);

    // The second tab, holding the persona exactly as it read before that.
    const twice = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      name: "Cora, renamed twice",
    });
    expect(twice.statusCode).toBe(200);

    const now = await browse(
      "GET",
      `/v1/personas/${made.id}?projectId=${ada.projectId}`,
      ada,
    );
    expect(personaIn(now).name).toBe("Cora, renamed twice");
  });
});

describe("forking a persona", () => {
  it("makes an editable project persona from the current definition, with no history", async () => {
    api = await createApi("personas_fork");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = personaIn(
      await browse(
        "GET",
        `/v1/personas/${PREDEFINED_PERSONA}?projectId=${ada.projectId}`,
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
    expect(fork.identityName).toBe(made.identityName);
    expect(fork.personality).toBe(made.personality);
    expect(fork.language).toBe(made.language);
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

  it("says the same thing about a persona nobody here has", async () => {
    api = await createApi("personas_delete_absent");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const nobody = newId("prs");

    const refused = await browse(
      "DELETE",
      `/v1/personas/${nobody}?projectId=${ada.projectId}`,
      ada,
    );
    expect(refused.statusCode).toBe(404);
    expect(refused.body).toEqual({
      error: "not_found",
      message:
        `There is no persona ${nobody} available in this project. Check the ` +
        "link, or choose it from the current project.",
    });
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
      "POST" | "PATCH" | "DELETE",
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
        "PATCH",
        `/v1/personas/${made.id}`,
        { projectId: ada.projectId, name: "Nope" },
        "edit personas",
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
  it("reads one older version on its own, and says what uses the persona now", async () => {
    api = await createApi("personas_history_usage");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const made = await createPersonaThrough(ada, "Historic Hana");

    const moved = await browse("PATCH", `/v1/personas/${made.id}`, ada, {
      projectId: ada.projectId,
      personality: "Hana has waited too long and is now blunt.",
    });
    // The persona really moved on, so reading version 1 below is reading
    // something the persona has left behind rather than where they still are.
    // Without this the whole test would pass if editing stopped minting.
    expect(moved.statusCode).toBe(200);
    expect(personaIn(moved).version).toBe(2);
    expect(personaIn(moved).versionId).not.toBe(made.versionId);

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
