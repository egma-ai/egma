import { CROCKFORD_ALPHABET, isId } from "@egma/ids";

/**
 * Trace identity: which trace a simulation's spans belong to.
 *
 * A simulation's telemetry is filed in the trace store under an OpenTelemetry
 * trace id, which is 128 bits of fixed-width binary and cannot hold one of
 * egma's own identifiers. So the two are not the same string, and something
 * has to turn one into the other. That derivation is a term of the contract —
 * `span-vocabulary.md` states it, with a worked example, because the emitter
 * applies it when it authors a span and the platform applies it when it goes
 * looking for one, and the two agreeing is what lets a verdict and the spans it
 * cites find each other with nothing having stored a mapping.
 *
 * **This is the whole of the TypeScript side.** The simulator has its own, in
 * Python, at the far end of the wire; the golden fixtures are the two held to
 * each other. Inside this repository every production caller comes here, so a
 * conversation is looked up one way — a second derivation would be a second
 * answer, and the two disagreeing would look exactly like telemetry that never
 * arrived.
 */

/**
 * How wide a trace id is, in bits and in the hex it is written as. Both come
 * from OpenTelemetry rather than from egma: a trace id is 16 bytes, always,
 * and lowercase hex is the form the JSON mapping carries and the store holds.
 */
const TRACE_ID_BITS = 128n;
const TRACE_ID_HEX_LENGTH = 32;

/** Five bits a character, which is what base32 is. */
const BITS_PER_CHARACTER = 5n;

/**
 * The trace a simulation's spans belong to, as 32 lowercase hex — or
 * `undefined` for a string that is not one of egma's simulation ids.
 *
 * egma's ids carry 128 bits of their own: the 26 Crockford base32 characters
 * after `sim_` are a ULID, and those bits *are* the trace. So
 * `sim_01K3XQ7M4E8YB2FVN0H9TZQWER` is trace `0198fb73d08e479627eea08a75fbf1d8`,
 * always and on both sides of the wire.
 *
 * **The absent answer is not a refusal a caller has to handle carefully.** Every
 * simulation id the platform reads is one it minted itself, so there is no
 * reachable path here that is not egma-shaped. Answering `undefined` rather
 * than digesting an unrecognised string into something trace-shaped is what
 * keeps that true: a made-up trace id would send a reader looking for spans
 * that were never filed under it, and finding none looks precisely like
 * telemetry that went missing. The simulator's own copy does digest, because
 * over there a simulation id is opaque — echoed back from a claimed spec and
 * never parsed — and it has to name a trace for whatever it was handed.
 */
export function traceIdOfSimulation(simulationId: string): string | undefined {
  if (!isId("sim", simulationId)) return undefined;

  let value = 0n;
  for (const character of simulationId.slice("sim_".length)) {
    value =
      (value << BITS_PER_CHARACTER) |
      BigInt(CROCKFORD_ALPHABET.indexOf(character));
  }

  // Twenty-six base32 characters hold 130 bits, so a value can be wider than a
  // trace id is. egma's own never are — the top bits of a ULID's millisecond
  // field stay zero for the next eight thousand years — and one that somehow
  // were would silently truncate into a trace belonging to a different
  // conversation, which is worse than having no answer.
  if (value >= 1n << TRACE_ID_BITS) return undefined;

  return value.toString(16).padStart(TRACE_ID_HEX_LENGTH, "0");
}

/** How many Crockford characters a simulation id carries after its prefix. */
const SIMULATION_ID_CHARACTERS = 26;

/**
 * The other direction: the simulation a trace is, or `undefined` for a trace
 * that is not one of egma's simulations.
 *
 * Needed because the two forms are read from opposite ends. A grader is handed
 * a **simulation** and goes looking for its spans, so it derives forwards. A
 * reader opens a **transcript** — which is filed under the trace id the spans
 * carry — and wants the verdicts, which are filed under the simulation id. That
 * reader has only the hex, and inventing a second mapping to store would be the
 * very thing the forward derivation exists to avoid.
 *
 * The round trip is exact because it is the same 128 bits written two ways. A
 * production trace, whose id came off somebody else's wire, is not a simulation
 * — but its bits still convert to a well-formed string, so this can only ever
 * say "here is the simulation id those bits spell", never "a simulation by that
 * id exists". The caller finds that out by reading, and a production trace's
 * lookup simply returns no verdicts filed that way.
 */
export function simulationIdOfTrace(traceId: string): string | undefined {
  if (!/^[0-9a-f]{32}$/u.test(traceId)) return undefined;

  let value = BigInt(`0x${traceId}`);
  const characters: string[] = [];
  for (let at = 0; at < SIMULATION_ID_CHARACTERS; at += 1) {
    characters.push(CROCKFORD_ALPHABET[Number(value & 31n)] ?? "0");
    value >>= BITS_PER_CHARACTER;
  }
  return `sim_${characters.reverse().join("")}`;
}
