/**
 * Keys as data, and the hints that come with them for free.
 *
 * Adapted from the PostHog wizard (MIT) — see ../../../NOTICE.
 *
 * A screen declares which keys it answers to, what each one is called, and what
 * it does. One list drives both the handler and the hint bar, so a key that
 * works and a key the developer is told about can never drift apart.
 */

export type KeyState = {
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly ctrl?: boolean;
};

/** A named key, or the character itself. */
export type KeyMatch =
  | "return"
  | "escape"
  | "space"
  | "upArrow"
  | "downArrow"
  | "leftArrow"
  | "rightArrow"
  | (string & NonNullable<unknown>);

export type KeyBinding = {
  readonly match: KeyMatch | readonly KeyMatch[];
  /** How the key is written in the hint bar, e.g. "enter". */
  readonly label: string;
  /** What it does, e.g. "begin". */
  readonly action: string;
  /** Lower sorts further left. Defaults by key kind. */
  readonly priority?: number;
  readonly handler: () => void;
  /** Set to keep the key working but out of the hint bar. */
  readonly hidden?: boolean;
};

export type KeyboardHint = {
  readonly label: string;
  readonly action: string;
  readonly priority: number;
};

const DEFAULT_PRIORITY: Readonly<Record<string, number>> = {
  upArrow: 0,
  downArrow: 0,
  leftArrow: 1,
  rightArrow: 1,
  space: 10,
  escape: 20,
  return: 21,
};

export function defaultPriority(match: KeyMatch | readonly KeyMatch[]): number {
  const first = Array.isArray(match) ? match[0] : (match as KeyMatch);
  return DEFAULT_PRIORITY[first as string] ?? 15;
}

/**
 * Enter, whichever byte the terminal sent for it.
 *
 * A terminal in its ordinary line-by-line mode turns the carriage return that
 * Enter sends into a line feed, and the renderer only calls a carriage return
 * `return`. The two are the same key, and the moment they differ is exactly the
 * moment a developer presses Enter: the first frame is on screen a beat before
 * the renderer takes the terminal into raw mode, and a keystroke in that beat
 * arrives as a line feed. Reading only `key.return` drops it, and the wizard
 * sits there looking as though it did not hear.
 */
export function isEnter(input: string, key: KeyState): boolean {
  return key.return === true || input === "\r" || input === "\n";
}

export function matchesKey(match: KeyMatch, input: string, key: KeyState): boolean {
  switch (match) {
    case "return":
      return isEnter(input, key);
    case "escape":
      return key.escape === true;
    case "space":
      return input === " ";
    case "upArrow":
      return key.upArrow === true;
    case "downArrow":
      return key.downArrow === true;
    case "leftArrow":
      return key.leftArrow === true;
    case "rightArrow":
      return key.rightArrow === true;
    default:
      return input === match;
  }
}

/** Runs the first binding whose key matches. Answers whether one did. */
export function dispatchKey(
  bindings: readonly KeyBinding[],
  input: string,
  key: KeyState,
): boolean {
  for (const binding of bindings) {
    const matches = Array.isArray(binding.match)
      ? binding.match
      : [binding.match as KeyMatch];
    if (matches.some((match) => matchesKey(match, input, key))) {
      binding.handler();
      return true;
    }
  }
  return false;
}

/** The hint bar for a set of bindings: deduplicated, in display order. */
export function hintsFor(bindings: readonly KeyBinding[]): KeyboardHint[] {
  const seen = new Set<string>();
  const hints: KeyboardHint[] = [];
  for (const binding of bindings) {
    if (binding.hidden === true) continue;
    const key = `${binding.label}:${binding.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      label: binding.label,
      action: binding.action,
      priority: binding.priority ?? defaultPriority(binding.match),
    });
  }
  return hints.sort((left, right) => left.priority - right.priority);
}

/** The hint bar as one line, the way a screen prints it. */
export function hintBar(bindings: readonly KeyBinding[]): string {
  return hintsFor(bindings)
    .map((hint) => `[${hint.label}] ${hint.action}`)
    .join("   ");
}
