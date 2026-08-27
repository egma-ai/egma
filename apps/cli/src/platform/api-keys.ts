/**
 * Project keys used by monitored workers.
 *
 * Minting returns the secret once, and the only place it is written down is
 * the file the developer agreed to. The mint also binds the key's non-secret
 * id to the stable agent id, which is what makes a failed local write
 * recoverable without trusting a display name. The worker never receives the
 * terminal's own login credential — that one is this machine's identity, and
 * revoking it would also sign this laptop out.
 *
 * The key is scoped by naming a project. There is no scope field to send: the
 * request names the project and the scope is derived, which is what makes a
 * project key a project key rather than a claim about one.
 */

import {
  createApiKey as createApiKeyRequest,
  revokeApiKey as revokeApiKeyRequest,
} from "@egma/platform-api/client";

import {
  commonFailure,
  requestOptions,
  type CommonFailure,
  type RegisterOptions,
} from "./agents.ts";
import { platformText, platformUnreachableMessage } from "./client.ts";

/** What anything that is not `reveal` gets. */
export const MASKED = "<an Egma key>";

/**
 * A minted secret, held so that leaking it takes saying so.
 *
 * The same shape the pasted platform key is held in, for the same reason: most
 * leaks are accidents — a value in a template string while somebody was
 * debugging, an object handed to `JSON.stringify`, an inspector printing a
 * field inside an error. So the value is private and every way a string falls
 * out of an object answers with a mask instead.
 */
export class MintedSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret itself. Called where it is written down, and nowhere else. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASKED;
  }

  toJSON(): string {
    return MASKED;
  }

  /** What `console.log` and every Node inspector print. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MASKED;
  }
}

export type MintedKey = {
  readonly id: string;
  readonly name: string | null;
  readonly projectId: string | null;
  /** Enough to tell one key from another, and not enough to be one. */
  readonly looksLike: string;
  readonly secret: MintedSecret;
};

export type Minted =
  | { readonly kind: "minted"; readonly key: MintedKey }
  | {
      readonly kind: "minted-without-secret";
      readonly keyId: string;
      readonly reason: string;
    }
  | { readonly kind: "uncertain"; readonly reason: string }
  | { readonly kind: "already-bound" }
  | CommonFailure;

export type Revoked = { readonly kind: "revoked" } | CommonFailure;

function apiErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "error" in error
    ? platformText(error.error)
    : "";
}

/**
 * Mint one project-scoped key, named for the job it does.
 *
 * The name is what a person reads in the key list a year later, when they are
 * deciding whether revoking it breaks anything — so it says what it is for
 * rather than when it was made.
 */
export async function mintProjectKey(
  input: {
    readonly name: string;
    readonly projectId: string;
    readonly monitoringAgentId: string;
  },
  options: RegisterOptions,
): Promise<Minted> {
  const answer = await createApiKeyRequest(
    {
      name: input.name,
      projectId: input.projectId,
      monitoringAgentId: input.monitoringAgentId,
    },
    requestOptions(options),
  );

  if (
    answer.response?.status === 409 &&
    apiErrorCode(answer.error) === "monitoring_key_already_bound"
  ) {
    return { kind: "already-bound" };
  }

  if (answer.response === undefined) {
    return {
      kind: "uncertain",
      reason:
        `${platformUnreachableMessage(options.url)} The key request may still ` +
        "have completed before its response was lost.",
    };
  }

  const failed = commonFailure(answer, options);
  if (failed !== null) {
    return failed.kind === "refused" && answer.response.status >= 500
      ? {
          kind: "uncertain",
          reason:
            `${failed.reason} The key request may still have completed before ` +
            "the server reported its failure.",
        }
      : failed;
  }

  const keyId = platformText(answer.data?.id);
  const secret =
    typeof answer.data?.secret === "string" ? answer.data.secret.trim() : "";
  if (keyId !== "" && secret === "") {
    return {
      kind: "minted-without-secret",
      keyId,
      reason:
        `Egma minted key ${keyId} but did not return its one-time secret. ` +
        "The CLI will revoke that unusable key.",
    };
  }
  if (answer.data === undefined || keyId === "" || secret === "") {
    return {
      kind: "uncertain",
      reason:
        "Egma answered without enough information to identify and use the new key. " +
        "Key creation may have completed. Check the project's API keys before retrying.",
    };
  }

  return {
    kind: "minted",
    key: {
      id: keyId,
      name: answer.data.name === null ? null : platformText(answer.data.name),
      projectId:
        answer.data.projectId === null ? null : platformText(answer.data.projectId),
      looksLike: platformText(answer.data.looksLike),
      // Trimmed rather than cleaned: a secret is compared byte for byte at the
      // door, so nothing here may quietly take a character out of it.
      secret: new MintedSecret(secret),
    },
  };
}

/** Revoke only the non-secret id of a key the CLI just minted. */
export async function revokeProjectKey(
  apiKeyId: string,
  options: RegisterOptions,
): Promise<Revoked> {
  const answer = await revokeApiKeyRequest(
    { apiKeyId },
    requestOptions(options),
  );

  // A retry after an uncertain response is also complete when this route says
  // the key is already gone. A generic 404 may instead mean an older server
  // has no revoke route, so its error code is part of the proof.
  if (
    answer.response?.status === 404 &&
    apiErrorCode(answer.error) === "no_such_key"
  ) {
    return { kind: "revoked" };
  }

  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const revokedAt = answer.data?.revokedAt;
  if (
    platformText(answer.data?.id) === apiKeyId &&
    typeof revokedAt === "string" &&
    platformText(revokedAt) !== ""
  ) {
    return { kind: "revoked" };
  }
  return {
    kind: "refused",
    reason:
      `Egma answered without confirming that key ${apiKeyId} was revoked. ` +
      "Check the key in Egma before retrying.",
  };
}
