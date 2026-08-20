/**
 * The model combinations this release can execute.
 *
 * A catalog entry is an adapter contract, not a suggestion. Provider and
 * model are kept together because an adapter supports the pair. Accepting the
 * two fields independently is what allowed a realtime OpenAI model to reach
 * the segmented transcription endpoint in production.
 */
export const MODEL_JOBS = ["llm", "stt", "tts"] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];

export const MODEL_PROVIDERS = ["openai", "deepgram", "cartesia"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export type ProviderCatalogEntry = {
  readonly provider: ModelProvider;
  readonly job: ModelJob;
  readonly model: string;
  readonly label: string;
  readonly recommendedVoiceId?: string;
  readonly recommendedSpeed?: number;
};

export const PROVIDER_CATALOG = [
  {
    provider: "openai",
    job: "llm",
    model: "gpt-4o-mini",
    label: "OpenAI",
  },
  {
    // This is the realtime transcription adapter. It must never be sent to
    // OpenAI's segmented /v1/audio/transcriptions endpoint.
    provider: "openai",
    job: "stt",
    model: "gpt-live-transcribe",
    label: "OpenAI",
  },
  {
    provider: "deepgram",
    job: "stt",
    model: "nova-3-general",
    label: "Deepgram",
  },
  {
    provider: "cartesia",
    job: "tts",
    model: "sonic-3.5",
    label: "Cartesia",
    recommendedVoiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    recommendedSpeed: 1,
  },
  {
    provider: "openai",
    job: "tts",
    model: "gpt-4o-mini-tts",
    label: "OpenAI",
    recommendedVoiceId: "alloy",
    recommendedSpeed: 1,
  },
] as const satisfies readonly ProviderCatalogEntry[];

export const PROVIDERS_BY_JOB: {
  readonly [Job in ModelJob]: readonly ProviderCatalogEntry[];
} = {
  llm: PROVIDER_CATALOG.filter((entry) => entry.job === "llm"),
  stt: PROVIDER_CATALOG.filter((entry) => entry.job === "stt"),
  tts: PROVIDER_CATALOG.filter((entry) => entry.job === "tts"),
};

/** The first supported pair for each job is the release default. */
export const RECOMMENDED_ENTRY: {
  readonly [Job in ModelJob]: ProviderCatalogEntry;
} = {
  llm: firstEntryFor("llm"),
  stt: firstEntryFor("stt"),
  tts: firstEntryFor("tts"),
};

export function isModelProvider(provider: string): provider is ModelProvider {
  return MODEL_PROVIDERS.some((known) => known === provider);
}

export function catalogEntry(
  job: ModelJob,
  provider: string,
  model: string,
): ProviderCatalogEntry | undefined {
  return PROVIDERS_BY_JOB[job].find(
    (entry) => entry.provider === provider && entry.model === model,
  );
}

function firstEntryFor(job: ModelJob): ProviderCatalogEntry {
  const first = PROVIDERS_BY_JOB[job][0];
  if (first === undefined) {
    throw new Error(`the provider catalog ships no ${job} adapter`);
  }
  return first;
}
