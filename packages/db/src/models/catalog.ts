/**
 * The provider catalog: which model providers Egma supports, for which model
 * job, and what a working default looks like for each.
 *
 * **Server-owned release data, and the browser keeps no second copy.** A page
 * that maintained its own provider list would be a list that can disagree with
 * this one, and the disagreement is a provider somebody can select and nothing
 * can execute. The catalog is read through the API and drawn; it is never
 * restated in a component.
 *
 * **An entry is a promise, so an entry appears only once it can be kept.** A
 * provider-job pair becomes visible when all three paths behind it exist:
 * customer-owned execution, managed execution through the Egma model gateway,
 * and a live proof using the recommended default. `RESERVED_PROVIDER_JOBS`
 * below names the pairs the product intends and has not proved, so the roadmap
 * is written down without any of it being selectable — the shape
 * `RESERVED_LIBRARY_TYPES` already uses for the grader types that are coming.
 *
 * **Model IDs and voice IDs are not allowlisted, and that is deliberate.** A
 * release proves one recommended default per entry; a user may type any ID the
 * shipped adapter accepts. Egma maintaining a list of every model a provider
 * has would be a list that is wrong the week after it ships, and its wrongness
 * would read as "Egma does not support this model" for a model that works.
 * Provider rejection is a visible execution error instead — the provider is the
 * authority on its own values.
 */

/**
 * One role a model performs. A catalog entry belongs to exactly one job, and a
 * persona selects one entry for each of the three.
 *
 * Silero VAD is deliberately not a job. What tells the persona that the agent
 * has started and stopped speaking is internal simulator behavior, not a model
 * anybody chooses, and putting it here would make an implementation detail into
 * a question every persona author has to answer.
 */
export const MODEL_JOBS = ["llm", "stt", "tts"] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];

/** One provider doing one job, with the default a release proved for it. */
export type ProviderCatalogEntry = {
  /** The provider's own name, as a credential and a work order spell it. */
  readonly provider: ModelProvider;
  readonly job: ModelJob;
  /** What a person calls it, in a form and in an error alike. */
  readonly label: string;
  /**
   * The model ID this release proved for this entry, filled into a new
   * selection so a first run needs no model setup. Editable text everywhere it
   * is offered: it is a starting point, never a limit.
   */
  readonly recommendedModel: string;
  /**
   * The provider's voice ID this release proved, for a `tts` entry alone. An
   * `llm` or `stt` entry has none, and the type says so rather than carrying an
   * empty string that a form would then have to decide what to do with.
   */
  readonly recommendedVoiceId?: string;
};

/**
 * The providers a model-provider credential may authorize.
 *
 * **Exactly the providers the catalog can execute.** One provider does several
 * jobs — an OpenAI credential authorizes its LLM work and, when those entries
 * ship, its speech work too — so this is a list of accounts rather than a list
 * of entries. A provider that has no visible entry is not here: storing a
 * credential for it would be Egma taking a secret it has nothing to do with.
 */
export const MODEL_PROVIDERS = ["openai", "deepgram", "cartesia"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * What this release proved, and therefore what a persona and a grader may
 * select today.
 *
 * The three are the representative voice path: Deepgram listening, OpenAI
 * thinking, Cartesia speaking. Each was conducted end to end over both access
 * modes and measured against direct provider access before it was written here.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    provider: "openai",
    job: "llm",
    label: "OpenAI",
    recommendedModel: "gpt-4o-mini",
  },
  {
    provider: "deepgram",
    job: "stt",
    label: "Deepgram",
    recommendedModel: "nova-3-general",
  },
  {
    provider: "cartesia",
    job: "tts",
    label: "Cartesia",
    recommendedModel: "sonic-3.5",
    recommendedVoiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
  },
];

/**
 * The provider-job pairs the product intends and this release has not proved.
 *
 * Written down so the shape of the finished catalog is visible and so nobody
 * adds one of these by inventing a name for it. **None of them is selectable**:
 * a name here has no entry above, so a write naming it is refused exactly as a
 * name nobody has ever heard of is.
 */
export const RESERVED_PROVIDER_JOBS = [
  { provider: "anthropic", job: "llm" },
  { provider: "google", job: "llm" },
  { provider: "openai", job: "stt" },
  { provider: "assemblyai", job: "stt" },
  { provider: "elevenlabs", job: "tts" },
  { provider: "openai", job: "tts" },
] as const satisfies readonly {
  readonly provider: string;
  readonly job: ModelJob;
}[];

/**
 * The catalog grouped by model job — the shape a form draws itself from, worked
 * out once here rather than by every reader filtering the list again.
 *
 * A map rather than a function, on this module's whole terms: this is release
 * data, so it is a value the release carries and never a call anybody makes.
 */
export const PROVIDERS_BY_JOB: {
  readonly [Job in ModelJob]: readonly ProviderCatalogEntry[];
} = {
  llm: PROVIDER_CATALOG.filter((entry) => entry.job === "llm"),
  stt: PROVIDER_CATALOG.filter((entry) => entry.job === "stt"),
  tts: PROVIDER_CATALOG.filter((entry) => entry.job === "tts"),
};

/**
 * The entry a new selection starts from for each job, so authoring a persona or
 * a grader never begins with empty fields and a documentation search.
 *
 * The first entry of each job, which is the order the catalog is written in —
 * so which default a release recommends is decided by editing the catalog
 * rather than by a second list that could disagree with it.
 */
export const RECOMMENDED_ENTRY: {
  readonly [Job in ModelJob]: ProviderCatalogEntry;
} = {
  llm: firstEntryFor("llm"),
  stt: firstEntryFor("stt"),
  tts: firstEntryFor("tts"),
};

/**
 * Whether this string names a provider a credential may be stored for.
 *
 * Internal to this directory rather than on the data-access surface: it reads
 * release data and nothing else, and a caller outside asks `MODEL_PROVIDERS`
 * the same question without a second way to phrase it.
 */
export function isModelProvider(provider: string): provider is ModelProvider {
  return MODEL_PROVIDERS.some((known) => known === provider);
}

function firstEntryFor(job: ModelJob): ProviderCatalogEntry {
  const [first] = PROVIDER_CATALOG.filter((entry) => entry.job === job);
  if (first === undefined) {
    throw new Error(
      `the provider catalog ships no ${job} entry, so there is no recommended selection to start from`,
    );
  }
  return first;
}
