import {
  createProject,
  createTestSuite,
  EGMA_PROVIDED_PERSONAS,
  RECOMMENDED_PERSONA_MODELS,
} from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, signUp, type Customer } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => {
  await api?.close();
});

const DEFAULT_CONTROLS = {
  language: "en-US",
  emotion: "neutral",
  accent: "voice_default",
  speechVolume: 1,
  backgroundSoundId: "none",
  backgroundVolume: 0.0631,
  interruptionLevel: "off",
} as const;

async function request(
  who: Customer,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: object,
) {
  return api.app.inject({
    method,
    url,
    headers: { cookie: who.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

it("saves independent shared-persona settings, clones current behavior, and rejects stale core edits", async () => {
  api = await createApi("persona_project_settings");
  const who = await signUp(api.app, "personas@project.example", "Personas");
  const other = await createProject(contextFor(who, "admin"), {
    name: "Other",
  });
  const personaId = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const first = await request(who, "POST", `/v1/personas/${personaId}/use`, {
    projectId: who.projectId,
  });
  expect(first.statusCode, first.body).toBe(200);
  const saved = first.json();
  expect(saved.settings.models.tts.voiceId).toBeTruthy();
  const models = {
    ...RECOMMENDED_PERSONA_MODELS,
    tts: {
      ...RECOMMENDED_PERSONA_MODELS.tts,
      voiceId: "coral",
      speed: 0.85,
    },
  };
  const usedAgain = await request(
    who,
    "POST",
    `/v1/personas/${personaId}/use`,
    { projectId: who.projectId },
  );
  expect(usedAgain.json().settings.id).toBe(saved.settings.id);
  const second = await request(who, "POST", `/v1/personas/${personaId}/use`, {
    projectId: other.id,
    models,
  });
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().settings.models).toEqual(models);
  const firstRead = await request(
    who,
    "GET",
    `/v1/personas/${personaId}?projectId=${who.projectId}`,
  );
  expect(firstRead.json().settings.models).toEqual(saved.settings.models);

  const clone = await request(who, "POST", `/v1/personas/${personaId}/fork`, {
    projectId: other.id,
  });
  expect(clone.statusCode, clone.body).toBe(201);
  const custom = clone.json();
  expect(custom.settings.models).toEqual(models);
  const moved = await request(who, "PATCH", `/v1/personas/${custom.id}`, {
    projectId: other.id,
    expectedVersionId: custom.versionId,
    personality: "Asks one question, then waits.",
  });
  expect(moved.statusCode, moved.body).toBe(200);
  expect(moved.json().version).toBe(2);
  const settingsOnly = await request(
    who,
    "PATCH",
    `/v1/personas/${custom.id}`,
    { projectId: other.id, models: RECOMMENDED_PERSONA_MODELS },
  );
  expect(settingsOnly.statusCode, settingsOnly.body).toBe(200);
  expect(settingsOnly.json().version).toBe(2);
  const stale = await request(who, "PATCH", `/v1/personas/${custom.id}`, {
    projectId: other.id,
    expectedVersionId: custom.versionId,
    personality: custom.personality,
  });
  expect(stale.statusCode).toBe(409);
  const unguarded = await request(who, "PATCH", `/v1/personas/${custom.id}`, {
    projectId: other.id,
    personality: custom.personality,
  });
  expect(unguarded.statusCode).toBe(422);
  const history = await request(
    who,
    "GET",
    `/v1/personas/${custom.id}/versions?projectId=${other.id}`,
  );
  expect(history.json().versions).toHaveLength(2);
  expect(history.json().versions[1]).not.toHaveProperty("models");
  expect(history.json().versions[1]).not.toHaveProperty("settings");
  const foreign = await request(
    who,
    "GET",
    `/v1/personas/${custom.id}?projectId=${who.projectId}`,
  );
  expect(foreign.statusCode).toBe(404);
});

it("rejects incomplete, unknown and invalid settings without creating a partial persona", async () => {
  api = await createApi("persona_invalid_settings");
  const who = await signUp(
    api.app,
    "invalid@personas.example",
    "Invalid personas",
  );
  const fields = {
    projectId: who.projectId,
    name: "Unwritten",
    identityName: "Nora",
    personality: "Patient",
    controls: DEFAULT_CONTROLS,
  };
  for (const models of [{ llm: { provider: "openai" } }, { extra: true }]) {
    const rejected = await request(who, "POST", "/v1/personas", {
      ...fields,
      models,
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
  }
  const badVoice = await request(who, "POST", "/v1/personas", {
    ...fields,
    models: {
      ...RECOMMENDED_PERSONA_MODELS,
      tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: " " },
    },
  });
  expect(badVoice.statusCode).toBe(422);
  const listed = await request(
    who,
    "GET",
    `/v1/personas?projectId=${who.projectId}`,
  );
  expect(
    listed.json().personas.map((one: { name: string }) => one.name),
  ).not.toContain("Unwritten");
});

it("serializes first use and current core edits without duplicate settings or lost behavior", async () => {
  api = await createApi("persona_concurrent_settings");
  const who = await signUp(
    api.app,
    "concurrent@personas.example",
    "Concurrent personas",
  );
  const shared = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const uses = await Promise.all(
    ["alloy", "coral", "echo"].map((voiceId) =>
      request(who, "POST", `/v1/personas/${shared}/use`, {
        projectId: who.projectId,
        models: {
          ...RECOMMENDED_PERSONA_MODELS,
          tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId },
        },
      }),
    ),
  );
  for (const used of uses) expect(used.statusCode, used.body).toBe(200);
  const selections = uses.map((used) => used.json().settings);
  expect(new Set(selections.map((settings) => settings.id)).size).toBe(1);
  expect(
    new Set(selections.map((settings) => settings.models.tts.voiceId)).size,
  ).toBe(1);
  const clone = await request(who, "POST", `/v1/personas/${shared}/fork`, {
    projectId: who.projectId,
  });
  const original = clone.json();
  const edits = await Promise.all(
    ["Patient and quiet.", "Firm and direct."].map((personality) =>
      request(who, "PATCH", `/v1/personas/${original.id}`, {
        projectId: who.projectId,
        expectedVersionId: original.versionId,
        personality,
      }),
    ),
  );
  expect(edits.map((edit) => edit.statusCode).sort()).toEqual([200, 409]);
  const history = await request(
    who,
    "GET",
    `/v1/personas/${original.id}/versions?projectId=${who.projectId}`,
  );
  expect(history.json().versions).toHaveLength(2);
  expect(history.json().versions[0].personality).toBe(
    edits.find((edit) => edit.statusCode === 200)?.json().personality,
  );
});

it("refuses another project's custom persona at every write and history door", async () => {
  api = await createApi("persona_settings_ownership");
  const who = await signUp(api.app, "owner@personas.example", "Owners");
  const stranger = await signUp(
    api.app,
    "stranger@personas.example",
    "Strangers",
  );
  const other = await createProject(contextFor(who, "admin"), {
    name: "Other project",
  });
  const created = await request(who, "POST", "/v1/personas", {
    projectId: who.projectId,
    name: "Private Nora",
    identityName: "Nora",
    personality: "Patient and clear.",
    models: RECOMMENDED_PERSONA_MODELS,
    controls: DEFAULT_CONTROLS,
  });
  expect(created.statusCode, created.body).toBe(201);
  const persona = created.json();
  for (const [reader, projectId] of [
    [who, other.id],
    [stranger, stranger.projectId],
  ] as const) {
    for (const path of [
      `/v1/personas/${persona.id}`,
      `/v1/personas/${persona.id}/versions`,
      `/v1/persona-versions/${persona.versionId}`,
    ]) {
      const refused = await request(
        reader,
        "GET",
        `${path}?projectId=${projectId}`,
      );
      expect(refused.statusCode, refused.body).toBe(404);
    }
    for (const suffix of ["use", "fork"]) {
      const refused = await request(
        reader,
        "POST",
        `/v1/personas/${persona.id}/${suffix}`,
        { projectId },
      );
      expect(refused.statusCode, refused.body).toBe(404);
    }
    const edit = await request(reader, "PATCH", `/v1/personas/${persona.id}`, {
      projectId,
      models: RECOMMENDED_PERSONA_MODELS,
    });
    expect(edit.statusCode, edit.body).toBe(404);
    const suite = await createTestSuite(
      { ...contextFor(reader, "admin"), projectId },
      { name: "Own suite" },
    );
    const selection = await request(reader, "POST", "/v1/tests", {
      projectId,
      suiteId: suite.id,
      name: "Foreign caller",
      scenario: "Asks for a time.",
      expectedBehaviors: ["Answers the time."],
      personas: [persona.id],
    });
    expect(selection.statusCode, selection.body).toBe(422);
  }
  const crossOrganization = await request(
    stranger,
    "POST",
    `/v1/personas/${EGMA_PROVIDED_PERSONAS.defaultPersona}/use`,
    { projectId: who.projectId },
  );
  expect(crossOrganization.statusCode).toBe(404);
  const original = await request(
    who,
    "GET",
    `/v1/personas/${persona.id}?projectId=${who.projectId}`,
  );
  expect(original.json()).toEqual(persona);
});

it("refuses invalid settings saves before changing any current project values", async () => {
  api = await createApi("persona_settings_invalid_save");
  const who = await signUp(api.app, "save@personas.example", "Settings saves");
  const id = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const used = await request(who, "POST", `/v1/personas/${id}/use`, {
    projectId: who.projectId,
  });
  const settings = used.json().settings;
  const invalid = [
    { llm: RECOMMENDED_PERSONA_MODELS.llm },
    { ...RECOMMENDED_PERSONA_MODELS, extra: true },
    {
      ...RECOMMENDED_PERSONA_MODELS,
      stt: { provider: "openai", model: "nova-3-general" },
    },
    { ...RECOMMENDED_PERSONA_MODELS, llm: { provider: 4, model: "gpt-4o" } },
    ...["1", 0.24, 4.01].map((speed) => ({
      ...RECOMMENDED_PERSONA_MODELS,
      tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed },
    })),
    {
      ...RECOMMENDED_PERSONA_MODELS,
      tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: " " },
    },
  ];
  for (const models of invalid) {
    const rejected = await request(who, "PATCH", `/v1/personas/${id}`, {
      projectId: who.projectId,
      models,
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
  }
  const read = await request(
    who,
    "GET",
    `/v1/personas/${id}?projectId=${who.projectId}`,
  );
  expect(read.json().settings).toEqual(settings);
  expect(read.json().versionId).toBe(used.json().versionId);
});
