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

/**
 * Provider-protocol implementations shipped by the simulator, grouped by the
 * kind of work each protocol can perform.
 *
 * Keep the grouping private: callers choose an executable catalog entry, not
 * an adapter in isolation. The public flat value remains useful for contract
 * and observability vocabulary, while the types below prevent a catalog author
 * from wiring a speech adapter to an LLM (or the reverse).
 */
const MODEL_ADAPTERS_BY_JOB = {
  llm: ["openai_chat_completions"],
  stt: ["openai_realtime", "deepgram"],
  tts: ["cartesia", "openai"],
} as const satisfies {
  readonly [Job in ModelJob]: readonly string[];
};

export const MODEL_ADAPTERS = [
  ...MODEL_ADAPTERS_BY_JOB.llm,
  ...MODEL_ADAPTERS_BY_JOB.stt,
  ...MODEL_ADAPTERS_BY_JOB.tts,
] as const;

export type ModelAdapterByJob = {
  readonly [Job in ModelJob]: (typeof MODEL_ADAPTERS_BY_JOB)[Job][number];
};
export type ModelAdapter<Job extends ModelJob = ModelJob> =
  ModelAdapterByJob[Job];

/** The reasoning primitive shared by every LLM catalog entry. */
export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type CatalogCapabilities<Job extends ModelJob> = Job extends "llm"
  ? {
      /** The reasoning choices this LLM accepts. Absent means no choice. */
      readonly reasoningEfforts?: readonly ReasoningEffort[];
      readonly recommendedReasoningEffort?: ReasoningEffort;
    }
  : Job extends "tts"
    ? {
        readonly recommendedVoiceId?: string;
        readonly recommendedSpeed?: number;
      }
    : Record<never, never>;

export type ProviderCatalogEntry<
  Job extends ModelJob = ModelJob,
> = Job extends ModelJob
  ? {
      readonly provider: ModelProvider;
      readonly job: Job;
      readonly model: string;
      /** The protocol adapter the work order tells the simulator to dispatch. */
      readonly adapter: ModelAdapter<Job>;
      readonly label: string;
    } & CatalogCapabilities<Job>
  : never;

export const PROVIDER_CATALOG = [
  {
    provider: "openai",
    job: "llm",
    model: "gpt-4o-mini",
    adapter: "openai_chat_completions",
    label: "OpenAI",
  },
  {
    provider: "openai",
    job: "llm",
    model: "gpt-5.6-terra",
    adapter: "openai_chat_completions",
    label: "OpenAI",
    reasoningEfforts: REASONING_EFFORTS,
    recommendedReasoningEffort: "none",
  },
  {
    // This is the realtime transcription adapter. It must never be sent to
    // OpenAI's segmented /v1/audio/transcriptions endpoint.
    provider: "openai",
    job: "stt",
    model: "gpt-live-transcribe",
    adapter: "openai_realtime",
    label: "OpenAI",
  },
  {
    provider: "deepgram",
    job: "stt",
    model: "nova-3-general",
    adapter: "deepgram",
    label: "Deepgram",
  },
  {
    provider: "cartesia",
    job: "tts",
    model: "sonic-3.5",
    adapter: "cartesia",
    label: "Cartesia",
    recommendedVoiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    recommendedSpeed: 1,
  },
  {
    provider: "openai",
    job: "tts",
    model: "gpt-4o-mini-tts",
    adapter: "openai",
    label: "OpenAI",
    recommendedVoiceId: "alloy",
    recommendedSpeed: 1,
  },
] as const satisfies readonly ProviderCatalogEntry[];

export const PROVIDERS_BY_JOB: {
  readonly [Job in ModelJob]: readonly ProviderCatalogEntry<Job>[];
} = {
  llm: PROVIDER_CATALOG.filter((entry) => entry.job === "llm"),
  stt: PROVIDER_CATALOG.filter((entry) => entry.job === "stt"),
  tts: PROVIDER_CATALOG.filter((entry) => entry.job === "tts"),
};

/** The first supported pair for each job is the release default. */
export const RECOMMENDED_ENTRY: {
  readonly [Job in ModelJob]: ProviderCatalogEntry<Job>;
} = {
  llm: firstEntryFor("llm"),
  stt: firstEntryFor("stt"),
  tts: firstEntryFor("tts"),
};

export function isModelProvider(provider: string): provider is ModelProvider {
  return MODEL_PROVIDERS.some((known) => known === provider);
}

export function catalogEntry<Job extends ModelJob>(
  job: Job,
  provider: string,
  model: string,
): ProviderCatalogEntry<Job> | undefined {
  return PROVIDERS_BY_JOB[job].find(
    (entry) => entry.provider === provider && entry.model === model,
  );
}

function firstEntryFor<Job extends ModelJob>(
  job: Job,
): ProviderCatalogEntry<Job> {
  const first = PROVIDERS_BY_JOB[job][0];
  if (first === undefined) {
    throw new Error(`the provider catalog ships no ${job} adapter`);
  }
  return first;
}
