/** Provider-aware authoring facts shared by save validation and execution. */

export type CapabilityStatus = "supported" | "fixed" | "unsupported" | "unknown";

export type PersonaVoice = {
  readonly id: string;
  readonly name: string;
  readonly source: "standard" | "account";
  readonly presentation: "male" | "female" | "neutral" | "unknown";
  readonly languages: readonly string[];
  readonly isProfessional?: boolean;
  readonly modelIds?: readonly string[];
  readonly publiclyAccessible?: boolean;
};

export type Capability<T> = {
  readonly status: CapabilityStatus;
  readonly reason?: string;
  readonly choices?: readonly T[];
  readonly value?: T;
  readonly range?: { readonly minimum: number; readonly maximum: number; readonly step: number };
};

export type PersonaCapabilitySelection = {
  readonly mode?: "separate" | "live";
  readonly ttsProvider?: string;
  readonly ttsModel?: string;
  readonly sttProvider?: string;
  readonly sttModel?: string;
  readonly liveProvider?: string;
  readonly liveModel?: string;
  readonly language?: string;
  readonly voiceId?: string;
};

export type PersonaCapabilities = {
  readonly voices: Capability<PersonaVoice>;
  readonly language: Capability<string>;
};

export function personaCapabilityRefusal(
  capabilities: PersonaCapabilities,
  selected: { readonly voiceId?: string; readonly voiceField?: "models.tts.voiceId" | "models.live.voiceId" },
): string | undefined {
  for (const [field, capability] of Object.entries({ voices: capabilities.voices, language: capabilities.language })) {
    if (capability.status === "unsupported") return `${field}: ${capability.reason ?? "unsupported"}`;
    if (capability.status === "unknown")
      return `${field}: ${capability.reason ?? "support could not be verified"}`;
  }
  if (selected.voiceId !== undefined && capabilities.voices.choices !== undefined &&
      !capabilities.voices.choices.some((voice) => voice.id === selected.voiceId))
    return `${selected.voiceField ?? "models.tts.voiceId"}: Choose one of the available voices.`;
  return undefined;
}

function openAiVoice(id: string): PersonaVoice {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    source: "standard",
    presentation: id === "cedar" ? "male" : id === "coral" ? "female" : "unknown",
    languages: [],
  };
}

export const OPENAI_STANDARD_VOICES: readonly PersonaVoice[] = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar",
].map(openAiVoice);

/** Built-in voices accepted by the OpenAI Live session schema. */
export const OPENAI_LIVE_VOICES: readonly PersonaVoice[] = [
  "alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam",
  "marin", "meridian", "quartz", "ripple", "sage", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
].map(openAiVoice);

const OPENAI_LEGACY_VOICE_IDS = new Set(["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"]);

const OPENAI_TTS_MODELS = new Set([
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
]);

export const OPENAI_TTS_LANGUAGES = [
  "af", "ar", "hy", "az", "be", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "el", "he", "hi", "hu", "is", "id", "it", "ja", "kn", "kk", "ko", "lv", "lt", "mk", "ms", "mr", "mi", "ne", "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "sl", "es", "sw", "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi", "cy",
] as const;

const OPENAI_STT_MODELS = new Set([
  "gpt-live-transcribe",
  "gpt-realtime-whisper",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

const CARTESIA_TTS_MODELS = new Set(["sonic-3.5", "sonic-3.6", "sonic-3.6-2026-08-27", "sonic-preview"]);
const CARTESIA_SONIC_36_LANGUAGES = [
  "en", "fr", "de", "es", "pt", "zh", "ja", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr", "tl", "bg", "ro", "ar", "cs", "el", "fi", "hr", "ms", "sk", "da", "ta", "uk", "hu", "no", "vi", "bn", "th", "he", "ka", "id", "te", "gu", "kn", "ml", "mr", "pa", "or", "ur",
] as const;
const CARTESIA_STT_MODELS = new Set(["ink-2"]);

const DEEPGRAM_NOVA3_LANGUAGES = new Set([
  "ar", "be", "bn", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "gu", "he", "hi", "hu", "id", "it", "ja", "kn", "ko", "lv", "lt", "mk", "ms", "mr", "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "sl", "es", "sv", "tl", "ta", "te", "th", "tr", "uk", "ur", "vi",
]);
const CARTESIA_STT_LANGUAGES = new Set([
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
]);

function unsupported<T>(reason: string): Capability<T> {
  return { status: "unsupported", reason };
}

function unknown<T>(reason: string): Capability<T> {
  return { status: "unknown", reason };
}

function sttSupports(selection: PersonaCapabilitySelection): boolean {
  return selection.sttProvider === "openai"
    ? OPENAI_STT_MODELS.has(selection.sttModel ?? "")
    : selection.sttProvider === "cartesia"
      ? CARTESIA_STT_MODELS.has(selection.sttModel ?? "")
      : selection.sttProvider === "deepgram" && selection.sttModel === "nova-3-general";
}

function sttSupportsLanguage(selection: PersonaCapabilitySelection): boolean {
  if (selection.language === undefined) return true;
  const base = selection.language.toLowerCase().split("-")[0]!;
  if (selection.sttProvider === "openai") return OPENAI_TTS_LANGUAGES.includes(base as (typeof OPENAI_TTS_LANGUAGES)[number]);
  if (selection.sttProvider === "deepgram") return DEEPGRAM_NOVA3_LANGUAGES.has(base);
  if (selection.sttProvider === "cartesia") return CARTESIA_STT_LANGUAGES.has(base);
  return false;
}

/** Resolve the complete selected combination. No caller may relax this result. */
export function resolvePersonaCapabilities(
  selection: PersonaCapabilitySelection,
  accountVoices: readonly PersonaVoice[] = [],
): PersonaCapabilities {
  if (selection.mode === "live") {
    if (selection.liveProvider !== "openai" || selection.liveModel !== "gpt-live-1") {
      const reason = `Live speech ${selection.liveProvider ?? ""}/${selection.liveModel ?? ""} is not available in this release.`;
      return { voices: unsupported(reason), language: unsupported(reason) };
    }
    return {
      voices: { status: "supported", choices: OPENAI_LIVE_VOICES },
      language: { status: "supported", choices: OPENAI_TTS_LANGUAGES },
    };
  }
  if (!sttSupports(selection)) {
    const reason = `Speech recognition ${selection.sttProvider}/${selection.sttModel} is not available in this release.`;
    return {
      voices: unsupported(reason), language: unsupported(reason),
    };
  }
  if (!sttSupportsLanguage(selection)) {
    const reason = `Speech recognition ${selection.sttProvider}/${selection.sttModel} does not support ${selection.language}.`;
    return {
      voices: unsupported(reason), language: unsupported(reason),
    };
  }

  if (selection.ttsProvider === "openai" && OPENAI_TTS_MODELS.has(selection.ttsModel ?? "")) {
    const standardVoices = selection.ttsModel?.startsWith("gpt-4o-mini-tts") === true
      ? OPENAI_STANDARD_VOICES
      : OPENAI_STANDARD_VOICES.filter((voice) => OPENAI_LEGACY_VOICE_IDS.has(voice.id));
    const selectedLanguage = selection.language?.toLowerCase().split("-")[0];
    const language = selectedLanguage !== undefined && !OPENAI_TTS_LANGUAGES.includes(selectedLanguage as (typeof OPENAI_TTS_LANGUAGES)[number])
      ? unsupported<string>(`OpenAI does not document ${selection.language} for this speech model.`)
      : { status: "supported" as const, choices: OPENAI_TTS_LANGUAGES };
    return {
      voices: { status: "supported", choices: [...standardVoices, ...accountVoices] },
      language,
    };
  }

  if (selection.ttsProvider === "cartesia" && CARTESIA_TTS_MODELS.has(selection.ttsModel ?? "")) {
    const selectedVoice = accountVoices.find((voice) => voice.id === selection.voiceId);
    const languages = selection.ttsModel === "sonic-3.5"
      ? CARTESIA_SONIC_36_LANGUAGES.filter((language) => language !== "or" && language !== "ur")
      : CARTESIA_SONIC_36_LANGUAGES;
    const languageMatches = selection.language === undefined || languages.some((language) => language === selection.language!.toLowerCase().split("-")[0]);
    const professional = selectedVoice?.isProfessional === true;
    if (professional && selectedVoice.modelIds === undefined) {
      const reason = "Cartesia did not return model compatibility for this professional clone. Refresh the voice catalog before saving.";
      return {
        voices: { status: "supported", choices: accountVoices },
        language: unknown(reason),
      };
    }
    const supportsModel = selectedVoice?.modelIds === undefined || selectedVoice.modelIds.includes(selection.ttsModel ?? "");
    if (!supportsModel || (professional && selection.ttsModel === "sonic-preview")) {
      const reason = professional
        ? "Cartesia professional clones do not support Sonic 3.6 Preview. Choose a compatible model from the voice metadata."
        : "The selected Cartesia voice does not support this model.";
      return {
        voices: { status: "supported", choices: accountVoices }, language: unsupported(reason),
      };
    }
    return {
      voices: { status: "supported", choices: accountVoices },
      language: !languageMatches
        ? unsupported(`Cartesia ${selection.ttsModel} does not support ${selection.language}.`)
        : { status: "supported", choices: languages },
    };
  }

  const reason = `Text-to-speech ${selection.ttsProvider}/${selection.ttsModel} is not available in this release.`;
  return {
    voices: unsupported(reason), language: unsupported(reason),
  };
}

export type CartesiaVoiceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class CartesiaVoiceDiscoveryUnavailableError extends Error {
  constructor() {
    super("Cartesia voice discovery is temporarily unavailable.");
    this.name = "CartesiaVoiceDiscoveryUnavailableError";
  }
}

type CartesiaVoicePage = {
  readonly data?: readonly Record<string, unknown>[];
  readonly has_more?: boolean;
  readonly next_page?: string | null;
};

/** Read every Cartesia page. The credential stays only in the outbound header. */
export async function discoverCartesiaVoices(
  apiKey: string,
  fetcher: CartesiaVoiceFetch = fetch,
  signal?: AbortSignal,
): Promise<readonly PersonaVoice[]> {
  const voices: PersonaVoice[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const overallSignal = signal === undefined
    ? AbortSignal.timeout(30_000)
    : AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let pages = 0;
  do {
    if (++pages > 100) throw new Error("Cartesia voice discovery exceeded 100 pages.");
    const url = new URL("https://api.cartesia.ai/voices");
    url.searchParams.set("limit", "100");
    if (cursor !== undefined) url.searchParams.set("starting_after", cursor);
    let response: Response;
    try {
      response = await fetcher(url, {
        signal: overallSignal,
        headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": "2026-08-14" },
      });
    } catch {
      throw new CartesiaVoiceDiscoveryUnavailableError();
    }
    if (response.status === 429 || response.status >= 500) {
      throw new CartesiaVoiceDiscoveryUnavailableError();
    }
    if (!response.ok) throw new Error(`Cartesia voice discovery failed with status ${response.status}.`);
    const page = await response.json() as CartesiaVoicePage;
    for (const raw of page.data ?? []) {
      if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
      const language = typeof raw.language === "string" ? raw.language.replaceAll("_", "-") : undefined;
      const country = typeof raw.country === "string" ? raw.country.toUpperCase() : undefined;
      const presentation = raw.gender === "masculine" ? "male" : raw.gender === "feminine" ? "female" : raw.gender === "gender_neutral" ? "neutral" : "unknown";
      const accentMetadata = Array.isArray(raw.accents) ? raw.accents : [];
      const locales = accentMetadata.flatMap((one) => typeof one === "object" && one !== null && "locale" in one && typeof one.locale === "string" ? [one.locale] : []);
      const fineTunes = Array.isArray(raw.fine_tunes) ? raw.fine_tunes : [];
      const modelIds = fineTunes.flatMap((one) => typeof one === "object" && one !== null && "public_model_id" in one && typeof one.public_model_id === "string" ? [one.public_model_id] : []);
      voices.push({
        id: raw.id,
        name: raw.name,
        source: raw.access === "private" || raw.visibility === "owner" || raw.is_owner === true ? "account" : "standard",
        presentation,
        languages: locales.length > 0 ? locales : language === undefined ? [] : [language],
        ...(raw.is_pro === true ? { isProfessional: true } : {}),
        ...(modelIds.length === 0 ? {} : { modelIds }),
        ...(raw.access === "public" && raw.visibility === "all" ? { publiclyAccessible: true } : {}),
      });
    }
    const pageVoices = page.data ?? [];
    const lastPageVoice = pageVoices.findLast((one) => typeof one.id === "string");
    const nextCursor = typeof lastPageVoice?.id === "string" ? lastPageVoice.id : undefined;
    cursor = page.has_more === true ? nextCursor : undefined;
    if (page.has_more === true && (cursor === undefined || seenCursors.has(cursor))) {
      throw new Error("Cartesia returned another page without a new cursor.");
    }
    if (cursor !== undefined) seenCursors.add(cursor);
  } while (cursor !== undefined);
  return voices;
}
