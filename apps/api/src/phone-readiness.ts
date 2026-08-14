import type { PlatformFacts, PlatformSettingName } from "@egma/db";

import { holds, labelOf } from "./platform-readiness.ts";

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
 * **It is read from the platform's own store rather than from this process's
 * environment**, and that move is what makes the answer recoverable. The three
 * facts used to arrive as environment variables of this container, so a
 * platform started any other way than through the CLI reported `setup required`
 * with the carrier paperwork already done — and the only way back was to find
 * the file and restart. They are ordinary settings now: an operator who supplies
 * a missing one is ready on the next request, with nothing restarted.
 *
 * **Everything here is non-secret, and that is deliberate.** The facts are the
 * carrier's own hostname, the number a call appears to come from, and which
 * speech provider was configured — three things a caller sees on their handset
 * or an invoice, and none of which opens anything. The trunk password and the
 * provider keys are sealed in the same store and reach only the work order a
 * simulator claims; `platformFacts` answers `null` for every one of them, so no
 * answer built here can carry one even by accident.
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
 * The three things the phone half stands on, as the platform stores them and
 * as a refusal names them.
 *
 * A trunk with no source number places a call the carrier refuses; a carrier
 * with no speech provider places a call nobody can talk on. Neither is *nearly*
 * ready, so a partial answer is still `setup_required` — and it says which
 * half, because the one thing worse than "not ready" is "not ready" with no
 * indication of what to do.
 *
 * The label is not restated here: the settings catalog already carries the
 * words each setting is named in, and a second copy of them is a second copy to
 * disagree. What this holds is only which settings the phone half needs, and
 * which reported fact each one fills.
 */
export const PHONE_SETUP_FACTS = {
  trunkAddress: "carrier_trunk_address",
  sourceNumber: "carrier_trunk_number",
  // The persona's mouth, which is also its ears on every deployment that
  // configured one account for both. It is the one of the two legs a caller
  // would notice, which is what makes it the fact worth reporting.
  speechProvider: "text_to_speech_provider",
} as const satisfies Record<string, PlatformSettingName>;

export function phoneReadiness(held: PlatformFacts): PhoneReadiness {
  const fact = (
    which: keyof typeof PHONE_SETUP_FACTS,
  ): string | null => held[PHONE_SETUP_FACTS[which]] ?? null;

  // Asked with the same predicate the whole-platform answer asks, and never
  // of the value: `platformFacts` answers `null` for every setting the catalog
  // marks secret, so the day one of these three becomes a secret a value test
  // would read it as absent forever. See `holds`.
  const missing = (
    Object.keys(PHONE_SETUP_FACTS) as (keyof typeof PHONE_SETUP_FACTS)[]
  )
    .filter((which) => !holds(held, PHONE_SETUP_FACTS[which]))
    .map((which) => labelOf(PHONE_SETUP_FACTS[which]));

  return {
    state: missing.length === 0 ? "ready" : "setup_required",
    missing,
    trunkAddress: fact("trunkAddress"),
    sourceNumber: fact("sourceNumber"),
    speechProvider: fact("speechProvider"),
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
