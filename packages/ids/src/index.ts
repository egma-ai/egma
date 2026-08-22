import { randomFillSync } from "node:crypto";

/**
 * Every identifier egma mints is `<prefix>_<26-character Crockford base32 of a
 * UUIDv7>`. It is the same string in the URL, the log and the database.
 *
 * Crockford base32 is already in ASCII order and fixed width, so a plain
 * lexicographic sort over these strings is a sort by mint time. Keyset
 * pagination (`WHERE id > $cursor ORDER BY id LIMIT 100`) therefore works on
 * every table without a second sort column.
 */

/** Crockford base32: the digits, then the letters minus I, L, O and U. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A Crockford base32 character class, written the way Postgres wants it. */
export const CROCKFORD_CHARACTER_CLASS = "[0-9A-HJKMNP-TV-Z]";

/** 128 bits of UUIDv7, encoded five bits at a time. */
export const ID_BODY_LENGTH = 26;

/**
 * A prefix is part of the identifier and can never change. Adding one is free.
 *
 * The identity prefixes (`ses_`, `acc_`, `vrf_`, `dvc_`) cover the tables the
 * auth provider reads and writes; egma mints their identifiers with the same
 * generator so one format covers every table.
 */
export const ID_PREFIXES = [
  "usr",
  "ses",
  "acc",
  "vrf",
  "dvc",
  "pfs",
  "org",
  "prj",
  "mbr",
  "inv",
  "key",
  "agt",
  "con",
  "tst",
  "tstv",
  "prs",
  "prsv",
  "grl",
  "grd",
  "grv",
  "mck",
  "ste",
  "run",
  "sim",
  "gjb",
  /**
   * One run's frozen grading plan: which graders will judge each pinned test
   * version, at which immutable versions. Its own identity
   * because it is written once beside the run and read long afterwards by the
   * grader service, and because an archive refusal has to name the plan that
   * still depends on a grader version.
   */
  "gpl",
  "del",
  /**
   * A live resource's revision: what an edit says it was written against, and
   * a fresh one after every change that lands. It is an identifier rather than
   * a counter so that nothing can guess the next one and so that it is opaque
   * on its face — a caller who read `3` would sooner or later send `4`.
   */
  "rev",
  /**
   * One production call whose fetch or normalization failed: the short-lived
   * row holding its bounded retry budget, and then the identity-only marker
   * that stops the five-minute overlap starting a second budget. It carries no
   * provider document and disappears on success or expiry.
   */
  "mnf",
  /**
   * One sealed segment of production evidence: the unit that is written to the
   * ingestion bucket once and read back by the drainer. It is minted when the
   * segment is sealed, written into the local log before the upload starts, and
   * reused verbatim on every retry — an ambiguous upload has to reach for the
   * same immutable object rather than invent a second one holding the same
   * evidence. Sortable, so the recovery listing walks the pending prefix
   * oldest-first without a second sort key.
   */
  "sgm",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/** `usr_01K3XQ7M4E8YB2FVN0H9TZQWER` and nothing else. */
export function idCheckPattern(prefix: IdPrefix): string {
  return `^${prefix}_${CROCKFORD_CHARACTER_CLASS}{${ID_BODY_LENGTH}}$`;
}

export function isId(prefix: IdPrefix, value: string): boolean {
  return new RegExp(idCheckPattern(prefix)).test(value);
}

/** The prefix of an identifier, or null if the string is not one of ours. */
export function prefixOf(id: string): IdPrefix | null {
  const separator = id.indexOf("_");
  if (separator === -1) return null;
  const candidate = id.slice(0, separator);
  const known = ID_PREFIXES.find((prefix) => prefix === candidate);
  if (known === undefined) return null;
  return isId(known, id) ? known : null;
}

const TAIL_BITS = 74n;
const TAIL_MASK = (1n << TAIL_BITS) - 1n;
const RANDOM_B_BITS = 62n;
const RANDOM_B_MASK = (1n << RANDOM_B_BITS) - 1n;
/**
 * A fresh millisecond starts with two spare high bits, so the within-millisecond
 * counter below cannot carry into the timestamp no matter how fast we mint.
 */
const FRESH_TAIL_MASK = (1n << 72n) - 1n;
const MILLISECOND_MASK = (1n << 48n) - 1n;

const randomBuffer = new Uint8Array(10);

function randomTail(): bigint {
  randomFillSync(randomBuffer);
  let value = 0n;
  for (const byte of randomBuffer) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & FRESH_TAIL_MASK;
}

let lastMilliseconds = -1n;
let lastTail = 0n;

/**
 * A UUIDv7 as a 128-bit integer, monotonic within a millisecond.
 *
 * Two identifiers minted in the same millisecond must still sort in mint order,
 * so the random tail is drawn once per millisecond and incremented after that.
 * A clock that steps backwards is absorbed the same way rather than being
 * allowed to produce an identifier that sorts before one already handed out.
 */
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
    (0x7n << 76n) | // version 7
    (randomA << 64n) |
    (0b10n << 62n) | // variant 10
    randomB
  );
}

function encode(value: bigint): string {
  let out = "";
  for (let shift = 125; shift >= 0; shift -= 5) {
    out += CROCKFORD_ALPHABET[Number((value >> BigInt(shift)) & 31n)];
  }
  return out;
}

function decode(body: string): bigint {
  let value = 0n;
  for (const character of body) {
    const digit = CROCKFORD_ALPHABET.indexOf(character);
    if (digit === -1) throw new Error(`not a Crockford base32 body: ${body}`);
    value = (value << 5n) | BigInt(digit);
  }
  return value;
}

/**
 * Mint an identifier. Identifiers are minted here and never by a database
 * default, so one generator serves every table egma owns and every table the
 * auth provider reads.
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${encode(nextUuidV7())}`;
}

/** When an identifier was minted, read back out of its own leading bits. */
export function mintedAt(id: string): Date {
  const separator = id.indexOf("_");
  if (separator === -1) throw new Error(`not an Egma identifier: ${id}`);
  const body = id.slice(separator + 1);
  if (body.length !== ID_BODY_LENGTH) {
    throw new Error(`not an Egma identifier: ${id}`);
  }
  return new Date(Number(decode(body) >> 80n));
}
