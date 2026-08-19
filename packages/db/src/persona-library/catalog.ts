/**
 * The speech facts stored beside a persona's authored personality.
 *
 * They are system-owned. A customer does not write them through persona
 * authoring. Keeping them in the immutable version lets the simulator render
 * the same voice for an old run after the platform's defaults move.
 */
export const VOICE_PROVIDERS = ["elevenlabs", "cartesia", "openai"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export type PersonaTraits = {
  readonly personality: string;
  readonly language: string;
  readonly voice: {
    readonly provider: VoiceProvider;
    readonly voiceId: string;
    readonly speed: number;
  };
  /** @deprecated Historical versions may carry these described traits. */
  readonly manner?: string | undefined;
  /** @deprecated Historical versions may carry these described traits. */
  readonly patience?: string | undefined;
  /** @deprecated Historical versions may carry these described traits. */
  readonly accent?: string | undefined;
  /** @deprecated Historical versions may carry these described traits. */
  readonly backgroundNoise?: string | undefined;
  /** @deprecated Historical versions may carry these described traits. */
  readonly underFriction?: string | undefined;
};

export type PredefinedPersonaVersion = {
  /** Fixed forever. A catalog edit adds a new id; it never changes this row. */
  readonly id: string;
  readonly version: number;
  readonly traits: PersonaTraits;
  readonly createdAt: Date;
};

export type PredefinedPersona = {
  /** Fixed for the identity's whole life. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly versions: readonly PredefinedPersonaVersion[];
};

/** Stable identities other modules may point at. Never replace these ids. */
export const PREDEFINED_PERSONAS = {
  defaultPersona: "prs_01M0E4EVJ6ECGVJEA4NSBTC0CC",
} as const;

/**
 * Every predefined persona Egma ships.
 *
 * Prior versions stay in this list. A change to personality or speech adds a
 * new fixed version and makes it the last entry. This is what lets a fresh
 * installation understand a version that an older installation pinned.
 */
export const PERSONA_LIBRARY_CATALOG: readonly PredefinedPersona[] = [
  {
    id: PREDEFINED_PERSONAS.defaultPersona,
    name: "Default Persona",
    description: "Regular conversationalist persona",
    versions: [
      {
        id: "prsv_01M0E4J0BBE1FVDVTZ1BSS5C97",
        version: 1,
        traits: {
          personality:
            "Speaks clear, natural english. Starts patient and cooperative, answers one question at a time, and becomes firmer if the agent is confusing or repetitive without becoming rude.",
          language: "en-US",
          voice: {
            provider: "elevenlabs",
            voiceId: "EXAVITQu4vr4xnSDxMaL",
            speed: 1,
          },
        },
        createdAt: new Date("2026-08-19T23:09:01.674Z"),
      },
    ],
  },
];

/** The system speech profile for a newly authored project persona. */
export const DEFAULT_PERSONA_SPEECH: Pick<
  PersonaTraits,
  "language" | "voice"
> = {
  language: "en-US",
  voice: {
    provider: "elevenlabs",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    speed: 1,
  },
};
