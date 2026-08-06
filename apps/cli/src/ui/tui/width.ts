/**
 * Whether an address fits on one line, and what to say when it does not.
 *
 * An address that wraps is worse than no address at all. Selecting it with a
 * mouse copies the line break with it, and a line break pasted into a browser
 * is an address that does not work — so the developer's first attempt fails for
 * a reason nothing on screen explains.
 *
 * So it is never drawn wrapped. Either the whole address is on its own line, or
 * the screen says how much wider the terminal has to be and points at the key
 * that copies the address without drawing it.
 */

/** What the box around a screen costs: a border and padding, each side. */
export const FRAMING_COLUMNS = 6;

export function addressFits(url: string, columns: number, framing = FRAMING_COLUMNS): boolean {
  return url.length <= columns - framing;
}

/** How wide the terminal has to be for the address to fit on one line. */
export function columnsNeeded(url: string, framing = FRAMING_COLUMNS): number {
  return url.length + framing;
}
