import { newId } from "@egma/ids";
import {
  GRADER_DEFINITION_CATALOG,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  reconcileGraderCatalog,
  seedPersonaLibrary,
} from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { signUp } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

it("publishes shared core changes without reinterpreting project-owned persona settings", async () => {
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
  } });
  expect(usedPersona.statusCode, usedPersona.body).toBe(200);
  const nextPersonaVersionId = newId("prsv");
  await expect(seedPersonaLibrary([{
    ...persona,
    versions: [...persona.versions, {
      ...version, id: nextPersonaVersionId, version: version.version + 1,
      parameterContract: version.parameterContract.map((field) => field.key === "background_sound_id" ? { ...field, defaultValue: "rain-v1" } : field),
    }],
  }])).resolves.toEqual([{ id: persona.id, name: persona.name, version: version.version + 1, versionId: nextPersonaVersionId }]);
  const currentPersona = await api.app.inject({ method: "GET", url: `/v1/personas/${persona.id}?projectId=${who.projectId}`, headers });
  expect(currentPersona.statusCode, currentPersona.body).toBe(200);
  expect(currentPersona.json()).toMatchObject({ version: version.version + 1, versionId: nextPersonaVersionId, settings: usedPersona.json().settings });
  expect(currentPersona.json().settings.models.tts).not.toHaveProperty("speed");
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
  const nextPersonaVersionId = newId("prsv");
  await expect(seedPersonaLibrary([{
    ...persona, versions: [...persona.versions, { ...current, id: nextPersonaVersionId, version: current.version + 1,
      parameterContract: current.parameterContract.map((field) => field.key === "background_sound_id" ? { ...field, unit: "sound_id" } : field),
    }],
  }])).rejects.toThrow(/unit/i);
  const savedPersona = await api.app.inject({ method: "GET", url: `/v1/personas/${persona.id}?projectId=${who.projectId}`, headers });
  expect(savedPersona.json()).toMatchObject({ version: current.version, versionId: current.id, settings: usedPersona.json().settings });
  expect((await api.database.sql("select version from persona_definition_version where persona_id=$1 order by version", [persona.id])).rows).toEqual(
    persona.versions.map(({ version }) => ({ version })),
  );
});
