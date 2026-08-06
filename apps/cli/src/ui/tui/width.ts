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

/** A drawn border is one column wide, on the left and again on the right. */
const BORDER_COLUMNS = 1;

/** What `paddingX` is set to on the box the address is drawn in. */
const PADDING_COLUMNS = 2;

/**
 * What the box around a screen costs, left and right together.
 *
 * Constraint, and the code cannot show it to you: this has to match the box
 * `LoginScreen` draws — `borderStyle="round"` (one column each side) and
 * `paddingX={2}` (two more each side). Change either of those there and this
 * has to change with it, or the screen will promise an address fits and then
 * wrap it.
 */
export const FRAMING_COLUMNS = (BORDER_COLUMNS + PADDING_COLUMNS) * 2;

export function addressFits(url: string, columns: number, framing = FRAMING_COLUMNS): boolean {
  return url.length <= columns - framing;
}

/** How wide the terminal has to be for the address to fit on one line. */
export function columnsNeeded(url: string, framing = FRAMING_COLUMNS): number {
  return url.length + framing;
}
