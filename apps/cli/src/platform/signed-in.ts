/**
 * The key this machine holds, for the verbs that need one.
 *
 * `login` mints it; everything else reads it. A verb that finds none says so in
 * plain words and names the command that fixes it, rather than failing on a 401
 * from an instance the developer never meant to talk to anonymously.
 */

import { readCredentials, type PlatformAccess } from "./credentials.ts";

/** Which egma, and the key for it. */
export type SignedIn = {
  readonly url: string;
  readonly key: string;
};

/**
 * The key for the egma this command is talking to, or `null`.
 *
 * A key minted against one instance means nothing against another, so a stored
 * key for a different address is no key at all here.
 */
export async function signedInAt(access: PlatformAccess): Promise<SignedIn | null> {
  const held = await readCredentials(access.credentialsFile, access.url);
  if (held === null || held.url !== access.url) return null;
  return { url: access.url, key: held.key };
}

/** What a developer is told when there is no key for this egma. */
export function notSignedInRefusal(url: string): string {
  return `This machine is not signed in to Egma at ${url}. Run egma login first, then run this again.`;
}
