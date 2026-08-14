/**
 * The credential the media server, the simulator and the SIP gateway
 * authenticate each other with.
 *
 * **It is a password between egma's own parts**, in the same class as the
 * Postgres password: generated when a workspace is prepared, written beside the
 * other bootstrap variables, and never seen, chosen or typed by the operator.
 *
 * It exists because the alternative was live. All three containers used to fall
 * back to a key and a secret written into the compose file in the public
 * repository, and nothing in the CLI, the skills or the documentation ever
 * replaced them. Published to loopback the exposure is small — but the compose
 * file invites a wider bind for testing from another machine, and at that
 * moment the media server accepts anyone who read the repository.
 *
 * **A pair that already exists is left exactly as it is.** The three containers
 * hold whatever they were created with, so a preparation that minted a fresh
 * pair would leave a running deployment whose parts no longer agree — and the
 * symptom is every phone simulation failing to authenticate, a long way from
 * the command that caused it. Regenerating is therefore the one thing this must
 * never do on its own.
 */

import { randomBytes } from "node:crypto";

/** What the compose file reads the pair from, and therefore what is written. */
export const MEDIA_KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
export const MEDIA_SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";

/**
 * The pair a workspace is to use, and whether this call is what made it.
 *
 * `generated` is not a detail: it is the difference between a start that leaves
 * a deployment alone and one that replaces its media containers, and the
 * operator is told which of the two happened.
 */
export type MediaCredential = {
  readonly values: Readonly<Record<string, string>>;
  readonly generated: boolean;
};

/**
 * The first pair any of these sources carries, or a fresh one where none does.
 *
 * Sources are given in order of precedence, and the caller's order is the same
 * one `up` already uses for the platform's address: the environment first,
 * because a self-hoster who exported this pair meant it, then the workspace's
 * own configuration. A pair egma is handed is a pair egma keeps.
 *
 * **Half a pair counts as none, one source at a time.** A key with no secret
 * authenticates nothing, and a key from one source beside a secret from another
 * is two halves of two different passwords — worse than either. So a source
 * carrying one of the two is passed over whole, and the two are always minted
 * together.
 *
 * Both generated values are drawn from `A-Za-z0-9_-` alone. They travel through
 * a `NAME=value` file with no quoting, a child process environment, and a YAML
 * scalar in the compose file, and a character that needed escaping in any one
 * of those would break a deployment in a way that reads as a wrong password.
 */
export function mediaCredential(
  ...sources: readonly Readonly<Record<string, string | undefined>>[]
): MediaCredential {
  for (const source of sources) {
    const key = source[MEDIA_KEY_VARIABLE]?.trim() ?? "";
    const secret = source[MEDIA_SECRET_VARIABLE]?.trim() ?? "";
    if (key !== "" && secret !== "") {
      return {
        values: { [MEDIA_KEY_VARIABLE]: key, [MEDIA_SECRET_VARIABLE]: secret },
        generated: false,
      };
    }
  }
  return {
    values: {
      // Named so that a person reading the media server's logs can tell egma's
      // own credential from one they brought themselves.
      [MEDIA_KEY_VARIABLE]: `egma${randomBytes(9).toString("base64url")}`,
      // 32 bytes. The media server refuses a secret shorter than 32
      // characters, and this is well past that in any encoding.
      [MEDIA_SECRET_VARIABLE]: randomBytes(32).toString("base64url"),
    },
    generated: true,
  };
}

/**
 * Whether a workspace's configuration already says exactly this pair.
 *
 * The question a caller asks before writing, and it is not the same question as
 * `generated`. A pair that arrived from the environment was made by nobody
 * here, and still has to be written down: one that lives only in a shell is one
 * the next start cannot find, and that start would mint a third pair and lock
 * the deployment out of itself.
 */
export function recorded(
  credential: MediaCredential,
  stored: Readonly<Record<string, string>>,
): boolean {
  return (
    stored[MEDIA_KEY_VARIABLE] === credential.values[MEDIA_KEY_VARIABLE] &&
    stored[MEDIA_SECRET_VARIABLE] === credential.values[MEDIA_SECRET_VARIABLE]
  );
}
