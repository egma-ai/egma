import type {
  GetPersonaFormResponse,
  GetPersonaResponse,
  ListPersonasResponse,
  ListPersonaVersionsResponse,
} from "@egma/platform-api/client";

export type Persona = GetPersonaResponse;
export type PersonaModels = NonNullable<Persona["settings"]>["models"];
export type PersonaControls = NonNullable<Persona["settings"]>["controls"];
export type PersonaPage = ListPersonasResponse;
export type PersonaVersionPage = ListPersonaVersionsResponse;
export type PersonaVersion = PersonaVersionPage["versions"][number];
export type PersonaForm = GetPersonaFormResponse;
export type PersonaModelCatalogEntry = PersonaForm["modelCatalog"][number];

type CascadedModels = Extract<PersonaModels, { readonly mode: "separate" }>;
type LiveModels = Extract<PersonaModels, { readonly mode: "live" }>;
type CascadedControls = Extract<PersonaControls, { readonly interruptionLevel: unknown }>;

export type BehaviorDraft = {
  readonly identityName: string;
  readonly personality: string;
};

export const BLANK_BEHAVIOR: BehaviorDraft = {
  identityName: "",
  personality: "",
};

export type ModelsDraft = {
  readonly mode: PersonaModels["mode"];
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly separateVoiceId: string;
  readonly liveVoiceId: string;
  readonly language: string;
  readonly backgroundSoundId: PersonaControls["backgroundSoundId"];
  readonly interruptionLevel: CascadedControls["interruptionLevel"];
};

export const BACKGROUND_SOUNDS: ReadonlyArray<{
  readonly id: PersonaControls["backgroundSoundId"];
  readonly label: string;
}> = [
  { id: "none", label: "None" },
  { id: "office-v1", label: "Office" },
  { id: "cafe-v1", label: "Café" },
  { id: "street-traffic-v1", label: "Street traffic" },
  { id: "crowd-talking-v1", label: "Crowd talking" },
  { id: "inside-car-v1", label: "Inside a car" },
  { id: "home-tv-v1", label: "Home with TV" },
  { id: "wind-v1", label: "Wind" },
  { id: "rain-v1", label: "Rain" },
];

export function modelsDraftOf(
  models: PersonaModels,
  controls?: PersonaControls,
): ModelsDraft {
  const cascaded = models.mode === "separate" ? models : null;
  return {
    mode: models.mode,
    llmProvider: models.llm.provider,
    llmModel: models.llm.model,
    sttProvider: cascaded?.stt.provider ?? "openai",
    sttModel: cascaded?.stt.model ?? "gpt-4o-mini-transcribe",
    ttsProvider: cascaded?.tts.provider ?? "openai",
    ttsModel: cascaded?.tts.model ?? "gpt-4o-mini-tts",
    separateVoiceId: cascaded?.tts.voiceId ?? "alloy",
    liveVoiceId: models.mode === "live" ? models.live.voiceId : "alloy",
    language: controls?.language ?? "en-US",
    backgroundSoundId: controls?.backgroundSoundId ?? "none",
    interruptionLevel:
      controls !== undefined && "interruptionLevel" in controls
        ? controls.interruptionLevel
        : "none",
  };
}

export function modelsFrom(draft: ModelsDraft): PersonaModels {
  if (draft.mode === "live") {
    return {
      mode: "live",
      llm: { provider: draft.llmProvider, model: draft.llmModel },
      live: {
        provider: "openai",
        model: "gpt-live-1",
        adapter: "openai_live",
        voiceId: draft.liveVoiceId,
      },
    } satisfies LiveModels;
  }
  return {
    mode: "separate",
    llm: { provider: draft.llmProvider, model: draft.llmModel },
    stt: { provider: draft.sttProvider, model: draft.sttModel },
    tts: {
      provider: draft.ttsProvider,
      model: draft.ttsModel,
      voiceId: draft.separateVoiceId,
    },
  } satisfies CascadedModels;
}

export function controlsFrom(draft: ModelsDraft): PersonaControls {
  const shared = {
    language: draft.language,
    backgroundSoundId: draft.backgroundSoundId,
  };
  return draft.mode === "live"
    ? shared
    : { ...shared, interruptionLevel: draft.interruptionLevel };
}

export function modelSaid(
  catalog: readonly PersonaModelCatalogEntry[] | undefined,
  job: PersonaModelCatalogEntry["job"],
  selection: { readonly provider: string; readonly model: string },
): string {
  const entry = catalog?.find(
    (one) =>
      one.job === job &&
      one.provider === selection.provider &&
      one.model === selection.model,
  );
  return `${entry?.label ?? selection.provider} · ${entry?.modelLabel ?? selection.model}`;
}

export function ownerSaid(owner: Persona["owner"]): string {
  return owner === "egma" ? "Built-in" : "Custom";
}

function valuesOf(persona: Persona): Record<string, number | string> {
  return Object.fromEntries(
    persona.parameterContract.map((field) => [field.key, field.defaultValue]),
  );
}

/** Read saved settings or the declared defaults of a built-in persona. */
export function modelsOfPersona(persona: Persona): PersonaModels {
  if (persona.settings !== null) return persona.settings.models;
  const values = valuesOf(persona);
  if (values.speech_mode === "live") {
    return {
      mode: "live",
      llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
      live: {
        provider: "openai",
        model: "gpt-live-1",
        adapter: "openai_live",
        voiceId: String(values.live_voice_id ?? "alloy"),
      },
    };
  }
  return {
    mode: "separate",
    llm: { provider: String(values.llm_provider), model: String(values.llm_model) },
    stt: { provider: String(values.stt_provider), model: String(values.stt_model) },
    tts: {
      provider: String(values.tts_provider),
      model: String(values.tts_model),
      voiceId: String(values.tts_voice_id ?? "alloy"),
    },
  };
}

/** Read saved controls or the declared defaults of a built-in persona. */
export function controlsOfPersona(persona: Persona): PersonaControls {
  if (persona.settings !== null) return persona.settings.controls;
  const values = valuesOf(persona);
  const shared = {
    language: String(values.language ?? persona.language ?? "en-US"),
    backgroundSoundId: (values.background_sound_id ?? "none") as PersonaControls["backgroundSoundId"],
  };
  return values.speech_mode === "live"
    ? shared
    : {
        ...shared,
        interruptionLevel: (values.interruption_level ?? "none") as CascadedControls["interruptionLevel"],
      };
}

export function personasPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/personas`;
}

export function newPersonaPath(projectId: string): string {
  return `${personasPath(projectId)}/new`;
}

export function personaPath(projectId: string, personaId: string): string {
  return `${personasPath(projectId)}/${encodeURIComponent(personaId)}`;
}

export function personaClonePath(projectId: string, personaId: string): string {
  return `${personaPath(projectId, personaId)}/clone`;
}
