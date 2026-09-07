/**
 * Validate platform and verification URLs before passing them to browser openers.
 * Windows start interprets shell characters even in an argument, so unsafe URLs
 * remain printable but are not opened automatically.
 */

/**
 * Characters an address does not need and a command interpreter reads as
 * syntax. Whitespace and control characters are in here for the same reason:
 * one argument stops being one argument the moment it holds a space.
 */
const SYNTAX = /[\p{Cc}\p{Cf}\s"'`$&()<>^|;\\]/u;

/**
 * Allow automatic opening only for HTTP(S) URLs on the selected platform origin
 * whose characters cannot be interpreted as shell syntax.
 */
export function isOpenable(address: string, instanceUrl: string): boolean {
  const parsed = parse(address);
  const instance = parse(instanceUrl);
  if (parsed === null || instance === null) return false;
  if (SYNTAX.test(address)) return false;
  return parsed.origin === instance.origin;
}

function parse(candidate: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}
