import type { ConnectionType, Modality } from "../schema/agents.ts";
import { UnknownCapabilityError } from "./errors.ts";

/**
 * What a target can do, and who is allowed to say so.
 *
 * **A capability is a measured fact about one target, never an author's
 * claim.** A test declares what it *needs* in order to be meaningful — DTMF
 * entry, barge-in, raw audio — and a connection records what its target was
 * *found* to have. Where the two disagree the simulation is skipped with a
 * reason, which is a different thing from a failure and must never be reported
 * as one: a test that could not run says nothing about the agent.
 *
 * Two rules hold that line, and both live here:
 *
 * - **One catalog, server-owned.** Test forms and connection forms draw their
 *   capability names from this list and nowhere else, and a key that is not on
 *   it is refused rather than stored. A free-text capability would let two
 *   people write `dtmf` and `DTMF` and would make every comparison between a
 *   requirement and a measurement a guess.
 * - **Only an adapter writes a measurement.** Discovery is a read-only
 *   operation an adapter performs against a real target. An adapter that cannot
 *   prove a fact leaves it unknown; it never infers support from the provider's
 *   brand, because "Retell supports DTMF" is a sentence about a company and the
 *   question is about one agent behind one connection.
 */

export type CapabilityEntry = {
  /** The stable key. Stored on tests, stored on connections, never renamed. */
  readonly key: string;
  /** What a form shows beside the checkbox. */
  readonly label: string;
  /** What the capability means, in one sentence a test author can act on. */
  readonly description: string;
};

/**
 * The catalog. It grows one entry at a time and an entry never leaves — a key
 * stored on a test written last year has to keep meaning what it meant.
 */
export const CAPABILITY_CATALOG: readonly CapabilityEntry[] = [
  {
    key: "dtmf",
    label: "DTMF entry",
    description:
      "The caller can press digits during the conversation, so a test can walk a phone menu or enter an account number.",
  },
  {
    key: "barge_in",
    label: "Barge-in",
    description:
      "The caller can interrupt the agent mid-sentence and the agent stops speaking, so a test can check what happens under interruption.",
  },
  {
    key: "raw_audio",
    label: "Raw audio",
    description:
      "The conversation's audio is available to Egma, so audio graders and recording playback have something to read.",
  },
] as const;

export const CAPABILITY_KEYS: readonly string[] = CAPABILITY_CATALOG.map(
  (entry) => entry.key,
);

export function isCapabilityKey(key: string): boolean {
  return CAPABILITY_KEYS.includes(key);
}

/**
 * The catalog's own refusal for a key nobody offered.
 *
 * It names the key and points at the editor, because the caller is either a
 * person who typed one or a client that invented one, and both are fixed by
 * choosing from what the editor offers.
 */
export function unknownCapabilityMessage(key: string): string {
  return (
    `Capability ${key} is not in this Egma capability catalog. Choose a ` +
    `capability offered by the test editor and save the test again.`
  );
}

/**
 * Every key checked against the catalog, answered in the order they arrived
 * with duplicates removed.
 *
 * **This is the door a test's required capabilities walk through**, and the
 * only one: `validContent` in `tests.ts` calls it on every version it is about
 * to write, whether the keys were typed by an author or carried forward from
 * the version before. The rule and its sentence live here because the catalog
 * does, and because a second copy written next to the test editor would be a
 * second opinion about which keys exist. The first unknown key refuses the
 * whole set — a partial save would be egma quietly deciding which half of
 * somebody's requirement mattered.
 */
export function admittedCapabilities(
  keys: readonly string[],
): readonly string[] {
  const admitted: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string" || !isCapabilityKey(key)) {
      throw new UnknownCapabilityError(
        String(key),
        unknownCapabilityMessage(String(key)),
      );
    }
    if (!admitted.includes(key)) admitted.push(key);
  }
  return admitted;
}

/**
 * What one connection is known to be able to do — or the fact that nobody has
 * looked.
 *
 * The two states are separate because they lead somewhere different. `unknown`
 * is a Refresh away from an answer; a `known` state whose list omits a key is a
 * settled fact about the target. Collapsing them into an empty list would make
 * a connection nobody has measured look exactly like one measured and found
 * bare.
 */
export type ConnectionCapabilities =
  | { readonly state: "unknown" }
  | {
      readonly state: "known";
      /**
       * The catalog keys the adapter looked at. A key outside this set was not
       * examined, whatever else the record says.
       */
      readonly measured: readonly string[];
      /** The measured keys it found. Always a subset of `measured`. */
      readonly supported: readonly string[];
      readonly checkedAt: Date;
      /** Which adapter measured it. Evidence travels with the answer. */
      readonly source: string;
    };

/**
 * What this record says about one capability. Three answers, never two.
 *
 * **`unsupported` and `not_measured` must never be collapsed**, and this
 * function is where that is enforced for every reader. They are a settled fact
 * about the target and an unasked question, they carry the product's two
 * different skip reasons, and they have different fixes: one means write a
 * different test, the other means measure the connection. An absent key
 * defaulting to `unsupported` would put a false reason on every simulation an
 * adapter's blind spot touched.
 */
export const CAPABILITY_STANDINGS = [
  "supported",
  "unsupported",
  "not_measured",
] as const;
export type CapabilityStanding = (typeof CAPABILITY_STANDINGS)[number];

export function capabilityStanding(
  held: ConnectionCapabilities,
  key: string,
): CapabilityStanding {
  if (held.state !== "known") return "not_measured";
  if (held.supported.includes(key)) return "supported";
  // The whole point: absent from `supported` is only an absence when the
  // adapter looked. Otherwise nobody has asked.
  return held.measured.includes(key) ? "unsupported" : "not_measured";
}

/** The state every connection starts in, and returns to when its config moves. */
export const CAPABILITIES_UNKNOWN: ConnectionCapabilities = { state: "unknown" };

/**
 * What an adapter is asked, and what it answers.
 *
 * It is handed the non-secret target description and nothing else. A discovery
 * that needed the sealed credential would be a second door to the plaintext,
 * and there is exactly one of those in this codebase — the dispatch path's, and
 * it opens only for egma's own simulator. Where a real check needs a
 * credential, the adapter is the simulator's and reports through it; this seam
 * is for what can be established from the target's own description.
 */
export type DiscoveryTarget = {
  readonly type: ConnectionType;
  readonly variantId: string;
  /**
   * Which layer this connection puts under test — and the fact that settles
   * most of what egma's own transport can do. Chat carries text and voice
   * carries audio, so a question like "is there audio to grade" is answered by
   * this and not by the provider's name.
   */
  readonly modality: Modality;
  readonly config: Readonly<Record<string, string>>;
};

/**
 * What an adapter reports: the catalog keys it examined, and which of those it
 * found.
 *
 * **Both halves, because one cannot be derived from the other.** An adapter
 * that answered only what it found would leave every reader guessing whether a
 * missing key was absent or unexamined — which is exactly the collapse this
 * record exists to prevent. An adapter that can speak to a capability says so
 * by naming it in `measured`, whichever way the answer came out.
 */
export type Discovered = {
  readonly measured: readonly string[];
  readonly supported: readonly string[];
};

/**
 * A discovery answers what it examined and what it found. Throwing means it
 * could not establish anything, which leaves the connection's state exactly as
 * it was — unknown stays unknown, and a previous measurement is not overwritten
 * with a failure.
 */
export type CapabilityDiscovery = (
  target: DiscoveryTarget,
) => Promise<Discovered>;

/**
 * Which types egma ships a discovery adapter for.
 *
 * It is a map rather than a flag on the descriptor because the descriptor is
 * *what a connection is* and this is *what egma can do about one*, and because
 * a test proving the recording path needs to stand an adapter up without
 * rewriting the registry.
 */
const DISCOVERIES = new Map<ConnectionType, CapabilityDiscovery>();

/**
 * What egma's own transport settles, for every type it can reach at all.
 *
 * **This is not brand inference, and the distinction is the whole reason it is
 * allowed to exist.** "Retell supports DTMF" is a sentence about a company and
 * egma has no business asserting it. "Egma cannot press a digit over any
 * transport it ships" is a sentence about egma's own code, checkable by reading
 * it, and true of the target *as egma will reach it* — which is exactly what a
 * capability is for: deciding whether a test can be meaningfully run.
 *
 * Two facts, from the simulator as it stands:
 *
 * - **`raw_audio` follows the modality.** A voice simulation holds PCM in both
 *   directions, so there is audio for an audio grader to read and for a
 *   recording to be made from. A chat simulation is text end to end and there
 *   is none — not "not yet", none.
 * - **`dtmf` is unsupported everywhere**, because nothing in the simulator can
 *   send a digit over any transport. Saying so is worth far more than leaving
 *   it unknown: a test that needs to walk a phone menu is skipped with a reason
 *   somebody can act on, rather than skipped because nobody has looked.
 *
 * **`barge_in` is deliberately not answered here**, because it is not a fact
 * about the transport: it asks whether *the customer's agent* stops speaking
 * when interrupted, and only a probe of that agent can say. See the note on
 * `measuredCapabilities` for what its absence currently means.
 */
export const transportCapabilities: CapabilityDiscovery = async (target) => ({
  // The two it can speak to, named whichever way each answer comes out — and
  // `barge_in` deliberately not among them, so a reader is told nobody asked
  // rather than told it is missing.
  measured: ["raw_audio", "dtmf"],
  supported: target.modality === "voice" ? ["raw_audio"] : [],
});

// Registered for every type, because the facts above hold for every transport
// egma ships. A type added later without an adapter of its own is refused a
// Refresh in its own words, which is what `noCapabilityAdapterMessage` is for.
for (const type of ["retell", "phone", "livekit"] as const) {
  DISCOVERIES.set(type, transportCapabilities);
}

export function capabilityDiscoveryFor(
  type: ConnectionType,
): CapabilityDiscovery | undefined {
  return DISCOVERIES.get(type);
}

export function hasCapabilityDiscovery(type: ConnectionType): boolean {
  return DISCOVERIES.has(type);
}

/**
 * Installs the adapter for a type, answering the one it replaced so a caller
 * can put things back. Shipped adapters register at module load; a test
 * registers one and restores it afterwards.
 */
export function registerCapabilityDiscovery(
  type: ConnectionType,
  discovery: CapabilityDiscovery | undefined,
): CapabilityDiscovery | undefined {
  const previous = DISCOVERIES.get(type);
  if (discovery === undefined) DISCOVERIES.delete(type);
  else DISCOVERIES.set(type, discovery);
  return previous;
}

/**
 * What a caller is told when they ask egma to measure a type nothing can
 * measure.
 *
 * Its own sentence rather than a general refusal, because the next move is
 * neither to fix the request nor to try again: there is nothing to try. It says
 * what the connection's state stays, so nobody reads the refusal as having
 * cleared a measurement.
 */
export function noCapabilityAdapterMessage(type: ConnectionType): string {
  return (
    `Egma has no capability adapter for a ${type} connection, so it cannot ` +
    `measure what this target supports. Its capability state stays unknown, ` +
    `and a test that requires a capability is skipped with a reason rather ` +
    `than failed.`
  );
}

/**
 * What a caller is told when the adapter ran and could not establish anything.
 *
 * The exact sentence the product's refusal table names, because a client shows
 * it unchanged.
 */
export function capabilityCheckFailedMessage(connectionId: string): string {
  return (
    `Egma could not check capabilities for connection ${connectionId}. Its ` +
    `capability state remains unknown; check the connection settings and try ` +
    `Refresh capabilities again.`
  );
}

/**
 * An adapter's answer, held to the catalog and to itself before it can be
 * stored.
 *
 * Two rules, and both are about keeping the three answers readable. A key egma
 * does not have is a bug in the adapter and is refused rather than dropped: it
 * would put a capability on a connection that no test could ever require. And a
 * key reported found but not examined is refused too — evidence with no
 * observation under it, which would make `supported` and `measured` disagree
 * about what happened.
 */
export function measuredCapabilities(
  found: Discovered,
  source: string,
  checkedAt: Date,
): ConnectionCapabilities {
  const admit = (keys: readonly string[], half: string): readonly string[] => {
    const held: string[] = [];
    for (const key of keys) {
      if (!isCapabilityKey(key)) {
        throw new Error(
          `capability adapter ${source} answered "${key}" among the keys it ` +
            `${half}, which is not in Egma's capability catalog ` +
            `(${CAPABILITY_KEYS.join(", ")})`,
        );
      }
      if (!held.includes(key)) held.push(key);
    }
    return held;
  };

  const measured = admit(found.measured, "measured");
  const supported = admit(found.supported, "found");

  for (const key of supported) {
    if (!measured.includes(key)) {
      throw new Error(
        `capability adapter ${source} reported "${key}" as supported without ` +
          `measuring it; a capability is found by looking for it`,
      );
    }
  }

  return { state: "known", measured, supported, checkedAt, source };
}
