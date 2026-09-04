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
import { oneLineFactText } from "../ui/fact-value.ts";

export const LOGOUT_EXIT = {
  done: 0,
  /** The local entry changed while logout was revoking the old one. */
  changed: 1,
  /** The platform did not confirm the remote key was revoked. */
  revokeFailed: 1,
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
  options.out(
    "EGMA_API_KEY is still set for this process. Remove it from the shell or secret store to stop using it.",
  );
}

function safeLocalFailure(cause: unknown, secrets: readonly string[]): string {
  let message = cause instanceof Error ? cause.message : String(cause);
  for (const secret of secrets) {
    if (secret !== "") message = message.replaceAll(secret, "<redacted>");
  }
  return oneLineFactText(message, "unknown local cleanup error");
}

/** Remove the same entry read before the network request, and no replacement. */
async function removeReadEntry(
  options: LogoutCommandOptions,
  held: Credentials,
): Promise<number> {
  const removed = await removeCredentials(
    options.access.credentialsFile,
    held,
  );
  if (removed.kind === "changed") {
    options.fail(
      "The stored login changed while Egma was logging out, so the replacement was kept.",
    );
    return LOGOUT_EXIT.changed;
  }

  // Another logout may have removed the same entry after this one read it.
  // That is the requested end state, so it is success too.
  options.out(
    removed.kind === "removed"
      ? `Logged out. The saved login was removed from ${oneLineFactText(options.access.credentialsFile, "the credentials file")}.`
      : `This machine was already logged out. There is no saved login in ${oneLineFactText(options.access.credentialsFile, "the credentials file")}.`,
  );
  stillAuthenticatedByEnvironment(options);
  return LOGOUT_EXIT.done;
}

export async function runLogoutCommand(
  options: LogoutCommandOptions,
): Promise<number> {
  options.out(`Logging out from ${options.access.url}.`);

  const held = await readCredentials(
    options.access.credentialsFile,
    options.access.url,
  );
  if (held === null) {
    if (environmentApiKeyIn(options.env) === null) {
      options.out("This machine is already logged out.");
    } else {
      options.out("There is no saved login to revoke.");
      stillAuthenticatedByEnvironment(options);
    }
    return LOGOUT_EXIT.done;
  }

  if (options.signal.aborted) {
    options.fail("Logout stopped before anything changed. The stored login was kept.");
    return LOGOUT_EXIT.interrupted;
  }

  if (held.login === undefined) {
    // The old formats have no remote key id. Guessing from a suffix or a name
    // could revoke somebody else's key, so only the local legacy entry goes.
    options.out(
      "This login came from an older credentials file with no API key ID. Egma removed only its local record.",
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
    options.fail(revoked.reason);
    if (revoked.kind === "not-authenticated") {
      options.fail(
        "Egma did not accept the control-plane key, so the stored login was kept.",
      );
    }
    if (options.signal.aborted) {
      options.fail(
        "The command was interrupted before Egma confirmed whether it revoked the saved login. The local credential was kept. Run egma logout again.",
      );
      return LOGOUT_EXIT.interrupted;
    }
    return LOGOUT_EXIT.revokeFailed;
  }

  options.out(
    `Revoked saved login key ${oneLineFactText(held.login.apiKeyId, "with an unknown ID")}.`,
  );
  let local: number;
  try {
    local = await removeReadEntry(options, held);
  } catch (cause) {
    const failure = safeLocalFailure(cause, [held.key, authKey]);
    options.fail(
      `Egma revoked saved login key ${oneLineFactText(held.login.apiKeyId, "with an unknown ID")}, but could not remove its local credential from ${oneLineFactText(options.access.credentialsFile, "the credentials file")}: ${failure}`,
    );
    options.fail("Run egma logout again.");
    return options.signal.aborted
      ? LOGOUT_EXIT.interrupted
      : LOGOUT_EXIT.revokeFailed;
  }
  if (options.signal.aborted) {
    options.fail(
      local === LOGOUT_EXIT.changed
        ? "The command was interrupted after Egma revoked the saved login. A replacement local login was found and kept."
        : "The command was interrupted after Egma revoked the saved login. The revoked credential was removed from this machine.",
    );
    return LOGOUT_EXIT.interrupted;
  }
  return local;
}
