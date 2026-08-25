import {
  CARRIER_ROUTE_ENVIRONMENT,
  type CarrierRoute,
} from "./config.ts";

/**
 * Whether this platform can place a phone call, and what is missing when it
 * cannot.
 *
 * **Phone readiness is not platform readiness.** A deployment that has never
 * been given a carrier still runs chat simulations. This says only whether it
 * can place a phone call.
 *
 * The API reads the deployment environment once at startup. The complete route
 * stays in process configuration, never enters Postgres, and is handed only to
 * a simulator which claimed phone work.
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

export function phoneReadiness(
  carrier: CarrierRoute | undefined,
): PhoneReadiness {
  return {
    state: carrier === undefined ? "setup_required" : "ready",
    missing:
      carrier === undefined
        ? CARRIER_ROUTE_ENVIRONMENT.map(({ label }) => label)
        : [],
    trunkAddress: carrier?.trunkAddress ?? null,
    sourceNumber: carrier?.sourceNumber ?? null,
  };
}

/**
 * What a developer is told when they ask this platform for a phone run before
 * its phone half exists. It names the operator-owned variables without
 * assuming whether the deployment is self-hosted or hosted.
 */
export function phoneSetupRequiredMessage(readiness: PhoneReadiness): string {
  return (
    "this Egma instance has not been configured to place phone calls, so nothing was " +
    `dialled and nothing was charged. It is missing ${readiness.missing.join(
      " and ",
    )}. Add EGMA_PHONE_TRUNK_ADDRESS, EGMA_PHONE_SOURCE_NUMBER, ` +
    "EGMA_PHONE_TRUNK_USERNAME and EGMA_PHONE_TRUNK_PASSWORD to the deployment " +
    "environment, then ask the deployment operator to restart the API."
  );
}
