import { newId } from "@egma/ids";
import {
  GRADER_DEFINITION_CATALOG,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  RECOMMENDED_PERSONA_MODELS,
  reconcileGraderCatalog,
  seedPersonaLibrary,
} from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { signUp } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

it("refuses a shared contract that cannot use saved project settings and keeps the earlier cores usable", async () => {
  api = await createApi("shared_contract_refusal");
  const who = await signUp(api.app, "shared-contract@example.test", "Shared contracts");
  const headers = { cookie: who.cookie };
  const grader = GRADER_DEFINITION_CATALOG.find((one) => one.id === PREDEFINED_GRADERS.responseLatency)!;
  const used = await api.app.inject({ method: "POST", url: `/v1/grader-library/${grader.id}/use?projectId=${who.projectId}`, headers, payload: {
    scope: { simulations: [{ kind: "all" }], production: null },
    settings: { maximum_response_time_ms: 2_500 }, passThreshold: 0.8,
  } });
  expect(used.statusCode, used.body).toBe(201);
  await expect(reconcileGraderCatalog([{
    ...grader,
    parameterContract: grader.parameterContract.map((field) => ({ ...field, defaultValue: 1_000, maximum: 1_000 })),
  }])).rejects.toThrow(/saved.*settings/i);
  const currentGrader = await api.app.inject({ method: "GET", url: `/v1/graders?projectId=${who.projectId}`, headers });
  expect(currentGrader.statusCode, currentGrader.body).toBe(200);
  expect(currentGrader.json().graders.find((one: { id: string }) => one.id === used.json().id)).toMatchObject({ settings: { maximum_response_time_ms: 2_500 }, passThreshold: 0.8 });

  const currentCore = await api.app.inject({ method: "GET", url: `/v1/grader-library/${grader.id}?projectId=${who.projectId}`, headers });
  expect(currentCore.statusCode, currentCore.body).toBe(200);
  expect(currentCore.json()).toMatchObject({ definitionVersion: 1, currentDefinitionVersion: 1 });

  const persona = PERSONA_LIBRARY_CATALOG[0]!;
  const version = persona.versions.at(-1)!;
  const usedPersona = await api.app.inject({ method: "POST", url: `/v1/personas/${persona.id}/use`, headers, payload: {
    projectId: who.projectId,
    models: { ...RECOMMENDED_PERSONA_MODELS, tts: { ...RECOMMENDED_PERSONA_MODELS.tts, speed: 0.85 } },
    controls: {
      language: "en-US", emotion: "neutral", accent: "voice_default",
      speechVolume: 0.85, backgroundSoundId: "none",
      backgroundVolume: 0.0631, interruptionLevel: "off",
    },
  } });
  expect(usedPersona.statusCode, usedPersona.body).toBe(200);
  await expect(seedPersonaLibrary([{
    ...persona,
    versions: [...persona.versions, {
      ...version, id: newId("prsv"), version: version.version + 1,
      parameterContract: version.parameterContract.map((field) => field.key === "speech_volume" ? { ...field, minimum: 0.9 } : field),
    }],
  }])).rejects.toThrow("Speech volume must be at least 0.9");
  const currentPersona = await api.app.inject({ method: "GET", url: `/v1/personas/${persona.id}?projectId=${who.projectId}`, headers });
  expect(currentPersona.statusCode, currentPersona.body).toBe(200);
  expect(currentPersona.json()).toMatchObject({ version: version.version, versionId: version.id, settings: { models: { tts: { speed: 0.85 } } } });
});

it("refuses changed parameter units without reinterpreting saved grader or persona values", async () => {
  api = await createApi("shared_parameter_units");
  const who = await signUp(api.app, "shared-units@example.test", "Shared units");
  const headers = { cookie: who.cookie };
  const grader = GRADER_DEFINITION_CATALOG.find((one) => one.id === PREDEFINED_GRADERS.responseLatency)!;
  const used = await api.app.inject({ method: "POST", url: `/v1/grader-library/${grader.id}/use?projectId=${who.projectId}`, headers, payload: {
    scope: { simulations: [{ kind: "all" }], production: null }, settings: { maximum_response_time_ms: 2_500 }, passThreshold: 0.8,
  } });
  expect(used.statusCode, used.body).toBe(201);
  await expect(reconcileGraderCatalog([{
    ...grader, parameterContract: grader.parameterContract.map((field) => ({ ...field, unit: "seconds" })),
  }])).rejects.toThrow(/unit.*milliseconds.*seconds/i);
  const graderCore = await api.app.inject({ method: "GET", url: `/v1/grader-library/${grader.id}?projectId=${who.projectId}`, headers });
  expect(graderCore.json()).toMatchObject({ definitionVersion: 1, currentDefinitionVersion: 1, settingDefinitions: [expect.objectContaining({ unit: "milliseconds" })] });
  const savedGraders = await api.app.inject({ method: "GET", url: `/v1/graders?projectId=${who.projectId}`, headers });
  expect(savedGraders.json().graders).toEqual(expect.arrayContaining([expect.objectContaining({ id: used.json().id, settings: { maximum_response_time_ms: 2_500 }, passThreshold: 0.8 })]));
  expect((await api.database.sql("select version from grader_definition_version where definition_id=$1 order by version", [grader.id])).rows).toEqual([{ version: 1 }]);

  const persona = PERSONA_LIBRARY_CATALOG[0]!;
  const current = persona.versions.at(-1)!;
  const usedPersona = await api.app.inject({ method: "POST", url: `/v1/personas/${persona.id}/use`, headers, payload: { projectId: who.projectId } });
  expect(usedPersona.statusCode, usedPersona.body).toBe(200);
  await expect(seedPersonaLibrary([{
    ...persona, versions: [...persona.versions, { ...current, id: newId("prsv"), version: current.version + 1,
      parameterContract: current.parameterContract.map((field) => field.key === "tts_speed" ? { ...field, unit: "seconds" } : field),
    }],
  }])).rejects.toThrow(/unit.*unitless.*seconds/i);
  const savedPersona = await api.app.inject({ method: "GET", url: `/v1/personas/${persona.id}?projectId=${who.projectId}`, headers });
  expect(savedPersona.json()).toMatchObject({ version: current.version, versionId: current.id, settings: usedPersona.json().settings });
  expect((await api.database.sql("select version from persona_definition_version where persona_id=$1 order by version", [persona.id])).rows).toEqual(
    persona.versions.map(({ version }) => ({ version })),
  );
});
