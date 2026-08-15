import type { ConnectionType } from "../schema/agents.ts";
import { UnprocessableInputError } from "./errors.ts";

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
 * with duplicates removed. The first unknown key refuses the whole set — a
 * partial save would be egma quietly deciding which half of somebody's
 * requirement mattered.
 */
export function admittedCapabilities(
  keys: readonly string[],
): readonly string[] {
  const admitted: string[] = [];
  for (const key of keys) {
    if (!isCapabilityKey(key)) {
      throw new UnprocessableInputError(unknownCapabilityMessage(key));
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
      /** Catalog keys the adapter found. Anything absent is unsupported. */
      readonly supported: readonly string[];
      readonly checkedAt: Date;
      /** Which adapter measured it. Evidence travels with the answer. */
      readonly source: string;
    };

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
  readonly config: Readonly<Record<string, string>>;
};

/**
 * A discovery answers the catalog keys it *found*. Throwing means it could not
 * establish anything, which leaves the connection's state exactly as it was —
 * unknown stays unknown, and a previous measurement is not overwritten with a
 * failure.
 */
export type CapabilityDiscovery = (
  target: DiscoveryTarget,
) => Promise<readonly string[]>;

/**
 * Which types egma ships a discovery adapter for.
 *
 * **Empty today, and that is the honest answer.** Discovery has to reach a real
 * target and report what it found; none of the three shipped types has a check
 * egma can make without either inventing a provider fact or guessing from the
 * brand, and the rule above says it may do neither. So the seam is real, the
 * recording path behind it is complete, and an entry lands here in the same
 * commit as the adapter that earns it — the arrangement `simulatorAdapter`
 * already uses in the connection registry, for the same reason.
 *
 * It is a map rather than a flag on the descriptor because the descriptor is
 * *what a connection is* and this is *what egma can do about one*, and because
 * a test proving the recording path needs to stand an adapter up without
 * rewriting the registry.
 */
const DISCOVERIES = new Map<ConnectionType, CapabilityDiscovery>();

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
 * An adapter's answer, held to the catalog before it can be stored.
 *
 * An adapter naming a key egma does not have is a bug in the adapter, and
 * storing it would put a capability on a connection that no test could ever
 * require. It is refused rather than dropped.
 */
export function measuredCapabilities(
  found: readonly string[],
  source: string,
  checkedAt: Date,
): ConnectionCapabilities {
  const supported: string[] = [];
  for (const key of found) {
    if (!isCapabilityKey(key)) {
      throw new Error(
        `capability adapter ${source} answered "${key}", which is not in ` +
          `egma's capability catalog (${CAPABILITY_KEYS.join(", ")})`,
      );
    }
    if (!supported.includes(key)) supported.push(key);
  }
  return { state: "known", supported, checkedAt, source };
}
