/**
 * Project keys used by monitored workers.
 *
 * Minting returns the secret once, and the only place it is written down is
 * the file the developer agreed to. The stable agent id in the key name lets
 * the CLI find its own keys through the existing key list; no monitoring-only
 * database relationship is needed. The worker never receives the terminal's
 * own login credential — that one is this machine's identity, and revoking it
 * would also sign this laptop out.
 *
 * The key is scoped by naming a project. There is no scope field to send: the
 * request names the project and the scope is derived, which is what makes a
 * project key a project key rather than a claim about one.
 */

import {
  createApiKey as createApiKeyRequest,
  listApiKeys as listApiKeysRequest,
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
  | { readonly kind: "active-name-conflict" }
  | CommonFailure;

/** A generic Project key created for the developer, not for a CLI-owned job. */
export type CreatedProjectKey =
  | { readonly kind: "created"; readonly key: MintedKey }
  | CommonFailure;

export type Revoked = { readonly kind: "revoked" } | CommonFailure;

export type ActiveProjectKey = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly looksLike: string;
};

export type ListedProjectKeys =
  | { readonly kind: "listed"; readonly keys: readonly ActiveProjectKey[] }
  | CommonFailure;

function apiErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "error" in error
    ? platformText(error.error)
    : "";
}

/**
 * Create one ordinary Project-scoped key.
 *
 * The existing platform contract derives the scope from `projectId`. There is
 * no scope flag and no Agent association to invent here. The secret is wrapped
 * as soon as it crosses the HTTP boundary so callers must opt in to revealing
 * it at the one output line that is allowed to print it.
 */
export async function createProjectKey(
  input: { readonly name: string; readonly projectId: string },
  options: RegisterOptions,
): Promise<CreatedProjectKey> {
  const answer = await createApiKeyRequest(
    { body: { name: input.name, projectId: input.projectId } },
    requestOptions(options),
  );

  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const id = platformText(answer.data?.id);
  const name = answer.data?.name === null ? null : platformText(answer.data?.name);
  const projectId =
    answer.data?.projectId === null ? null : platformText(answer.data?.projectId);
  const secret =
    typeof answer.data?.secret === "string" ? answer.data.secret.trim() : "";
  if (
    answer.data === undefined ||
    id === "" ||
    name === null ||
    name === "" ||
    projectId === null ||
    projectId === "" ||
    secret === ""
  ) {
    return {
      kind: "refused",
      reason:
        "Egma answered without the complete Project API-key receipt. Check the Project's API keys before retrying.",
    };
  }

  return {
    kind: "created",
    key: {
      id,
      name,
      projectId,
      looksLike: platformText(answer.data.looksLike),
      secret: new MintedSecret(secret),
    },
  };
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
      body: {
        name: input.name,
        projectId: input.projectId,
        monitoringAgentId: input.monitoringAgentId,
      },
    },
    requestOptions(options),
  );

  if (answer.response === undefined) {
    return {
      kind: "uncertain",
      reason:
        `${platformUnreachableMessage(options.url)} The key request may still ` +
        "have completed before its response was lost.",
    };
  }

  if (
    answer.response.status === 409 &&
    apiErrorCode(answer.error) === "active_key_name_conflict"
  ) {
    return { kind: "active-name-conflict" };
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

/**
 * Find live project keys made for one stable agent.
 *
 * Names are the recovery ledger already exposed by the hosted platform. The
 * prefix contains the immutable agent id, so another agent with a similar
 * display name cannot be mistaken for this one. Revoked keys are history and
 * never block a safe retry.
 */
export async function listActiveProjectKeys(
  input: { readonly projectId: string; readonly namePrefix: string },
  options: RegisterOptions,
): Promise<ListedProjectKeys> {
  const answer = await listApiKeysRequest(requestOptions(options));
  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const rows = answer.data?.keys;
  if (!Array.isArray(rows)) {
    return {
      kind: "refused",
      reason:
        "Egma answered without the API-key list. No key was created and no environment file was changed.",
    };
  }

  return {
    kind: "listed",
    keys: rows.flatMap((row) => {
      const id = platformText(row.id);
      const name = row.name === null ? "" : platformText(row.name);
      const projectId = row.projectId === null ? "" : platformText(row.projectId);
      if (
        id === "" ||
        projectId !== input.projectId ||
        row.revokedAt !== null ||
        !name.startsWith(input.namePrefix)
      ) {
        return [];
      }
      return [
        {
          id,
          name,
          projectId,
          looksLike: platformText(row.looksLike),
        },
      ];
    }),
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
