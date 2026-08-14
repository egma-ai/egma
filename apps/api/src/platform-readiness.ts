import {
  PLATFORM_SETTINGS,
  type PlatformFacts,
  type PlatformSettingName,
} from "@egma/db";

/**
 * Whether this platform has been set up, and what it is still missing.
 *
 * **Readiness stopped being a fact about the phone alone.** The settings a
 * deployment needs used to live in a file beside it that only the CLI read, and
 * a platform started any other way had none of them — the phone, the persona's
 * model, the speech providers, all absent at once, and each absence surfacing
 * minutes later as a failure naming nothing about configuration. So the
 * platform answers for its whole configuration here, reading what it holds from
 * its own store rather than from this process's environment.
 *
 * **Everything in the answer is non-secret, and that is what lets it be
 * answered at the one door that asks for no credential.** It names which
 * settings are absent, in the words a person would use — "the persona's model
 * key" rather than a column name — and it never carries a value that any
 * setting marked secret holds. The one door to a stored secret is the work
 * order a simulator claims, and it is nowhere near this.
 *
 * **This and phone readiness are two facts, not one.** A platform with no
 * carrier still runs chat and text simulations perfectly well, so `phone` keeps
 * answering separately and the run door keeps gating on it alone. What this
 * adds is the whole-platform answer beside it: `setup required` while anything
 * at all is missing, the carrier included. Both now read the same store, so
 * they can no longer be a fact about the deployment and a fact about one
 * container that quietly disagree.
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
 * The platform's answer, from what its store holds.
 *
 * The carrier is among the settings now, so this is one list over one source
 * rather than a composition of two. That is what closes the gap the effort
 * started from: there is no half of this answer left that a container could
 * hold and lose.
 */
export function platformReadiness(held: PlatformFacts): PlatformReadiness {
  const missing = PLATFORM_SETTINGS.filter(
    (setting) => !Object.hasOwn(held, setting.name),
  ).map((setting) => setting.label);

  return {
    state: missing.length === 0 ? "ready" : "setup_required",
    missing,
  };
}
