/**
 * Secret fields that may cross only explicit custody seams: into an Egma
 * connection request, or into a provider worker's child environment. The
 * platform either seals a durable credential or uses a request-only platform
 * selection credential and discards it.
 *
 * The values live behind a private field. String conversion, JSON conversion,
 * and Node inspection all return a mask, so passing this object through a log
 * or an error does not reveal a provider credential. `reveal` is used only at
 * approved custody boundaries: the platform request body and a local provider
 * worker's child-process environment.
 */

/** What every accidental way of printing connection credentials sees. */
export const MASKED_CONNECTION_CREDENTIALS = "<connection credentials>";

export class ConnectionCredentials {
  readonly #reveal: () => Readonly<Record<string, string>>;

  private constructor(reveal: () => Readonly<Record<string, string>>) {
    this.#reveal = reveal;
  }

  /**
   * Hold one complete credential block.
   *
   * The connection-option registry on the platform remains the source of truth
   * for which field names belong to which connection shape. This object only
   * keeps those values from falling into logs before they reach that registry.
   */
  static hold(fields: Readonly<Record<string, string>>): ConnectionCredentials {
    // Copy at the edge. A caller changing the object it used to construct this
    // value cannot change which secret fields a later request sends.
    const held = Object.freeze({ ...fields });
    return new ConnectionCredentials(() => held);
  }

  /**
   * Keep another masked secret object unopened until the request is built.
   *
   * Retell uses this form. Its key remains inside `RetellKey` through provider
   * discovery and is only read while the Egma request body is serialized.
   */
  static defer(
    reveal: () => Readonly<Record<string, string>>,
  ): ConnectionCredentials {
    return new ConnectionCredentials(reveal);
  }

  /** Read only while building an approved request body or child environment. */
  reveal(): Readonly<Record<string, string>> {
    return { ...this.#reveal() };
  }

  toString(): string {
    return MASKED_CONNECTION_CREDENTIALS;
  }

  toJSON(): string {
    return MASKED_CONNECTION_CREDENTIALS;
  }

  /** What `console.log` and every Node inspector print. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MASKED_CONNECTION_CREDENTIALS;
  }
}
