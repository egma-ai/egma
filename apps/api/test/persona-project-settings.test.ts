import { createProject, createTestSuite, EGMA_PROVIDED_PERSONAS, RECOMMENDED_PERSONA_MODELS } from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, signUp, type Customer } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

const CURRENT_MODELS = {
  mode: "separate",
  llm: RECOMMENDED_PERSONA_MODELS.llm,
  stt: RECOMMENDED_PERSONA_MODELS.stt,
  tts: { provider: RECOMMENDED_PERSONA_MODELS.tts.provider, model: RECOMMENDED_PERSONA_MODELS.tts.model, voiceId: RECOMMENDED_PERSONA_MODELS.tts.voiceId },
} as const;
const DEFAULT_CONTROLS = { language: "en-US", backgroundSoundId: "none", interruptionLevel: "none" } as const;

async function request(who: Customer, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  return api.app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload === undefined ? {} : { payload }) });
}

it("keeps shared personas read-only and applies complete overrides only to a clone", async () => {
  api = await createApi("persona_project_settings");
  const who = await signUp(api.app, "personas@project.example", "Personas");
  const other = await createProject(contextFor(who, "admin"), { name: "Other" });
  const personaId = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const first = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: who.projectId });
  expect(first.statusCode, first.body).toBe(200);
  const saved = first.json();
  expect(saved.settings.models.tts.voiceId).toBeTruthy();
  const usedAgain = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: who.projectId });
  expect(usedAgain.json().settings).toEqual(saved.settings);
  const otherUse = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: other.id });
  expect(otherUse.statusCode, otherUse.body).toBe(200);

  const models = { ...CURRENT_MODELS, tts: { ...CURRENT_MODELS.tts, voiceId: "coral" } };
  const controls = { language: "en-US", backgroundSoundId: "rain-v1", interruptionLevel: "occasional" } as const;
  const clone = await request(who, "POST", `/v1/personas/${personaId}/fork`, { projectId: other.id, personality: "Asks one question, then waits.", models, controls });
  expect(clone.statusCode, clone.body).toBe(201);
  expect(clone.json()).toMatchObject({ version: 1, personality: "Asks one question, then waits.", settings: { models, controls } });
  const source = await request(who, "GET", `/v1/personas/${personaId}?projectId=${other.id}`);
  expect(source.json().settings).toEqual(otherUse.json().settings);
  const edit = await request(who, "PATCH", `/v1/personas/${clone.json().id}`, { projectId: other.id, personality: "This route is retired." });
  expect(edit.statusCode).toBe(404);
  const history = await request(who, "GET", `/v1/personas/${clone.json().id}/versions?projectId=${other.id}`);
  expect(history.json().versions).toHaveLength(1);
  const foreign = await request(who, "GET", `/v1/personas/${clone.json().id}?projectId=${who.projectId}`);
  expect(foreign.statusCode).toBe(404);
});

it("rejects incomplete, unknown, and retired settings without creating a partial persona", async () => {
  api = await createApi("persona_invalid_settings");
  const who = await signUp(api.app, "invalid@personas.example", "Invalid personas");
  const fields = { projectId: who.projectId, name: "Unwritten", identityName: "Nora", personality: "Patient", controls: DEFAULT_CONTROLS };
  const invalidModels = [
    { llm: { provider: "openai" } },
    { extra: true },
    { ...CURRENT_MODELS, tts: { ...CURRENT_MODELS.tts, voiceId: " " } },
    { ...CURRENT_MODELS, tts: { ...CURRENT_MODELS.tts, speed: 1 } },
  ];
  for (const models of invalidModels) {
    const rejected = await request(who, "POST", "/v1/personas", { ...fields, models });
    expect(rejected.statusCode, rejected.body).toBe(422);
  }
  const listed = await request(who, "GET", `/v1/personas?projectId=${who.projectId}`);
  expect(listed.json().personas.map((one: { name: string }) => one.name)).not.toContain("Unwritten");
});

it("serializes first use and creates concurrent clones without changing the source", async () => {
  api = await createApi("persona_concurrent_settings");
  const who = await signUp(api.app, "concurrent@personas.example", "Concurrent personas");
  const shared = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const uses = await Promise.all(Array.from({ length: 3 }, () => request(who, "POST", `/v1/personas/${shared}/use`, { projectId: who.projectId })));
  for (const used of uses) expect(used.statusCode, used.body).toBe(200);
  const selections = uses.map((used) => used.json().settings);
  expect(new Set(selections.map((settings) => settings.id)).size).toBe(1);
  const personalities = ["Patient and quiet.", "Firm and direct."];
  const clones = await Promise.all(personalities.map((personality) => request(who, "POST", `/v1/personas/${shared}/fork`, { projectId: who.projectId, personality })));
  expect(clones.map((clone) => clone.statusCode)).toEqual([201, 201]);
  expect(new Set(clones.map((clone) => clone.json().id)).size).toBe(2);
  expect(clones.map((clone) => clone.json().personality).sort()).toEqual([...personalities].sort());
  const source = await request(who, "GET", `/v1/personas/${shared}?projectId=${who.projectId}`);
  expect(source.json().settings).toEqual(selections[0]);
});

it("refuses another project's custom persona at every read, clone, use, and selection door", async () => {
  api = await createApi("persona_settings_ownership");
  const who = await signUp(api.app, "owner@personas.example", "Owners");
  const stranger = await signUp(api.app, "stranger@personas.example", "Strangers");
  const other = await createProject(contextFor(who, "admin"), { name: "Other project" });
  const created = await request(who, "POST", "/v1/personas", { projectId: who.projectId, name: "Private Nora", identityName: "Nora", personality: "Patient and clear.", models: CURRENT_MODELS, controls: DEFAULT_CONTROLS });
  expect(created.statusCode, created.body).toBe(201);
  const persona = created.json();
  for (const [reader, projectId] of [[who, other.id], [stranger, stranger.projectId]] as const) {
    for (const path of [`/v1/personas/${persona.id}`, `/v1/personas/${persona.id}/versions`, `/v1/persona-versions/${persona.versionId}`]) {
      const refused = await request(reader, "GET", `${path}?projectId=${projectId}`);
      expect(refused.statusCode, refused.body).toBe(404);
    }
    for (const suffix of ["use", "fork"]) {
      const refused = await request(reader, "POST", `/v1/personas/${persona.id}/${suffix}`, { projectId });
      expect(refused.statusCode, refused.body).toBe(404);
    }
    const retiredEdit = await request(reader, "PATCH", `/v1/personas/${persona.id}`, { projectId, personality: "No edit" });
    expect(retiredEdit.statusCode).toBe(404);
    const suite = await createTestSuite({ ...contextFor(reader, "admin"), projectId }, { name: "Own suite" });
    const selection = await request(reader, "POST", "/v1/tests", { projectId, suiteId: suite.id, name: "Foreign caller", scenario: "Asks for a time.", expectedBehaviors: ["Answers the time."], personas: [persona.id] });
    expect(selection.statusCode, selection.body).toBe(422);
  }
  const crossOrganization = await request(stranger, "POST", `/v1/personas/${EGMA_PROVIDED_PERSONAS.defaultPersona}/use`, { projectId: who.projectId });
  expect(crossOrganization.statusCode).toBe(404);
  const original = await request(who, "GET", `/v1/personas/${persona.id}?projectId=${who.projectId}`);
  expect(original.json()).toEqual(persona);
});

it("rejects invalid clone overrides before changing the source persona", async () => {
  api = await createApi("persona_settings_invalid_clone");
  const who = await signUp(api.app, "save@personas.example", "Clone validation");
  const id = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const used = await request(who, "POST", `/v1/personas/${id}/use`, { projectId: who.projectId });
  const source = used.json();
  const invalid = [
    { models: CURRENT_MODELS },
    { controls: DEFAULT_CONTROLS },
    { models: { ...CURRENT_MODELS, tts: { ...CURRENT_MODELS.tts, speed: 1 } }, controls: DEFAULT_CONTROLS },
    { models: { ...CURRENT_MODELS, llm: { provider: 4, model: "gpt-4o" } }, controls: DEFAULT_CONTROLS },
    { models: { mode: "live", llm: CURRENT_MODELS.llm, live: { provider: "openai", model: "gpt-live-1", adapter: "openai_live", voiceId: "alloy" } }, controls: DEFAULT_CONTROLS },
  ];
  for (const overrides of invalid) {
    const rejected = await request(who, "POST", `/v1/personas/${id}/fork`, { projectId: who.projectId, ...overrides });
    expect(rejected.statusCode, rejected.body).toBe(422);
  }
  const read = await request(who, "GET", `/v1/personas/${id}?projectId=${who.projectId}`);
  expect(read.json()).toEqual(source);
});
