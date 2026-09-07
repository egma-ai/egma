/**
 * Shared smoke output with redaction applied to every printed line.
 * Register keys and other private values in secrets as they become known.
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
 * Redact registered string values without throwing on non-string input.
 * Failure reporting must preserve the original diagnostic even when a response
 * shape or secret value is unexpected.
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
