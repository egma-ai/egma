import {
  RECOMMENDED_PERSONA_MODELS,
} from "../models/selections.ts";
import { legacyPersonaParameterContract, personaParameterContract } from "./parameters.ts";
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
  ...RECOMMENDED_PERSONA_MODELS,
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
});

const EVERYDAY_CALLER_V2_CONTRACT = legacyPersonaParameterContract({
  ...RECOMMENDED_PERSONA_MODELS,
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
});

/**
 * Every persona Egma provides.
 *
 * After launch, prior versions stay in this list. A change to behavior or
 * execution adds a new fixed version and makes it the last entry. This is what
 * lets a fresh installation understand a version that an older installation
 * pinned.
 */
export const PERSONA_LIBRARY_CATALOG: readonly EgmaProvidedPersona[] = [
  {
    id: EGMA_PROVIDED_PERSONAS.defaultPersona,
    /**
     * Display label for this Egma-provided persona. Tests must select personas explicitly.
     */
    name: "Everyday caller",
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
    ],
  },
];
