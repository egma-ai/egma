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
 * below is the shape a future release names a pair in before it can keep it —
 * the shape `RESERVED_LIBRARY_TYPES` already uses for the grader types that are
 * coming — and it is deliberately empty, because a provider this release cannot
 * live-prove is a provider this release does not mention.
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
 * jobs — an OpenAI credential authorizes its language-model work and its
 * listening and speaking work, all three of which this release ships — so this
 * is a list of accounts rather than a list of entries. A provider that has no
 * visible entry is not here: storing a credential for it would be Egma taking a
 * secret it has nothing to do with.
 */
export const MODEL_PROVIDERS = ["openai", "deepgram", "cartesia"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * What this release proved, and therefore what a persona and a grader may
 * select today.
 *
 * Five entries across three provider accounts: Deepgram or OpenAI listening,
 * OpenAI thinking, Cartesia or OpenAI speaking. Each was executed end to end
 * over both access modes and then run live against the real provider with the
 * recommended default below, on both the direct path and the deployed Egma
 * model gateway, before it was written here.
 *
 * **Order decides the default**, because `RECOMMENDED_ENTRY` takes the first
 * entry of each job. Deepgram leads STT and Cartesia leads TTS: both are
 * streaming legs built for a phone line, and both were the measured
 * representative path.
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
    /**
     * OpenAI's realtime transcription socket, and **not** its segmented
     * `audio/transcriptions` endpoint.
     *
     * The specification asked for exactly one of the two to be exposed, chosen
     * by proof rather than by preference, because "OpenAI STT" is not one
     * transport promise. The segmented interface cannot begin transcribing
     * until the speaker has stopped, so on a call the whole length of every
     * agent turn is added to that turn's delay before the persona can start
     * thinking. The realtime socket answers while the audio is still arriving,
     * and it did so against the real provider — a first partial transcript
     * about a second before the utterance ended. So this entry is the socket,
     * and the other interface is absent rather than second.
     */
    provider: "openai",
    job: "stt",
    label: "OpenAI",
    recommendedModel: "gpt-live-transcribe",
  },
  {
    provider: "cartesia",
    job: "tts",
    label: "Cartesia",
    recommendedModel: "sonic-3.5",
    recommendedVoiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
  },
  {
    /**
     * OpenAI's speech synthesis. Its voice is a word from the provider's own
     * short list rather than a minted identifier, which is why the recommended
     * voice here reads nothing like Cartesia's above — a voice id belongs to
     * the provider that named it, and handing either one the other's is a
     * refusal at the first word.
     */
    provider: "openai",
    job: "tts",
    label: "OpenAI",
    recommendedModel: "gpt-4o-mini-tts",
    recommendedVoiceId: "alloy",
  },
];

/**
 * The provider-job pairs a release has named and cannot yet keep.
 *
 * **Empty, and that is a decision rather than an oversight.** The first catalog
 * was narrowed to the entries Egma can live-prove with the provider accounts it
 * holds, and the pairs that left are deferred rather than cancelled: each
 * returns through its own ticket when a live-proof credential exists, under the
 * unchanged rule above. Until then Egma does not name them, because a name here
 * is served to every browser that reads the catalog and reads as a promise
 * about a date nobody has set.
 *
 * The shape stays because the rule it expresses does: a pair named here has no
 * entry above, so a write naming it is refused exactly as a name nobody has
 * ever heard of is.
 */
export const RESERVED_PROVIDER_JOBS: readonly {
  readonly provider: string;
  readonly job: ModelJob;
}[] = [];

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

/**
 * Where each provider-job pair is reached **through the Egma model gateway**,
 * as a suffix on the gateway's own address.
 *
 * **Release catalog data, exactly like the provider catalog above, and it lives
 * here for the same reason.** Three things have to agree about it: the
 * simulator's speech legs, the grader's judge makers, and the gateway's own
 * route table. The first two read this; the third is the authority, and a
 * deterministic test holds the two lists against each other so a route renamed
 * in the gateway cannot leave a leg quietly pointed at a path nothing answers.
 *
 * **A suffix rather than a whole address, because the address is the
 * deployment's.** A work order carries one gateway address; each leg composes
 * its own path onto it. What each suffix is depends on what the shipped
 * provider adapter does with a base: Pipecat's Deepgram service appends
 * `/v1/listen`, so the suffix stops at the provider's name; the OpenAI chat and
 * speech clients append `/chat/completions` and `/audio/speech`, so the suffix
 * carries `/v1`; Cartesia's service and OpenAI's realtime transcription service
 * each take a whole socket address, so the suffix is the whole path.
 */
export const GATEWAY_ROUTE: Readonly<
  Record<ModelProvider, Partial<Record<ModelJob, string>>>
> = {
  openai: {
    llm: "/openai/v1",
    // The realtime transcription service takes a whole socket address and
    // appends its own `?intent=transcription`, so the suffix is the whole path.
    stt: "/openai/v1/realtime",
    // The speech client appends `/audio/speech` to its base, exactly as the
    // chat client appends `/chat/completions`, so both stop at `/v1`.
    tts: "/openai/v1",
  },
  deepgram: { stt: "/deepgram" },
  cartesia: { tts: "/cartesia/tts/websocket" },
};

/**
 * The address one leg is told, or `undefined` where this release carries no
 * gateway route for that provider and job.
 *
 * Absent is a refusal to guess. A provider-job pair with no route is a pair
 * managed access cannot execute, and answering the gateway's bare address would
 * send the leg to a path the gateway refuses — a `404` from Egma, read by
 * whoever sees it as the provider being wrong.
 */
export function gatewayAddressFor(
  gatewayAddress: string,
  provider: string,
  job: ModelJob,
): string | undefined {
  if (!isModelProvider(provider)) return undefined;
  const suffix = GATEWAY_ROUTE[provider][job];
  return suffix === undefined
    ? undefined
    : `${gatewayAddress.replace(/\/+$/, "")}${suffix}`;
}
