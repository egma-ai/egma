/**
 * What a smoke check says while it runs, and the words it must never say.
 *
 * Every check in this folder prints the same way — one `ok`/`FAILED` line per
 * thing it looked at, a rule between sections, and a verdict at the end — and
 * each of them used to carry its own copy of that. Copies of a printer are
 * cheap right up until one of them learns something the others do not: the day
 * one grew redaction was the day the others were quietly printing whatever the
 * first one had decided was worth hiding.
 *
 * So there is one printer, and **redaction is inside it rather than beside
 * it**. A check adds what must never appear — a key, a customer's agent name,
 * the path of somebody's repository — to `secrets` as it learns it, and every
 * line printed after that is clean whether or not whoever wrote the line
 * remembered. A passing run of these gets pasted into reviews, and clean by
 * luck is not clean.
 */

/** The line between sections, one width for every check in this folder. */
export const RULE = "─".repeat(58);

/**
 * Everything that must never appear in what a check prints.
 *
 * Added to as a run learns them. Short entries are ignored when redacting: a
 * three-character name would blank out half of an ordinary sentence, and a
 * secret that short is not one.
 */
export const secrets: string[] = [];

/** Every check that did not hold, in the order they were found. */
export const problems: string[] = [];

/**
 * The text with everything in `secrets` taken out of it.
 *
 * **Neither side is trusted to be a string, and that is not defensive tidying.**
 * This runs while a check is printing why it failed. A secret that arrived as
 * `undefined` — a field that moved, an answer that was not the shape it used to
 * be — used to crash the reduce; text that arrived as `undefined` crashes the
 * same reduce from the other side. Either way the crash lands *inside* the
 * error report and takes the real reason down with it, which is the one failure
 * that costs a whole run of a check that takes twenty minutes.
 *
 * A value that is not text is described rather than dropped, because "the thing
 * being printed was not a string" is itself the news at that moment.
 */
export function redact(text: string): string {
  const held = typeof text === "string" ? text : String(text);
  return [...new Set(secrets)]
    .filter((one) => typeof one === "string" && one.length > 3)
    .sort((left, right) => right.length - left.length)
    .reduce((carried, one) => carried.split(one).join("<redacted>"), held);
}

export function say(message: string): void {
  process.stdout.write(`${redact(message)}\n`);
}

export function check(condition: boolean, what: string): void {
  say(`${condition ? "  ok  " : "FAILED"}  ${what}`);
  if (!condition) problems.push(what);
}

/**
 * Settles when the condition holds, or gives up loudly rather than hanging.
 *
 * Polled rather than pushed, because what these checks wait on is a line
 * appearing in another process's output or a row appearing on a platform, and
 * neither of those has an event to subscribe to.
 */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
