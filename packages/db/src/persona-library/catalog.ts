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
   * itself by its catalog name would be worse than either.
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

const SHELF_PERSONA_MODELS: PersonaModels = {
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
    /**
     * The team's word for the persona every project starts with.
     *
     * It was "Default Persona" until the default-persona pointer was deleted,
     * and the name then claimed a role the product no longer has: nothing is a
     * default any more, so a row saying so would be the last surface still
     * advertising it. "Everyday caller" is what this persona is — the ordinary
     * one, for the scenario that needs a person rather than a particular
     * person. Catalog content, so a later change is a change of copy and not a
     * change of behavior.
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
        models: SHELF_PERSONA_MODELS,
        createdAt: new Date("2026-08-19T23:09:01.674Z"),
      },
    ],
  },
];
