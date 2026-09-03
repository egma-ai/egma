/**
 * `egma logout`: retire one device-login key and remove its local record.
 *
 * The selected platform origin chooses exactly one entry. An `EGMA_API_KEY`
 * may authenticate the revoke request, but it is never the key being revoked:
 * environment variables belong to the shell or CI secret store, not to this
 * credentials file.
 */

import { revokeProjectKey } from "../platform/api-keys.ts";
import {
  readCredentials,
  removeCredentials,
  type Credentials,
  type PlatformAccess,
} from "../platform/credentials.ts";
import type { Fetch } from "../platform/device-flow.ts";
import { environmentApiKeyIn } from "../platform/signed-in.ts";

export const LOGOUT_EXIT = {
  done: 0,
  /** The local entry changed while logout was revoking the old one. */
  changed: 1,
  /** The platform did not confirm the remote key was revoked. */
  revokeFailed: 4,
  interrupted: 130,
} as const;

export type LogoutCommandOptions = {
  /** One already-resolved platform and the machine credentials file. */
  readonly access: PlatformAccess;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: Fetch;
};

function stillAuthenticatedByEnvironment(options: LogoutCommandOptions): void {
  if (environmentApiKeyIn(options.env) === null) return;
  options.out("authentication: environment");
  options.out(
    "note: EGMA_API_KEY is still set for this process. Remove it from the shell or CI secret store to stop using it.",
  );
}

/** Remove the same entry read before the network request, and no replacement. */
async function removeReadEntry(
  options: LogoutCommandOptions,
  held: Credentials,
): Promise<number> {
  const removed = await removeCredentials(options.access.credentialsFile, held);
  if (removed.kind === "changed") {
    options.out("status: credential-changed");
    options.fail(
      "The stored login changed while Egma was logging out, so the replacement was kept.",
    );
    return LOGOUT_EXIT.changed;
  }

  // Another logout may have removed the same entry after this one read it.
  // That is the requested end state, so it is success too.
  options.out(
    `status: ${removed.kind === "removed" ? "logged-out" : "already-logged-out"}`,
  );
  options.out(`credentials: ${options.access.credentialsFile}`);
  stillAuthenticatedByEnvironment(options);
  return LOGOUT_EXIT.done;
}

export async function runLogoutCommand(
  options: LogoutCommandOptions,
): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const held = await readCredentials(
    options.access.credentialsFile,
    options.access.url,
  );
  if (held === null) {
    if (environmentApiKeyIn(options.env) === null) {
      options.out("status: already-logged-out");
    } else {
      options.out("status: no-stored-login");
      stillAuthenticatedByEnvironment(options);
    }
    return LOGOUT_EXIT.done;
  }

  if (options.signal.aborted) {
    options.out("status: interrupted");
    options.fail("Logout stopped before anything changed. The stored login was kept.");
    return LOGOUT_EXIT.interrupted;
  }

  if (held.login === undefined) {
    // The old formats have no remote key id. Guessing from a suffix or a name
    // could revoke somebody else's key, so only the local legacy entry goes.
    options.out("remote_key: unknown-not-revoked");
    options.out(
      "note: This login came from an older credentials file with no API key ID. Egma removed only its local record.",
    );
    return removeReadEntry(options, held);
  }

  // Environment authentication wins for control-plane work. It may authorize
  // this request, but the path always names the stored login's own key ID.
  const authKey = environmentApiKeyIn(options.env) ?? held.key;
  const revoked = await revokeProjectKey(held.login.apiKeyId, {
    url: options.access.url,
    key: authKey,
    signal: options.signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  if (revoked.kind !== "revoked") {
    const reason =
      revoked.kind === "not-authenticated"
        ? "Egma did not accept the control-plane key, so the stored login was kept."
        : revoked.reason;
    options.out(`status: ${options.signal.aborted ? "interrupted" : "revoke-failed"}`);
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return options.signal.aborted
      ? LOGOUT_EXIT.interrupted
      : LOGOUT_EXIT.revokeFailed;
  }

  options.out(`revoked_key_id: ${held.login.apiKeyId}`);
  return removeReadEntry(options, held);
}
