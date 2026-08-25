import {
  PLATFORM_SETTINGS,
  type PlatformFacts,
  type PlatformSettingName,
} from "@egma/db";

/**
 * Whether this platform can place a phone call, and what is missing when it
 * cannot.
 *
 * **Phone readiness is not platform readiness.** A deployment that has never
 * been given a carrier still runs chat simulations. `self-host up`
 * brings that platform up ready, and this says only whether it can place a
 * phone call.
 *
 * The API reads the sealed runtime copy. On self-host, the operator's `.env`
 * file owns that copy and `egma self-host up` reconciles a complete supplied
 * route when the API starts. This keeps the SIP password out of responses and
 * still gives the operator one configuration surface.
 *
 * This is an internal run-start precondition, not a public readiness response.
 * Everything returned here is non-secret: the carrier hostname and the number
 * a call appears to come from. Speech configuration comes from the pinned
 * persona version plus the deployment credential source.
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
 * The two internal facts the phone half stands on, as the platform stores them
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

/** Required route members, derived from the platform catalog that owns them. */
const REQUIRED_PHONE_SETTINGS = PLATFORM_SETTINGS.filter(
  (setting) => setting.required,
);

/**
 * Whether the store holds a setting at all.
 *
 * Presence is the fact because `platformFacts` returns `null` for a secret
 * value. Testing the value would report every secret setting as missing.
 */
function holds(held: PlatformFacts, name: PlatformSettingName): boolean {
  return Object.hasOwn(held, name);
}

export function phoneReadiness(held: PlatformFacts): PhoneReadiness {
  const fact = (
    which: keyof typeof PHONE_SETUP_FACTS,
  ): string | null => held[PHONE_SETUP_FACTS[which]] ?? null;

  // Ask about presence, never the value: `platformFacts` answers `null` for a
  // secret, so a value test would read a secret setting as absent forever.
  const missing = REQUIRED_PHONE_SETTINGS.filter(
    (setting) => !holds(held, setting.name),
  ).map((setting) => setting.label);

  return {
    state: missing.length === 0 ? "ready" : "setup_required",
    missing,
    trunkAddress: fact("trunkAddress"),
    sourceNumber: fact("sourceNumber"),
  };
}

/**
 * What a developer is told when they ask this platform for a phone run before
 * its phone half exists. It names the operator-owned variables and the normal
 * start command rather than a second setup workflow.
 */
export function phoneSetupRequiredMessage(readiness: PhoneReadiness): string {
  return (
    "this Egma instance has not been configured to place phone calls, so nothing was " +
    `dialled and nothing was charged. It is missing ${readiness.missing.join(
      " and ",
    )}. Add EGMA_PHONE_TRUNK_ADDRESS and EGMA_PHONE_SOURCE_NUMBER to the ` +
    "platform workspace's .env file. When the carrier uses SIP credentials, " +
    "also add EGMA_PHONE_TRUNK_USERNAME and EGMA_PHONE_TRUNK_PASSWORD. Then run " +
    "egma self-host up."
  );
}
