/**
 * Which addresses egma will act on, and which it will only ever print.
 *
 * Two addresses arrive from outside and neither can be believed. The one a
 * developer types (`--url`, `EGMA_URL`) decides what egma talks to. The one the
 * instance sends back (`verification_uri_complete`) is handed to a browser, and
 * handing a string to a browser opener is handing it to a program: on Windows
 * the opener is `cmd /c start`, and a command interpreter reads `&` and `|` as
 * syntax rather than as characters in an address.
 *
 * So an address is checked before it reaches anything that starts a program.
 * What fails the check is not opened — it is still shown on the screen, because
 * a developer who can read it can still approve it somewhere, and showing it is
 * the one thing that cannot start anything.
 */

/** True when this is a whole address egma can talk to: http or https, no more. */
export function isWebAddress(candidate: string): boolean {
  const parsed = parse(candidate);
  return parsed !== null;
}

/**
 * Characters an address does not need and a command interpreter reads as
 * syntax. Whitespace and control characters are in here for the same reason:
 * one argument stops being one argument the moment it holds a space.
 */
const SYNTAX = /[\p{Cc}\p{Cf}\s"'`$&()<>^|;\\]/u;

/**
 * True when egma may start a browser on this address.
 *
 * Three questions, and all three have to answer yes. Is it an address at all,
 * and an http one — because `open` and `xdg-open` will launch a `javascript:`
 * or a `file:` as happily as a web page. Is every character in it a character —
 * because of the Windows opener above. And is it on the egma this login is
 * against — because an instance that answers with somebody else's address is
 * sending the developer somewhere egma never chose.
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
