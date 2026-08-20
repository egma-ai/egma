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
 * environment**, and that move is what makes the answer recoverable. The route
 * used to arrive as environment variables of this container, so a
 * platform started any other way than through the CLI reported `setup required`
 * with the carrier paperwork already done — and the only way back was to find
 * the file and restart. They are ordinary settings now: an operator who supplies
 * a missing one is ready on the next request, with nothing restarted.
 *
 * **Everything returned here is non-secret.** The facts are the carrier's
 * hostname and the number a call appears to come from. Speech readiness comes
 * from the pinned persona version plus the deployment credential source.
 */

/** What a platform's phone half can be. */
export type PhoneState = "ready" | "setup_required";

export type PhoneReadiness = {
  readonly state: PhoneState;
  /**
   * What setup has not supplied yet, by the name a person would use.
   * Empty when the state is `ready`. Named rather than counted, because
   * "setup required" with nothing after it sends a self-hoster to read source.
   */
  readonly missing: readonly string[];
  /** The carrier hostname a call is routed through. Non-secret. */
  readonly trunkAddress: string | null;
  /** The number a call appears to come from, E.164. Non-secret. */
  readonly sourceNumber: string | null;
};

/**
 * The two public facts the phone half stands on, as the platform stores them
 * and as a refusal names them.
 *
 * A trunk with no source number places a call the carrier refuses. The store
 * accepts only a complete two-value source-IP route or a complete four-value
 * credential route, so readiness does not preserve or diagnose older partial
 * SIP shapes.
 *
 * The label is not restated here: the settings catalog already carries the
 * words each setting is named in, and a second copy of them is a second copy to
 * disagree. What this holds is only which settings the phone half needs, and
 * which reported fact each one fills.
 */
export const PHONE_SETUP_FACTS = {
  trunkAddress: "carrier_trunk_address",
  sourceNumber: "carrier_trunk_number",
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
    "this Egma instance has not been set up to place phone calls, so nothing was " +
    `dialled and nothing was charged. It is missing ${readiness.missing.join(
      " and ",
    )}. Whoever runs this platform makes it ready with one command in the ` +
    "platform workspace: egma self-host setup."
  );
}
