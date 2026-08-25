import {
  RECOMMENDED_PERSONA_MODELS,
  type PersonaModels,
} from "../models/selections.ts";
import { EGMA_PROVIDED_PERSONAS } from "./ids.ts";

export { EGMA_PROVIDED_PERSONAS } from "./ids.ts";

/**
 * Human facts only. Provider, model, voice id and speed live in `models`.
 *
 * The optional facts are absent when nobody stated them. An empty string is
 * normalized to absence at the authoring boundary.
 */
export type PersonaTraits = {
  readonly personality: string;
  readonly language: string;
  /** Where they sound like they are from. */
  readonly accent?: string | undefined;
  /** What is going on around them while they talk. */
  readonly backgroundNoise?: string | undefined;
};

export type EgmaProvidedPersonaVersion = {
  /**
   * Fixed after launch. A later catalog edit adds a new id; only an explicit
   * pre-launch migration may rewrite this row in place.
   */
  readonly id: string;
  readonly version: number;
  readonly traits: PersonaTraits;
  readonly models: PersonaModels;
  readonly createdAt: Date;
};

export type EgmaProvidedPersona = {
  /** Fixed for the identity's whole life. */
  readonly id: string;
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
        traits: {
          personality:
            "Speaks clear, natural English. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
          language: "en-US",
          accent: "Neutral American English.",
          backgroundNoise: "None.",
        },
        models: DEFAULT_PERSONA_MODELS,
        createdAt: new Date("2026-08-19T23:09:01.674Z"),
      },
    ],
  },
];
