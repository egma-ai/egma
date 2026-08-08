/**
 * The customer's Retell key, held in a way that makes leaking it hard.
 *
 * The key exists in memory, goes out in one request header and one request
 * body, and goes nowhere else: no file, no log, no status line, no error
 * message, and never a command argument, because arguments are readable by
 * every process on the machine.
 *
 * Most leaks are accidents rather than decisions — a key put in a template
 * string while somebody was debugging, an object handed to `JSON.stringify`, a
 * value printed by an inspector inside an error. So the value is private and
 * every way a string falls out of an object is answered with a mask instead.
 * Reading the key at all takes saying so, which is the whole point: the two
 * places that may read it are easy to find and easy to keep few.
 */

/** What anything that is not `reveal` gets. */
export const MASKED = "<a Retell key>";

/**
 * The shortest thing worth calling a key.
 *
 * The platform refuses a credential shorter than this, so refusing it here too
 * turns a paste gone wrong into a sentence about the paste rather than a
 * refusal from a server about a field.
 */
const SHORTEST = 8;

export class RetellKey {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /**
   * A key from something a developer typed, or `null` when they typed nothing
   * usable. Trimmed, because a key pasted with a newline on the end is the same
   * key and would otherwise be refused by Retell with nothing to say why.
   */
  static from(typed: string | null | undefined): RetellKey | null {
    const trimmed = (typed ?? "").trim();
    if (trimmed.length < SHORTEST) return null;
    return new RetellKey(trimmed);
  }

  /** The key itself. Called in two places, and both are worth reading twice. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASKED;
  }

  toJSON(): string {
    return MASKED;
  }

  /** What `console.log` and every Node inspector print. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MASKED;
  }
}
