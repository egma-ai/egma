/**
 * egma's own vocabulary for the device flow, kept out of the file that knows
 * the auth provider so that both sides of the flow can share it.
 */

/**
 * The one client egma issues device codes to.
 *
 * RFC 8628 has a client identifier because an authorization server serves many
 * applications. egma serves one — its own CLI — and pinning it here rather than
 * believing whatever a request sends is what keeps the two halves of the flow
 * in step: the seam's poll takes a device code and nothing else, so the client
 * it names on the way out has to be the client it named on the way in.
 *
 * A second client is a decision somebody makes on purpose, and the day it
 * arrives this becomes a list the provider validates against.
 */
export const DEVICE_CLIENT_ID = "egma-cli";

/**
 * A code as the provider stored it.
 *
 * People read these off one screen and type them into another, so a hyphen, a
 * space or a lower-case letter is a thing that happens rather than a thing to
 * refuse. This is the edge that took the typing, so this is where it is tidied
 * up; nothing below here has to wonder what shape a code arrives in.
 */
export function normalizeUserCode(userCode: string): string {
  return userCode.replaceAll(/[^0-9A-Za-z]/gu, "").toUpperCase();
}
