/**
 * The identifier one relayed exchange is known by, in egma's own format.
 *
 * `<prefix>_<26 characters of Crockford base32 over a UUIDv7>` is the format
 * every identifier in this product uses, and a gateway record has to be
 * quotable in the same sentence as a simulation, so it uses that format too.
 *
 * **It is minted here rather than imported, and that is the deliberate part.**
 * The gateway is the one egma application that runs outside egma's own
 * deployment, on a runtime with no Node built-ins unless a compatibility flag
 * is turned on. Keeping its whole runtime surface to the web platform is what
 * lets one relay serve both hosts with no shims, so it mints its own instead of
 * reaching for the package that mints the rest — and its test pins the format
 * against that package's own constants, so the two can never drift.
 *
 * `gwr` is not an entity prefix: nothing writes one of these into a table. It
 * names a request the gateway carried, and it lives in a log line.
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MILLISECOND_MASK = (1n << 48n) - 1n;
const TAIL_BITS = 74n;
const TAIL_MASK = (1n << TAIL_BITS) - 1n;
const RANDOM_B_BITS = 62n;
const RANDOM_B_MASK = (1n << RANDOM_B_BITS) - 1n;
/** A fresh millisecond starts with two spare high bits, so the counter cannot carry. */
const FRESH_TAIL_MASK = (1n << 72n) - 1n;

const randomBuffer = new Uint8Array(10);

function randomTail(): bigint {
  crypto.getRandomValues(randomBuffer);
  let value = 0n;
  for (const byte of randomBuffer) value = (value << 8n) | BigInt(byte);
  return value & FRESH_TAIL_MASK;
}

let lastMilliseconds = -1n;
let lastTail = 0n;

/** Monotonic within a millisecond, so two records minted together still sort. */
function nextUuidV7(): bigint {
  const now = BigInt(Date.now()) & MILLISECOND_MASK;
  if (now > lastMilliseconds) {
    lastMilliseconds = now;
    lastTail = randomTail();
  } else {
    lastTail += 1n;
    if (lastTail > TAIL_MASK) {
      lastMilliseconds += 1n;
      lastTail = randomTail();
    }
  }
  const randomA = lastTail >> RANDOM_B_BITS;
  const randomB = lastTail & RANDOM_B_MASK;
  return (
    (lastMilliseconds << 80n) |
    (0x7n << 76n) |
    (randomA << 64n) |
    (0b10n << 62n) |
    randomB
  );
}

export function newRequestId(): string {
  const value = nextUuidV7();
  let body = "";
  for (let shift = 125; shift >= 0; shift -= 5) {
    body += CROCKFORD_ALPHABET[Number((value >> BigInt(shift)) & 31n)];
  }
  return `gwr_${body}`;
}
