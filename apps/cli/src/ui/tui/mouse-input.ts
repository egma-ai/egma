/** Pure SGR mouse parsing, kept separate from the React terminal hook. */

export type MousePress = { readonly x: number; readonly y: number };

const SGR_MOUSE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/gu;
const INK_MOUSE_INPUT = /^\[<\d+;\d+;\d+[Mm]$/u;

/** Ink passes an unknown SGR mouse sequence through without its Escape byte. */
export function isMouseInput(input: string): boolean {
  return INK_MOUSE_INPUT.test(input);
}

/** Complete left-button presses in one terminal input chunk. */
export function mousePressesIn(input: string): readonly MousePress[] {
  const presses: MousePress[] = [];
  for (const match of input.matchAll(SGR_MOUSE)) {
    const button = Number(match[1]);
    if (match[4] !== "M" || (button & 3) !== 0 || (button & 96) !== 0) continue;
    presses.push({ x: Number(match[2]) - 1, y: Number(match[3]) - 1 });
  }
  return presses;
}
