/**
 * The key this machine holds for one egma, for the verbs that need one.
 *
 * `login` mints it; everything else reads it. A verb that finds none says so in
 * plain words and names the command that fixes it, rather than failing on a 401
 * from an instance the developer never meant to talk to anonymously.
 */

import type { PlatformAccess } from "./binding.ts";
import { readCredentialsFor } from "./credentials.ts";

/** Which egma, and the key for it. */
export type SignedIn = {
  readonly url: string;
  readonly key: string;
};

/**
 * The key for the egma this command is talking to, or `null`.
 *
 * A key minted against one instance means nothing against another, and this
 * machine may hold several — so the one for this platform is asked for by
 * origin rather than "the key" being read and then checked.
 */
export async function signedInAt(access: PlatformAccess): Promise<SignedIn | null> {
  const held = await readCredentialsFor(access.credentialsFile, access.url);
  return held === null ? null : { url: access.url, key: held.key };
}

/** What a developer is told when there is no key for this egma. */
export function notSignedInRefusal(url: string): string {
  return `This machine is not signed in to egma at ${url}. Run egma login first, then run this again.`;
}
