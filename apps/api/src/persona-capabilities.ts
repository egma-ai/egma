/** Provider-aware authoring facts shared by save validation, Preview, and execution. */

export const PERSONA_EMOTIONS = [
  "neutral",
  "happy",
  "angry",
  "frustrated",
  "sad",
  "anxious",
] as const;

export type PersonaEmotion = (typeof PERSONA_EMOTIONS)[number];
export type CapabilityStatus = "supported" | "fixed" | "unsupported" | "unknown";

export type PersonaVoice = {
  readonly id: string;
  readonly name: string;
  readonly source: "standard" | "account";
  readonly presentation: "male" | "female" | "neutral" | "unknown";
  readonly languages: readonly string[];
  readonly accents: readonly string[];
  readonly isProfessional?: boolean;
  readonly modelIds?: readonly string[];
};

export type Capability<T> = {
  readonly status: CapabilityStatus;
  readonly reason?: string;
  readonly choices?: readonly T[];
  readonly value?: T;
  readonly range?: { readonly minimum: number; readonly maximum: number; readonly step: number };
};

export type PersonaCapabilitySelection = {
  readonly ttsProvider: string;
  readonly ttsModel: string;
  readonly sttProvider: string;
  readonly sttModel: string;
  readonly language?: string;
  readonly voiceId?: string;
};

export type PersonaCapabilities = {
  readonly voices: Capability<PersonaVoice>;
  readonly language: Capability<string>;
  readonly accent: Capability<string>;
  readonly emotion: Capability<PersonaEmotion>;
  readonly speed: Capability<number>;
  readonly speechVolume: Capability<number>;
};

export const OPENAI_STANDARD_VOICES: readonly PersonaVoice[] = [
  "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar",
].map((id) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  source: "standard" as const,
  presentation: id === "cedar" ? "male" as const : id === "coral" ? "female" as const : "unknown" as const,
  languages: [],
  accents: [],
}));

const OPENAI_LEGACY_VOICE_IDS = new Set(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);

const OPENAI_TTS_MODELS = new Set([
  "gpt-4o-mini-tts",
  "gpt-4o-mini-tts-2025-12-15",
  "tts-1",
  "tts-1-hd",
]);

export const OPENAI_TTS_LANGUAGES = [
  "af", "ar", "hy", "az", "be", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "el", "he", "hi", "hu", "is", "id", "it", "ja", "kn", "kk", "ko", "lv", "lt", "mk", "ms", "mr", "mi", "ne", "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "sl", "es", "sw", "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi", "cy",
] as const;

export const OPENAI_INSTRUCTION_ACCENTS = [
  "voice_default", "american", "british", "australian", "indian", "irish", "scottish", "spanish", "french", "german",
] as const;

const OPENAI_STT_MODELS = new Set([
  "gpt-live-transcribe",
  "gpt-realtime-whisper",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
]);

const CARTESIA_TTS_MODELS = new Set(["sonic-preview"]);
const CARTESIA_STT_MODELS = new Set(["ink-2"]);

function unsupported<T>(reason: string): Capability<T> {
  return { status: "unsupported", reason };
}

function unknown<T>(reason: string): Capability<T> {
  return { status: "unknown", reason };
}

function sttSupports(selection: PersonaCapabilitySelection): boolean {
  return selection.sttProvider === "openai"
    ? OPENAI_STT_MODELS.has(selection.sttModel)
    : selection.sttProvider === "cartesia"
      ? CARTESIA_STT_MODELS.has(selection.sttModel)
      : selection.sttProvider === "deepgram" && selection.sttModel === "nova-3-general";
}

/** Resolve the complete selected combination. No caller may relax this result. */
export function resolvePersonaCapabilities(
  selection: PersonaCapabilitySelection,
  accountVoices: readonly PersonaVoice[] = [],
): PersonaCapabilities {
  if (!sttSupports(selection)) {
    const reason = `Speech recognition ${selection.sttProvider}/${selection.sttModel} is not available in this release.`;
    return {
      voices: unsupported(reason), language: unsupported(reason), accent: unsupported(reason),
      emotion: unsupported(reason), speed: unsupported(reason), speechVolume: unsupported(reason),
    };
  }

  if (selection.ttsProvider === "openai" && OPENAI_TTS_MODELS.has(selection.ttsModel)) {
    const instructional = selection.ttsModel.startsWith("gpt-4o-mini-tts");
    const standardVoices = instructional
      ? OPENAI_STANDARD_VOICES
      : OPENAI_STANDARD_VOICES.filter((voice) => OPENAI_LEGACY_VOICE_IDS.has(voice.id));
    const selectedLanguage = selection.language?.toLowerCase().split("-")[0];
    const language = selectedLanguage !== undefined && !OPENAI_TTS_LANGUAGES.includes(selectedLanguage as (typeof OPENAI_TTS_LANGUAGES)[number])
      ? unsupported<string>(`OpenAI does not document ${selection.language} for this speech model.`)
      : { status: "supported" as const, choices: OPENAI_TTS_LANGUAGES };
    return {
      voices: { status: "supported", choices: [...standardVoices, ...accountVoices] },
      language,
      accent: instructional
        ? { status: "supported", choices: OPENAI_INSTRUCTION_ACCENTS }
        : { status: "fixed", value: "voice_default", reason: "This model does not accept delivery instructions." },
      emotion: instructional
        ? { status: "supported", choices: PERSONA_EMOTIONS }
        : { status: "fixed", value: "neutral", reason: "This model does not accept delivery instructions." },
      speed: { status: "supported", range: { minimum: 0.25, maximum: 4, step: 0.05 } },
      speechVolume: { status: "supported", range: { minimum: 0.5, maximum: 1.5, step: 0.1 } },
    };
  }

  if (selection.ttsProvider === "cartesia" && CARTESIA_TTS_MODELS.has(selection.ttsModel)) {
    const selectedVoice = accountVoices.find((voice) => voice.id === selection.voiceId);
    const languages = selectedVoice?.languages ?? [];
    const accents = selectedVoice?.accents ?? [];
    const languageMatches = selection.language === undefined || languages.length === 0 || languages.some((language) => language.toLowerCase() === selection.language!.toLowerCase() || language.split("-")[0] === selection.language!.split("-")[0]);
    const professional = selectedVoice?.isProfessional === true;
    const supportsModel = selectedVoice?.modelIds === undefined || selectedVoice.modelIds.includes(selection.ttsModel);
    if (!supportsModel || (professional && selection.ttsModel === "sonic-preview")) {
      const reason = professional
        ? "Cartesia professional clones do not support Sonic 3.6 Preview. Choose a compatible model from the voice metadata."
        : "The selected Cartesia voice does not support this model.";
      return {
        voices: { status: "supported", choices: accountVoices }, language: unsupported(reason), accent: unsupported(reason),
        emotion: unsupported(reason), speed: unsupported(reason), speechVolume: { status: "supported", range: { minimum: 0.5, maximum: 1.5, step: 0.1 } },
      };
    }
    return {
      voices: { status: "supported", choices: accountVoices },
      language: !languageMatches
        ? unsupported(`The selected Cartesia voice does not support ${selection.language}.`)
        : languages.length > 0
        ? { status: "supported", choices: languages }
        : unknown("Cartesia did not return language metadata for the selected voice."),
      accent: selectedVoice === undefined
        ? unknown("Choose a Cartesia voice to resolve its accent metadata.")
        : accents.length > 0
        ? { status: "supported", choices: ["voice_default", ...accents] }
        : unknown("Cartesia did not return accent metadata for the selected voice."),
      emotion: selection.language?.toLowerCase().startsWith("en")
        ? { status: "supported", choices: PERSONA_EMOTIONS }
        : { status: "fixed", value: "neutral", reason: "Cartesia emotion tags are supported only for English." },
      speed: professional
        ? { status: "fixed", value: 1, reason: "Cartesia professional clones ignore native speed." }
        : { status: "supported", range: { minimum: 0.6, maximum: 1.5, step: 0.1 } },
      speechVolume: { status: "supported", range: { minimum: 0.5, maximum: 1.5, step: 0.1 } },
    };
  }

  const reason = `Text-to-speech ${selection.ttsProvider}/${selection.ttsModel} is not available in this release.`;
  return {
    voices: unsupported(reason), language: unsupported(reason), accent: unsupported(reason),
    emotion: unsupported(reason), speed: unsupported(reason), speechVolume: unsupported(reason),
  };
}

export type CartesiaVoiceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
  do {
    const url = new URL("https://api.cartesia.ai/voices");
    url.searchParams.set("limit", "100");
    url.searchParams.append("expand[]", "preview_file_url");
    if (cursor !== undefined) url.searchParams.set("starting_after", cursor);
    const response = await fetcher(url, {
      ...(signal === undefined ? {} : { signal }),
      headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": "2026-03-01" },
    });
    if (!response.ok) throw new Error(`Cartesia voice discovery failed with status ${response.status}.`);
    const page = await response.json() as CartesiaVoicePage;
    for (const raw of page.data ?? []) {
      if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
      const language = typeof raw.language === "string" ? raw.language.replaceAll("_", "-") : undefined;
      const country = typeof raw.country === "string" ? raw.country.toUpperCase() : undefined;
      const presentation = raw.gender === "masculine" ? "male" : raw.gender === "feminine" ? "female" : raw.gender === "gender_neutral" ? "neutral" : "unknown";
      const accents = Array.isArray(raw.accents) ? raw.accents.filter((one): one is string => typeof one === "string") : country === undefined ? [] : [country];
      const fineTunes = Array.isArray(raw.fine_tunes) ? raw.fine_tunes : [];
      const modelIds = fineTunes.flatMap((one) => typeof one === "object" && one !== null && "public_model_id" in one && typeof one.public_model_id === "string" ? [one.public_model_id] : []);
      voices.push({
        id: raw.id,
        name: raw.name,
        source: raw.is_owner === true ? "account" : "standard",
        presentation,
        languages: language === undefined ? [] : [country === undefined || language.includes("-") ? language : `${language}-${country}`],
        accents,
        ...(raw.is_pro === true ? { isProfessional: true } : {}),
        ...(modelIds.length === 0 ? {} : { modelIds }),
      });
    }
    cursor = page.has_more === true ? voices.at(-1)?.id : undefined;
    if (page.has_more === true && cursor === undefined) throw new Error("Cartesia returned another page without a cursor.");
  } while (cursor !== undefined);
  return voices;
}
