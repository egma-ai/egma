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
const personaListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
  archived: { type: "string" },
  search: { type: "string" },
});
const versionListQuery = parameters({
  projectId: stringIdSchema,
  pageToken: stringIdSchema,
});

const traits = {
  type: "object",
  properties: {
    personality: { type: "string" },
    language: { type: "string" },
    accent: { type: "string" },
    backgroundNoise: { type: "string" },
  },
  required: ["personality", "language"],
  additionalProperties: false,
} as const;

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
    voiceId: { type: "string" },
    speed: { type: "number" },
  },
  required: [...modelSelection.required, "voiceId", "speed"],
} as const;

const personaModels = {
  type: "object",
  properties: {
    llm: modelSelection,
    stt: modelSelection,
    tts: speechSelection,
  },
  required: ["llm", "stt", "tts"],
  additionalProperties: false,
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
    traits,
    models: personaModels,
    owner: { type: "string", enum: ["egma", "organization"] },
    revision: stringIdSchema,
    archivedAt: nullable(dateTimeSchema),
    isDefault: { type: "boolean" },
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
    "traits",
    "models",
    "owner",
    "revision",
    "archivedAt",
    "isDefault",
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
    traits,
    models: personaModels,
    createdAt: dateTimeSchema,
  },
  required: ["id", "personaId", "version", "traits", "models", "createdAt"],
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
    speedRange: {
      type: "object",
      properties: {
        slowest: { type: "number" },
        fastest: { type: "number" },
      },
      required: ["slowest", "fastest"],
      additionalProperties: false,
    },
  },
  required: ["modelCatalog", "recommendedModels", "speedRange"],
  additionalProperties: false,
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
    name: { type: "string" },
    description: { type: "string" },
    traits,
    models: personaModels,
  },
  required: ["name", "traits", "models"],
  additionalProperties: false,
} as const;

const updatePersonaBody = {
  type: "object",
  properties: {
    ...createPersonaBody.properties,
    description: nullable({ type: "string" }),
    expectedRevision: stringIdSchema,
    expectedVersionId: stringIdSchema,
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const;

const projectBody = {
  type: "object",
  properties: { projectId: stringIdSchema },
  additionalProperties: false,
} as const;

const archivePersonaBody = {
  type: "object",
  properties: {
    projectId: stringIdSchema,
    expectedRevision: stringIdSchema,
    replacementPersonaId: stringIdSchema,
  },
  required: ["expectedRevision"],
  additionalProperties: false,
} as const;

const restorePersonaBody = {
  type: "object",
  properties: {
    projectId: stringIdSchema,
    expectedRevision: stringIdSchema,
  },
  required: ["expectedRevision"],
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
    tag: "Personas",
    security: "credentialed",
    request: { query: projectQuery },
    responses: {
      200: { description: "The supported persona model choices.", schema: personaForm },
      ...readRefusals,
    },
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
    summary: "Fork a persona",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: projectBody, bodyRequired: false },
    responses: {
      201: { description: "The new custom persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  setDefaultPersona: defineOperation({
    operationId: "setDefaultPersona",
    method: "POST",
    path: "/v1/personas/{personaId}/default",
    summary: "Set the project's default persona",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: projectBody, bodyRequired: false },
    responses: {
      200: { description: "The selected default persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  archivePersona: defineOperation({
    operationId: "archivePersona",
    method: "POST",
    path: "/v1/personas/{personaId}/archive",
    summary: "Archive a persona",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: archivePersonaBody },
    responses: {
      200: { description: "The archived persona.", schema: persona },
      ...writeRefusals,
    },
  }),

  restorePersona: defineOperation({
    operationId: "restorePersona",
    method: "POST",
    path: "/v1/personas/{personaId}/restore",
    summary: "Restore a persona",
    tag: "Personas",
    security: "credentialed",
    request: { params: personaParams, body: restorePersonaBody },
    responses: {
      200: { description: "The restored persona.", schema: persona },
      ...writeRefusals,
    },
  }),
} as const;
