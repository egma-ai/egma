/**
 * Whether this platform can place a phone call, and what is missing when it
 * cannot.
 *
 * **Platform readiness and phone readiness are two facts, not one.** A
 * deployment that has never been given a carrier still runs chat and text
 * simulations perfectly well, and saying it is unhealthy for that would be a
 * lie that stops a first-run story dead. So `self-host up` brings a platform up
 * *ready*, and this says separately whether the phone half has been set up.
 *
 * **Everything here is non-secret, and that is deliberate.** The facts are the
 * carrier's own hostname, the number a call appears to come from, and which
 * speech provider was configured — three things a caller sees on their handset
 * or an invoice, and none of which opens anything. The Twilio Auth Token, the
 * SIP password and the OpenAI key reach the containers that need them and
 * never this module, so no answer built here can leak one.
 */

/** What a platform's phone half can be. */
export type PhoneState = "ready" | "setup_required";

export type PhoneReadiness = {
  readonly state: PhoneState;
  /**
   * What phone setup has not supplied yet, by the name a person would use.
   * Empty when the state is `ready`. Named rather than counted, because
   * "setup required" with nothing after it sends a self-hoster to read source.
   */
  readonly missing: readonly string[];
  /** The carrier hostname a call is routed through. Non-secret. */
  readonly trunkAddress: string | null;
  /** The number a call appears to come from, E.164. Non-secret. */
  readonly sourceNumber: string | null;
  /** Which speech provider the persona speaks and listens with. Non-secret. */
  readonly speechProvider: string | null;
};

/**
 * The three things phone setup leaves behind on the platform, and the names a
 * refusal uses for them.
 *
 * A trunk with no source number places a call the carrier refuses; a carrier
 * with no speech provider places a call nobody can talk on. Neither is *nearly*
 * ready, so a partial answer is still `setup_required` — and it says which
 * half, because the one thing worse than "not ready" is "not ready" with no
 * indication of what to do.
 */
export const PHONE_SETUP_FACTS = {
  trunkAddress: "the carrier trunk",
  sourceNumber: "the source number",
  speechProvider: "the speech provider",
} as const;

export type PhoneSettings = {
  readonly trunkAddress: string | null;
  readonly sourceNumber: string | null;
  readonly speechProvider: string | null;
};

export function phoneReadiness(settings: PhoneSettings): PhoneReadiness {
  const missing = (
    Object.keys(PHONE_SETUP_FACTS) as (keyof typeof PHONE_SETUP_FACTS)[]
  )
    .filter((fact) => settings[fact] === null)
    .map((fact) => PHONE_SETUP_FACTS[fact]);

  return {
    state: missing.length === 0 ? "ready" : "setup_required",
    missing,
    trunkAddress: settings.trunkAddress,
    sourceNumber: settings.sourceNumber,
    speechProvider: settings.speechProvider,
  };
}

/**
 * What a developer is told when they ask this platform for a phone run before
 * its phone half exists.
 *
 * Written for whoever is holding the terminal, which on a self-host is the same
 * person who runs the platform and on a hosted one is not: it names the command
 * and it names what that command still needs.
 */
export function phoneSetupRequiredMessage(readiness: PhoneReadiness): string {
  return (
    "this egma has not been set up to place phone calls, so nothing was " +
    `dialled and nothing was charged. It is missing ${readiness.missing.join(
      " and ",
    )}. Whoever runs this platform makes it ready with one command in the ` +
    "platform workspace: egma self-host phone setup."
  );
}
