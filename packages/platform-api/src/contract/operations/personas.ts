import { graderSettingDefinitionSchema } from "./grader-shapes.ts";
import { defineOperation } from "../definition.ts";
import {
  arrayOf,
  dateTimeSchema,
  nullable,
  parameters,
  rateLimitResponse,
  refusalResponse,
  stringIdSchema,
} from "../schemas.ts";

const personaParams = parameters({ personaId: stringIdSchema }, ["personaId"]);
const versionParams = parameters({ versionId: stringIdSchema }, ["versionId"]);

const projectQuery = parameters({ projectId: stringIdSchema });
const capabilityQuery = parameters({
  projectId: stringIdSchema,
  ttsProvider: { type: "string" }, ttsModel: { type: "string" },
  sttProvider: { type: "string" }, sttModel: { type: "string" },
  language: { type: "string" }, voiceId: { type: "string" }, refresh: { type: "boolean" },
}, ["ttsProvider", "ttsModel", "sttProvider", "sttModel"]);
const personaListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  search: { type: "string" },
});
const versionListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
});

/**
 * The authored person, flat — the same three values the work-order contract
 * carries and the version row stores in typed columns.
 *
 * `identityName` is the human name the persona gives the agent and is spoken on
 * every call; the identity row's `name` beside it is the team's own label for
 * the library entry and is never spoken. Technical voice settings are not
 * authored behavior and live only under `models.tts`.
 */
const behavior = {
  identityName: {
    type: "string",
    description: "The human name the caller gives the agent, separate from the library name.",
  },
  personality: {
    type: "string",
    description: "How the caller behaves and speaks. Put the situation and goal in the test scenario.",
  },
  language: {
    ...nullable({ type: "string" }),
    description: "Historical core language. New persona versions use controls.language and return null here.",
  },
} as const;

const behaviorRequired = ["identityName", "personality", "language"] as const;

const modelSelection = {
  type: "object",
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
  },
  required: ["provider", "model"],
  additionalProperties: false,
} as const;

const speechSelection = {
  ...modelSelection,
  properties: {
    ...modelSelection.properties,
    voiceId: {
      type: "string",
      description: "A voice identifier supported by the selected text-to-speech provider.",
    },
    speed: {
      type: "number",
      description: "Provider-supported speech rate. Read the selected combination's capability range.",
    },
  },
  required: [...modelSelection.required, "voiceId", "speed"],
} as const;

const personaModels = {
  type: "object",
  description:
    "The complete language, speech recognition, and speech synthesis selections. Read /v1/persona-form for available choices and recommendations.",
  properties: {
    llm: modelSelection,
    stt: modelSelection,
    tts: speechSelection,
  },
  required: ["llm", "stt", "tts"],
  additionalProperties: false,
} as const;

const personaControls = {
  type: "object",
  properties: {
    language: { type: "string", minLength: 1 },
    emotion: { type: "string", enum: ["neutral", "happy", "angry", "frustrated", "sad", "anxious"] },
    accent: { type: "string", minLength: 1 },
    speechVolume: { type: "number", minimum: 0.5, maximum: 1.5 },
    executionPolicyVersion: { type: "integer", minimum: 1, readOnly: true },
    backgroundSoundId: { type: "string", enum: ["none", "office-v1", "cafe-v1", "street-traffic-v1", "crowd-talking-v1", "inside-car-v1", "home-tv-v1", "wind-v1", "rain-v1"] },
    backgroundVolume: { type: "number", minimum: 0.015848931924611134, maximum: 0.251188643150958 },
    interruptionLevel: { type: "string", enum: ["off", "occasional", "frequent"] },
  },
  required: ["language", "emotion", "accent", "speechVolume", "executionPolicyVersion", "backgroundSoundId", "backgroundVolume", "interruptionLevel"],
  additionalProperties: false,
} as const;

const personaControlsInput = {
  type: "object",
  properties: {
    language: personaControls.properties.language,
    emotion: personaControls.properties.emotion,
    accent: personaControls.properties.accent,
    speechVolume: personaControls.properties.speechVolume,
    backgroundSoundId: personaControls.properties.backgroundSoundId,
    backgroundVolume: personaControls.properties.backgroundVolume,
    interruptionLevel: personaControls.properties.interruptionLevel,
  },
  required: ["language", "emotion", "accent", "speechVolume", "backgroundSoundId", "backgroundVolume", "interruptionLevel"],
  additionalProperties: false,
} as const;

const parameterContract = arrayOf(graderSettingDefinitionSchema);

const projectPersonaSettings = {
  type: "object", properties: { id: stringIdSchema, models: personaModels, controls: personaControls, createdAt: dateTimeSchema, updatedAt: dateTimeSchema },
  required: ["id", "models", "controls", "createdAt", "updatedAt"], additionalProperties: false,
} as const;

const persona = {
  type: "object",
  properties: {
    id: stringIdSchema,
    projectId: nullable(stringIdSchema),
    name: { type: "string" },
    description: nullable({ type: "string" }),
    version: { type: "integer", minimum: 1 },
    versionId: stringIdSchema,
    ...behavior,
    parameterContract,
    settings: {
      ...nullable(projectPersonaSettings),
      description: "This project's saved model and voice settings. Null before first use. Settings changes do not create a behavior version.",
    },
    owner: { type: "string", enum: ["egma", "organization"] },
    archivedAt: nullable(dateTimeSchema),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
  required: [
    "id",
    "projectId",
    "name",
    "description",
    "version",
    "versionId",
    ...behaviorRequired,
    "parameterContract",
    "settings",
    "owner",
    "archivedAt",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const personaVersion = {
  type: "object",
  properties: {
    id: stringIdSchema,
    personaId: stringIdSchema,
    version: { type: "integer", minimum: 1 },
    ...behavior,
    parameterContract,
    createdAt: dateTimeSchema,
  },
  required: [
    "id",
    "personaId",
    "version",
    ...behaviorRequired,
    "parameterContract",
    "createdAt",
  ],
  additionalProperties: false,
} as const;

const personaList = {
  type: "object",
  properties: {
    personas: arrayOf(persona),
    nextPageToken: nullable(stringIdSchema),
  },
  required: ["personas", "nextPageToken"],
  additionalProperties: false,
} as const;

const versionList = {
  type: "object",
  properties: {
    versions: arrayOf(personaVersion),
    nextPageToken: nullable(stringIdSchema),
  },
  required: ["versions", "nextPageToken"],
  additionalProperties: false,
} as const;

const modelCatalogEntry = {
  type: "object",
  properties: {
    provider: { type: "string" },
    job: { type: "string", enum: ["llm", "stt", "tts"] },
    model: { type: "string" },
    label: { type: "string" },
    modelLabel: { type: "string" },
    recommendedVoiceId: { type: "string" },
  },
  required: ["provider", "job", "model", "label"],
  additionalProperties: false,
} as const;

const personaForm = {
  type: "object",
  properties: {
    modelCatalog: arrayOf(modelCatalogEntry),
    recommendedModels: personaModels,
  },
  required: ["modelCatalog", "recommendedModels"],
  additionalProperties: false,
} as const;

const capabilityState = (choice: Readonly<Record<string, unknown>>) => ({
  type: "object",
  properties: {
    status: { type: "string", enum: ["supported", "fixed", "unsupported", "unknown"] },
    reason: { type: "string" }, choices: arrayOf(choice), value: choice,
    range: { type: "object", properties: { minimum: { type: "number" }, maximum: { type: "number" }, step: { type: "number" } }, required: ["minimum", "maximum", "step"], additionalProperties: false },
  },
  required: ["status"], additionalProperties: false,
}) as const;

const voiceChoice = {
  type: "object", properties: {
    id: { type: "string" }, name: { type: "string" },
    source: { type: "string", enum: ["standard", "account"] },
    presentation: { type: "string", enum: ["male", "female", "neutral", "unknown"] },
    languages: arrayOf({ type: "string" }), accents: arrayOf({ type: "string" }),
  }, required: ["id", "name", "source", "presentation", "languages", "accents"], additionalProperties: false,
} as const;

const personaCapabilities = {
  type: "object", properties: {
    voices: capabilityState(voiceChoice), language: capabilityState({ type: "string" }),
    accent: capabilityState({ type: "string" }), emotion: capabilityState({ type: "string" }),
    speed: capabilityState({ type: "number" }), speechVolume: capabilityState({ type: "number" }),
  }, required: ["voices", "language", "accent", "emotion", "speed", "speechVolume"], additionalProperties: false,
} as const;

const namedTest = {
  type: "object",
  properties: {
    id: stringIdSchema,
    name: { type: "string" },
  },
  required: ["id", "name"],
  additionalProperties: false,
} as const;

const personaUsage = {
  type: "object",
  properties: { tests: arrayOf(namedTest) },
  required: ["tests"],
  additionalProperties: false,
} as const;

const createPersonaBody = {
  type: "object",
  properties: {
    projectId: stringIdSchema,
    name: {
      type: "string",
      description: "Your team's label in the persona library. The caller does not speak this label.",
    },
    description: { type: "string" },
    identityName: behavior.identityName,
    personality: behavior.personality,
    models: personaModels,
    controls: personaControlsInput,
  },
  required: ["name", "identityName", "personality"],
  additionalProperties: false,
  examples: [{
    name: "Caller in a hurry",
    description: "A caller who wants a brief appointment booking conversation.",
    identityName: "Morgan Chen",
    personality:
      "Answers briefly, asks for the earliest appointment, and stays polite when asking the agent to get to the point.",
    models: {
      llm: { provider: "openai", model: "gpt-4o-mini" },
      stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
      tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", speed: 1 },
    },
  }],
} as const;

/**
 * Partial persona update. Behavior edits require expectedVersionId in the
 * access layer; omitted fields retain their current values. Metadata and
 * project settings do not create a behavior version.
 */
const updatePersonaBody = {
  type: "object",
  properties: {
    ...createPersonaBody.properties,
    description: nullable({ type: "string" }),
    expectedVersionId: {
      ...stringIdSchema,
      description: "The current versionId from Get a persona. Required when editing identityName or personality. A stale value returns 409 version_conflict.",
    },
  },
  additionalProperties: false,
} as const;

const projectBody = {
  type: "object",
  properties: { projectId: stringIdSchema },
  additionalProperties: false,
} as const;

const readRefusals = {
  400: refusalResponse,
  401: refusalResponse,
  403: refusalResponse,
  404: refusalResponse,
  422: refusalResponse,
  429: rateLimitResponse,
} as const;

const writeRefusals = {
  ...readRefusals,
  409: refusalResponse,
} as const;

export const personaOperations = {
  usePersona: defineOperation({
    operationId: "usePersona", method: "POST", path: "/v1/personas/{personaId}/use", summary: "Use a persona", tag: "Personas", security: "credentialed",
    description: "Save this project's first model settings for the persona. Omit models to use its declared defaults. Repeated use returns the existing settings; use Update a persona to change them.",
    request: { params: personaParams, body: { type: "object", properties: { projectId: stringIdSchema, models: personaModels, controls: personaControlsInput }, additionalProperties: false }, bodyRequired: false },
    responses: { 200: { description: "The persona with its saved project settings.", schema: persona }, ...writeRefusals },
  }),
  listPersonas: defineOperation({
    operationId: "listPersonas",
    method: "GET",
    path: "/v1/personas",
    summary: "List personas",
    tag: "Personas",
    security: "credentialed",
    request: { query: personaListQuery },
    responses: {
      200: { description: "A page of personas.", schema: personaList },
      ...readRefusals,
    },
  }),

  getPersonaForm: defineOperation({
    operationId: "getPersonaForm",
    method: "GET",
    path: "/v1/persona-form",
    summary: "Get persona authoring choices",
    description:
      "Use this response to choose supported models, a recommended voice, and a valid speech rate before creating or updating a persona.",
    tag: "Personas",
    security: "credentialed",
    request: { query: projectQuery },
    responses: {
      200: { description: "The supported persona model choices.", schema: personaForm },
      ...readRefusals,
    },
  }),

  getPersonaCapabilities: defineOperation({
    operationId: "getPersonaCapabilities", method: "GET", path: "/v1/persona-capabilities",
    summary: "Resolve persona capabilities", tag: "Personas", security: "credentialed",
    description: "Resolve the selected provider, model, voice, and language combination. Status and reason values are authoritative for authoring and voice execution.",
    request: { query: capabilityQuery },
    responses: { 200: { description: "Capabilities for the selected combination.", schema: personaCapabilities }, ...readRefusals },
  }),

  getPersona: defineOperation({
    operationId: "getPersona",
    method: "GET",
    path: "/v1/personas/{personaId}",
    summary: "Get a persona",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, query: projectQuery },
    responses: {
      200: { description: "The persona.", schema: persona },
      ...readRefusals,
    },
  }),

  listPersonaVersions: defineOperation({
    operationId: "listPersonaVersions",
    method: "GET",
    path: "/v1/personas/{personaId}/versions",
    summary: "List persona versions",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, query: versionListQuery },
    responses: {
      200: { description: "A page of frozen persona versions.", schema: versionList },
      ...readRefusals,
    },
  }),

  getPersonaUsage: defineOperation({
    operationId: "getPersonaUsage",
    method: "GET",
    path: "/v1/personas/{personaId}/usage",
    summary: "Get a persona's test usage",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, query: projectQuery },
    responses: {
      200: { description: "The active tests that use the persona.", schema: personaUsage },
      ...readRefusals,
    },
  }),

  getPersonaVersion: defineOperation({
    operationId: "getPersonaVersion",
    method: "GET",
    path: "/v1/persona-versions/{versionId}",
    summary: "Get a persona version",
    tag: "Personas",
    security: "credentialed",
    request: { params: versionParams, query: projectQuery },
    responses: {
      200: { description: "The frozen persona version.", schema: personaVersion },
      ...readRefusals,
    },
  }),

  createPersona: defineOperation({
    operationId: "createPersona",
    method: "POST",
    path: "/v1/personas",
    summary: "Create a persona",
    description:
      "Create a project-owned persona with its first behavior version and complete model settings. Omit models to use the declared defaults. Add its ID or unambiguous name to a test to use it.",
    tag: "Personas",
    security: "credentialed",
    request: { body: createPersonaBody },
    responses: {
      201: { description: "The new persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  updatePersona: defineOperation({
    operationId: "updatePersona",
    method: "PATCH",
    path: "/v1/personas/{personaId}",
    summary: "Update a persona",
    description:
      "Change project model settings or the current custom behavior. Behavior edits require expectedVersionId and create a version when changed. Model settings and display labels create no version. Egma-owned behavior is read-only; its project settings are editable.",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: updatePersonaBody },
    responses: {
      200: { description: "The updated persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  forkPersona: defineOperation({
    operationId: "forkPersona",
    method: "POST",
    path: "/v1/personas/{personaId}/fork",
    summary: "Clone a persona",
    description:
      "Creates an editable custom copy of the persona's current behavior and model settings. The original persona and tests that select it stay unchanged.",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: projectBody, bodyRequired: false },
    responses: {
      201: { description: "The new custom persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  /**
   * One Delete, and no way back.
   *
   * The persona leaves every list and picker for good. Underneath, the row is
   * stamped rather than removed, so every version stays readable and a
   * simulation that pinned one still reads true — but nothing on this API
   * offers a restore, a deleted list, or a successor to nominate.
   */
  deletePersona: defineOperation({
    operationId: "deletePersona",
    method: "DELETE",
    path: "/v1/personas/{personaId}",
    summary: "Permanently delete a persona from authoring",
    description:
      "The persona leaves every authoring list and picker permanently. " +
      "Existing run evidence stays readable.",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, query: projectQuery },
    responses: {
      204: { description: "The persona was deleted." },
      ...writeRefusals,
    },
  }),
} as const;
