import { CROCKFORD_ALPHABET, isId } from "@egma/ids";

/**
 * Convert between simulation IDs and OpenTelemetry trace IDs without a stored
 * mapping. The Python implementation and this module share golden fixtures;
 * see span-vocabulary.md for the wire contract.
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
 * Decode a simulation ID's ULID bits as 32 lowercase hex characters.
 * Return undefined for an invalid simulation ID; do not invent a trace ID
 * for a value that the platform did not mint. The Python simulator also
 * supports digesting opaque IDs used outside the platform.
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
  // OpenTelemetry reserves the all-zero value as an invalid trace identity.
  // The simulator refuses this otherwise well-shaped id before `running`, so
  // readers must not look for evidence under a trace the SDK cannot record.
  if (value === 0n || value >= 1n << TRACE_ID_BITS) return undefined;

  return value.toString(16).padStart(TRACE_ID_HEX_LENGTH, "0");
}

/** How many Crockford characters a simulation id carries after its prefix. */
const SIMULATION_ID_CHARACTERS = 26;

/**
 * Encode a nonzero, lowercase 128-bit trace ID as a simulation ID.
 * This converts the bits; it does not prove that the simulation exists.
 * The reader must resolve the resulting ID in the simulation store.
 */
export function simulationIdOfTrace(traceId: string): string | undefined {
  if (!/^[0-9a-f]{32}$/u.test(traceId) || /^0{32}$/u.test(traceId)) {
    return undefined;
  }

  let value = BigInt(`0x${traceId}`);
  const characters: string[] = [];
  for (let at = 0; at < SIMULATION_ID_CHARACTERS; at += 1) {
    characters.push(CROCKFORD_ALPHABET[Number(value & 31n)] ?? "0");
    value >>= BITS_PER_CHARACTER;
  }
  return `sim_${characters.reverse().join("")}`;
}
