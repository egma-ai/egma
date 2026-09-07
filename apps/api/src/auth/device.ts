/**
 * egma's own vocabulary for the device flow, kept out of the file that knows
 * the auth provider so that both sides of the flow can share it.
 */

/** Use the same CLI client ID when issuing and polling device codes. */
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
