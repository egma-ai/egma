import {
  PLATFORM_SETTINGS,
  type PlatformFacts,
  type PlatformSettingName,
} from "@egma/db";

/**
 * Whether this platform holds its optional carrier route, and what is missing.
 *
 * The platform store owns only the phone carrier route. Persona and grader
 * versions own model choices, and the deployment credential source owns
 * provider keys, so neither can appear in this answer.
 *
 * Everything in the answer is non-secret. It names missing carrier fields in
 * the words a person uses and never carries a secret value. The one door to the
 * stored SIP password is the phone work order a simulator claims.
 *
 * `setup` and `phone` remain separate fields in the public platform response.
 * Both read the same carrier store, so they cannot drift between Postgres and
 * one container's environment.
 */

export type PlatformSetupState = "ready" | "setup_required";

export type PlatformReadiness = {
  readonly state: PlatformSetupState;
  /**
   * What setup has not supplied yet, by the name a person would use. Empty when
   * the state is `ready`. Named rather than counted, because "setup required"
   * with nothing after it sends a self-hoster to read source.
   */
  readonly missing: readonly string[];
};

/**
 * The words one setting is named in, read off the catalog rather than restated.
 *
 * One place, because two readiness answers name the same settings and a second
 * copy of the words is a second copy to drift.
 */
export function labelOf(name: PlatformSettingName): string {
  const definition = PLATFORM_SETTINGS.find(
    (setting) => setting.name === name,
  );
  // Unreachable while the argument is a `PlatformSettingName`, and kept because
  // the alternative is a readiness answer naming `undefined` to a self-hoster.
  return definition?.label ?? name;
}

/**
 * Whether this platform holds a setting at all.
 *
 * **One predicate, and both readiness answers ask it.** The question is
 * *presence*, and `platformFacts` answers `null` for every setting the catalog
 * marks secret — so a reader that tested the value instead would read every
 * secret as absent forever, and would start doing it to a phone fact the day
 * one becomes a secret. Asking about the key rather than the
 * value is what makes that impossible rather than merely unlikely.
 */
export function holds(held: PlatformFacts, name: PlatformSettingName): boolean {
  return Object.hasOwn(held, name);
}

/**
 * The platform's answer, from what its store holds.
 *
 * The carrier catalog is the complete list. No model, voice or provider-key
 * setting can become a second readiness requirement here.
 */
export function platformReadiness(held: PlatformFacts): PlatformReadiness {
  const missing = PLATFORM_SETTINGS.filter(
    (setting) => setting.required && !holds(held, setting.name),
  ).map((setting) => setting.label);

  return {
    state: missing.length === 0 ? "ready" : "setup_required",
    missing,
  };
}
