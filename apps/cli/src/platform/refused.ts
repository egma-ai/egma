/**
 * An answer egma asked for and did not get.
 *
 * It sits on its own because every group that speaks to the platform throws it
 * and every verb that catches one treats it the same way — the address is up,
 * something answered, and what came back was not something to act on. Keeping
 * it beside any one group would make that group's module the thing the others
 * import for a reason that has nothing to do with it.
 */
export class PlatformRefusedError extends Error {
  readonly status: number;

  constructor(status: number, said: string) {
    super(said);
    this.name = "PlatformRefusedError";
    this.status = status;
  }
}
