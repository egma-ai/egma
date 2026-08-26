import {
  RECOMMENDED_PERSONA_MODELS,
  type PersonaModels,
} from "../models/selections.ts";
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
   * itself as "Default Persona" would be worse than either.
   */
  readonly identityName: string;
  readonly personality: string;
  readonly language: string;
  readonly models: PersonaModels;
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

const DEFAULT_PERSONA_MODELS: PersonaModels = {
  ...RECOMMENDED_PERSONA_MODELS,
  llm: {
    provider: "openai",
    model: "gpt-5.6-terra",
  },
};

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
    name: "Default Persona",
    description: "Regular conversationalist persona",
    versions: [
      {
        id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
        version: 1,
        identityName: "Alex Morgan",
        personality:
          "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
        language: "en-US",
        models: DEFAULT_PERSONA_MODELS,
        createdAt: new Date("2026-08-19T23:09:01.674Z"),
      },
    ],
  },
];
