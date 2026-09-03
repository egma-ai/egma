/**
 * The key this machine holds, for the verbs that need one.
 *
 * A CI job supplies `EGMA_API_KEY`; otherwise `login` mints a machine-local
 * key. A verb that finds neither says so before it sends an anonymous request.
 */

import process from "node:process";

import { readCredentials, type PlatformAccess } from "./credentials.ts";

/** A control-plane key supplied to one process, including a CI job. */
export const EGMA_API_KEY_VARIABLE = "EGMA_API_KEY";

/** Which egma, and the key for it. */
export type SignedIn = {
  readonly url: string;
  readonly key: string;
  /** Optional so existing callers may still construct the two-field wire shape. */
  readonly source?: "environment" | "device-login" | "stored";
  /** Known without a request only for a current device-login credential. */
  readonly projectId?: string;
};

/** The process-scoped control-plane key, or `null` when none was supplied. */
export function environmentApiKeyIn(env: NodeJS.ProcessEnv): string | null {
  const key = env[EGMA_API_KEY_VARIABLE]?.trim();
  return key === undefined || key === "" ? null : key;
}

/**
 * The key for the egma this command is talking to, or `null`.
 *
 * A key minted against one instance means nothing against another, so a stored
 * key for a different address is no key at all here.
 */
export async function signedInAt(
  access: PlatformAccess,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignedIn | null> {
  const environmentKey = environmentApiKeyIn(env);
  if (environmentKey !== null) {
    return { url: access.url, key: environmentKey, source: "environment" };
  }

  const held = await readCredentials(access.credentialsFile, access.url);
  if (held === null || held.url !== access.url) return null;
  return held.login === undefined
    ? { url: access.url, key: held.key, source: "stored" }
    : {
        url: access.url,
        key: held.key,
        source: "device-login",
        projectId: held.login.projectId,
      };
}

/** What a developer is told when there is no key for this egma. */
export function notSignedInRefusal(url: string): string {
  return `Egma has no control-plane key for ${url}. Set EGMA_API_KEY for this process, or run egma login, then run this again.`;
}
