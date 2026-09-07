import { createProject, EGMA_PROVIDED_PERSONAS, RECOMMENDED_PERSONA_MODELS } from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, signUp, type Customer } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

async function request(who: Customer, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
  return api.app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload === undefined ? {} : { payload }) });
}

it("saves independent shared-persona settings, clones current behavior, and rejects stale core edits", async () => {
  api = await createApi("persona_project_settings");
  const who = await signUp(api.app, "personas@project.example", "Personas");
  const other = await createProject(contextFor(who, "admin"), { name: "Other" });
  const personaId = EGMA_PROVIDED_PERSONAS.defaultPersona;
  const first = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: who.projectId });
  expect(first.statusCode, first.body).toBe(200);
  const saved = first.json();
  expect(saved.settings.models.tts.voiceId).toBeTruthy();
  const models = { ...RECOMMENDED_PERSONA_MODELS, tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: "my-private-provider-voice", speed: 0.85 } };
  const usedAgain = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: who.projectId });
  expect(usedAgain.json().settings.id).toBe(saved.settings.id);
  const second = await request(who, "POST", `/v1/personas/${personaId}/use`, { projectId: other.id, models });
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().settings.models).toEqual(models);
  const firstRead = await request(who, "GET", `/v1/personas/${personaId}?projectId=${who.projectId}`);
  expect(firstRead.json().settings.models).toEqual(saved.settings.models);

  const clone = await request(who, "POST", `/v1/personas/${personaId}/fork`, { projectId: other.id });
  expect(clone.statusCode, clone.body).toBe(201);
  const custom = clone.json();
  expect(custom.settings.models).toEqual(models);
  const moved = await request(who, "PATCH", `/v1/personas/${custom.id}`, { projectId: other.id, expectedVersionId: custom.versionId, personality: "Asks one question, then waits." });
  expect(moved.statusCode, moved.body).toBe(200);
  expect(moved.json().version).toBe(2);
  const settingsOnly = await request(who, "PATCH", `/v1/personas/${custom.id}`, { projectId: other.id, models: RECOMMENDED_PERSONA_MODELS });
  expect(settingsOnly.statusCode, settingsOnly.body).toBe(200);
  expect(settingsOnly.json().version).toBe(2);
  const stale = await request(who, "PATCH", `/v1/personas/${custom.id}`, { projectId: other.id, expectedVersionId: custom.versionId, personality: custom.personality });
  expect(stale.statusCode).toBe(409);
  const unguarded = await request(who, "PATCH", `/v1/personas/${custom.id}`, { projectId: other.id, personality: custom.personality });
  expect(unguarded.statusCode).toBe(422);
  const history = await request(who, "GET", `/v1/personas/${custom.id}/versions?projectId=${other.id}`);
  expect(history.json().versions).toHaveLength(2);
  expect(history.json().versions[1]).not.toHaveProperty("models");
  expect(history.json().versions[1]).not.toHaveProperty("settings");
  const foreign = await request(who, "GET", `/v1/personas/${custom.id}?projectId=${who.projectId}`);
  expect(foreign.statusCode).toBe(404);
});

it("rejects incomplete, unknown and invalid settings without creating a partial persona", async () => {
  api = await createApi("persona_invalid_settings");
  const who = await signUp(api.app, "invalid@personas.example", "Invalid personas");
  const fields = { projectId: who.projectId, name: "Unwritten", identityName: "Nora", personality: "Patient", language: "en-US" };
  for (const models of [{ llm: { provider: "openai" } }, { extra: true }]) {
    const rejected = await request(who, "POST", "/v1/personas", { ...fields, models });
    expect(rejected.statusCode, rejected.body).toBe(422);
  }
  const badVoice = await request(who, "POST", "/v1/personas", { ...fields, models: { ...RECOMMENDED_PERSONA_MODELS, tts: { ...RECOMMENDED_PERSONA_MODELS.tts, voiceId: " " } } });
  expect(badVoice.statusCode).toBe(422);
  const listed = await request(who, "GET", `/v1/personas?projectId=${who.projectId}`);
  expect(listed.json().personas.map((one: { name: string }) => one.name)).not.toContain("Unwritten");
});
