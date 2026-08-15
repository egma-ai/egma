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
  "pf",
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
  "grd",
  "grv",
  /**
   * An organization's judge credential: the label, the provider and the sealed
   * key an LLM judge is asked with. Its own identity because one organization
   * may hold several, and because a project's judge setting stores a
   * *reference* to one rather than a second copy of the secret.
   */
  "jcr",
  /**
   * The opaque revision an editable identity carries, minted fresh on every
   * write. It names no row of its own; it is a value a caller hands back to say
   * which state their edit was written against, which is exactly why it is
   * minted rather than derived — a revision computed from the row's own fields
   * would repeat itself the moment somebody edited a name back.
   */
  "rev",
  "mck",
  "ste",
  "run",
  "sim",
  "gjb",
  "del",
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
  if (separator === -1) throw new Error(`not an egma identifier: ${id}`);
  const body = id.slice(separator + 1);
  if (body.length !== ID_BODY_LENGTH) {
    throw new Error(`not an egma identifier: ${id}`);
  }
  return new Date(Number(decode(body) >> 80n));
}
