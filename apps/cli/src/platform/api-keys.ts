/**
 * Minting the key a monitored worker exports with.
 *
 * One operation, and one rule around it: the secret exists once, in the answer
 * to the mint, and the only place it is written down is the file the developer
 * agreed to. It is never the terminal's own login credential — that one is this
 * machine's identity, and a worker in a deployment holding it would be that
 * machine everywhere, with nothing to revoke that does not also sign this
 * laptop out.
 *
 * The key is scoped by naming a project. There is no scope field to send: the
 * request names the project and the scope is derived, which is what makes a
 * project key a project key rather than a claim about one.
 */

import { createApiKey as createApiKeyRequest } from "@egma/platform-api/client";

import {
  commonFailure,
  requestOptions,
  type CommonFailure,
  type RegisterOptions,
} from "./agents.ts";
import { platformText } from "./client.ts";

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
  | CommonFailure;

/**
 * Mint one project-scoped key, named for the job it does.
 *
 * The name is what a person reads in the key list a year later, when they are
 * deciding whether revoking it breaks anything — so it says what it is for
 * rather than when it was made.
 */
export async function mintProjectKey(
  input: { readonly name: string; readonly projectId: string },
  options: RegisterOptions,
): Promise<Minted> {
  const answer = await createApiKeyRequest(
    { name: input.name, projectId: input.projectId },
    requestOptions(options),
  );

  const failed = commonFailure(answer, options);
  if (failed !== null) return failed;

  const secret = typeof answer.data?.secret === "string" ? answer.data.secret : "";
  if (answer.data === undefined || secret === "") {
    return {
      kind: "refused",
      reason:
        "Egma minted a key and did not answer with its secret. Check that this Egma platform is up to date.",
    };
  }

  return {
    kind: "minted",
    key: {
      id: platformText(answer.data.id),
      name: answer.data.name === null ? null : platformText(answer.data.name),
      projectId:
        answer.data.projectId === null ? null : platformText(answer.data.projectId),
      looksLike: platformText(answer.data.looksLike),
      // Trimmed rather than cleaned: a secret is compared byte for byte at the
      // door, so nothing here may quietly take a character out of it.
      secret: new MintedSecret(secret.trim()),
    },
  };
}
