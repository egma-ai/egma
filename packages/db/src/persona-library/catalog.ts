import { legacyPersonaParameterContract, preCategoricalPersonaParameterContract, ticket01PersonaParameterContract, ticket02PersonaParameterContract } from "./parameters.ts";
import type { GraderParameter } from "../grader-library/parameters.ts";
import { EGMA_PROVIDED_PERSONAS } from "./ids.ts";

export { EGMA_PROVIDED_PERSONAS } from "./ids.ts";

export type EgmaProvidedPersonaVersion = {
  /**
   * Fixed after launch. A later catalog edit adds a new id; only an explicit
   * pre-launch migration may rewrite this row in place.
   */
  readonly id: string;
  readonly version: number;
  /**
   * The human name this persona gives the agent. Catalog content, not a
   * fallback: an agent that asked "who am I speaking to?" used to hear
   * whatever the model invented that morning, and a shelf persona introducing
   * itself by its catalog name would be worse than either.
   */
  readonly identityName: string;
  readonly personality: string;
  readonly language: string | null;
  readonly parameterContract: readonly GraderParameter[];
  readonly createdAt: Date;
};

export type EgmaProvidedPersona = {
  /** Fixed for the identity's whole life. */
  readonly id: string;
  /** The team's word for this persona, shown in lists. Never spoken. */
  readonly name: string;
  readonly description: string;
  readonly versions: readonly EgmaProvidedPersonaVersion[];
};

const EVERYDAY_CALLER_V1_CONTRACT = legacyPersonaParameterContract({
  mode: "separate",
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
  stt: { provider: "openai", model: "gpt-live-transcribe" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
});

const EVERYDAY_CALLER_V2_CONTRACT = legacyPersonaParameterContract({
  mode: "separate",
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
  stt: { provider: "openai", model: "gpt-live-transcribe" },
  tts: {
    provider: "openai",
    model: "gpt-4o-mini-tts-2025-12-15",
    voiceId: "alloy",
    speed: 1,
  },
});

const OPENAI_PERSONA_MODELS = {
  mode: "separate",
  llm: { provider: "openai", model: "gpt-4o-mini" },
  stt: { provider: "openai", model: "gpt-4o-mini-transcribe" },
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "cedar", speed: 1 },
} as const;

const everydayPersonality =
  "Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.";

/**
 * Every persona Egma provides.
 *
 * After launch, prior versions stay in this list. A change to core behavior
 * adds a new fixed version and makes it the last entry. Project execution
 * settings migrate on their own row and never mint a core version. This is what
 * lets a fresh installation understand a version that an older installation
 * pinned.
 */
export const PERSONA_LIBRARY_CATALOG: readonly EgmaProvidedPersona[] = [
  {
    id: EGMA_PROVIDED_PERSONAS.defaultPersona,
    /**
     * Display label for this Egma-provided persona. Tests must select personas explicitly.
     */
    name: "Everyday Caller [Male]",
    description: "Regular conversationalist persona",
    versions: [
      {
        id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
        version: 1,
        identityName: "Alex Morgan",
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        parameterContract: EVERYDAY_CALLER_V1_CONTRACT,
        createdAt: new Date("2026-08-19T23:09:01.674Z"),
      },
      {
        id: "prsv_01M2B0K7W8N9Q3R4T5V6X7Y8Z9",
        version: 2,
        identityName: "Alex Morgan",
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        parameterContract: EVERYDAY_CALLER_V2_CONTRACT,
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      },
      {
        id: "prsv_01K4R000000000000000000001",
        version: 3,
        identityName: "Alex Morgan",
        personality: everydayPersonality,
        language: null,
        parameterContract: ticket01PersonaParameterContract(OPENAI_PERSONA_MODELS),
        createdAt: new Date("2026-09-10T00:00:00.000Z"),
      },
      {
        id: "prsv_01K4R000000000000000000012",
        version: 4,
        identityName: "Alex Morgan",
        personality: everydayPersonality,
        language: null,
        parameterContract: ticket02PersonaParameterContract(OPENAI_PERSONA_MODELS),
        createdAt: new Date("2026-09-11T00:00:00.000Z"),
      },
      {
        id: "prsv_01K4R000000000000000000016",
        version: 5,
        identityName: "Alex Morgan",
        personality: everydayPersonality,
        language: null,
        parameterContract: preCategoricalPersonaParameterContract(OPENAI_PERSONA_MODELS),
        createdAt: new Date("2026-09-12T00:00:00.000Z"),
      },
    ],
  },
  {
    id: "prs_01K4R000000000000000000002",
    name: "Everyday Caller [Female]",
    description: "Regular conversationalist persona",
    versions: [{
      id: "prsv_01K4R000000000000000000003", version: 1,
      identityName: "Alex Morgan", personality: everydayPersonality, language: null,
      parameterContract: ticket01PersonaParameterContract({ ...OPENAI_PERSONA_MODELS, tts: { ...OPENAI_PERSONA_MODELS.tts, voiceId: "coral" } }),
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000013", version: 2,
      identityName: "Alex Morgan", personality: everydayPersonality, language: null,
      parameterContract: ticket02PersonaParameterContract({ ...OPENAI_PERSONA_MODELS, tts: { ...OPENAI_PERSONA_MODELS.tts, voiceId: "coral" } }),
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000017", version: 3,
      identityName: "Alex Morgan", personality: everydayPersonality, language: null,
      parameterContract: preCategoricalPersonaParameterContract({ ...OPENAI_PERSONA_MODELS, tts: { ...OPENAI_PERSONA_MODELS.tts, voiceId: "coral" } }),
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
    }],
  },
  {
    id: "prs_01K4R000000000000000000004",
    name: "Angry caller",
    description: "A caller who starts upset but remains coherent",
    versions: [{
      id: "prsv_01K4R000000000000000000005", version: 1,
      identityName: "Jordan Lee",
      personality: "Explains the problem directly and expects the agent to acknowledge the concern and provide a clear resolution.",
      language: null,
      parameterContract: ticket01PersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "en-US", emotion: "angry", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1 }),
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000014", version: 2,
      identityName: "Jordan Lee", personality: "Explains the problem directly and expects the agent to acknowledge the concern and provide a clear resolution.", language: null,
      parameterContract: ticket02PersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "en-US", emotion: "angry", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: 0.0631 }),
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000018", version: 3,
      identityName: "Jordan Lee", personality: "Explains the problem directly and expects the agent to acknowledge the concern and provide a clear resolution.", language: null,
      parameterContract: preCategoricalPersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "en-US", emotion: "angry", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: 0.0631, interruptionLevel: "off" }),
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
    }],
  },
  {
    id: "prs_01K4R000000000000000000006",
    name: "Spanish caller",
    description: "A regular conversationalist who starts in Spanish",
    versions: [{
      id: "prsv_01K4R000000000000000000007", version: 1,
      identityName: "Mateo García", personality: everydayPersonality, language: null,
      parameterContract: ticket01PersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "es-ES", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1 }),
      createdAt: new Date("2026-09-10T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000015", version: 2,
      identityName: "Mateo García", personality: everydayPersonality, language: null,
      parameterContract: ticket02PersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "es-ES", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: 0.0631 }),
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
    }, {
      id: "prsv_01K4R000000000000000000019", version: 3,
      identityName: "Mateo García", personality: everydayPersonality, language: null,
      parameterContract: preCategoricalPersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "es-ES", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: 0.0631, interruptionLevel: "off" }),
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
    }],
  },
  {
    id: EGMA_PROVIDED_PERSONAS.interruptiveCaller,
    name: "Interruptive caller",
    description: "A direct caller who gives brief, focused responses",
    versions: [{
      id: "prsv_01K4R000000000000000000020",
      version: 1,
      identityName: "Taylor Brooks",
      personality: "Keeps responses brief, direct, and relevant to the current topic.",
      language: null,
      parameterContract: preCategoricalPersonaParameterContract(OPENAI_PERSONA_MODELS, { language: "en-US", emotion: "neutral", accent: "voice_default", speechVolume: 1, executionPolicyVersion: 1, backgroundSoundId: "none", backgroundVolume: 0.0631, interruptionLevel: "frequent" }),
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
    }],
  },
];
