import { newId } from "@egma/ids";
import { asc, eq } from "drizzle-orm";

import { db } from "../client.ts";
import { modelProviderCredential } from "../schema/models.ts";
import {
  MODEL_PROVIDERS,
  isModelProvider,
  type ModelProvider,
} from "../models/catalog.ts";
import { sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { IdentityConflictError, UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * The organization's model-provider credentials: one key per provider account,
 * and the one place any of them is stored.
 *
 * **Write-only, and that is a property of this file rather than a promise each
 * caller keeps.** Nothing exported here can produce a plaintext key. `COLUMNS`
 * below names every column an answer may carry, the sealed envelope is not
 * among them, and there is no argument by which any read could be asked for
 * one. The single door to a plaintext key is `resolveModelProviderKeys` in
 * `model-access.ts`, which refuses every context that did not come from a
 * simulation or grading claim. So an admin replaces a key without ever having
 * read the one they are replacing, which is what "a customer's provider key
 * never comes back out" means when it is enforced rather than intended.
 *
 * **One verb writes, and it both adds and rotates.** There is one credential
 * per provider by construction, so "add" and "replace" are the same request
 * with the same effect: the provider's key from now on is this one. Two verbs
 * would only differ in which of them refuses when the caller guessed wrong
 * about what is already stored, and the answer to that is not a refusal.
 *
 * **Saving calls no provider.** A key is sealed and stored, and nothing reaches
 * out to see whether it works. A validation request would make saving depend on
 * the provider being up, would spend on the customer's account to answer a
 * question nobody asked, and would still not be true a minute later — a key
 * revoked after it was checked is exactly as broken as one that never worked.
 * Wrong permissions and expired keys are reported when the provider is used,
 * where the report can name the simulation it stopped.
 */

/**
 * The floor under a provider key, so the stored last-four stays a hint rather
 * than most of the secret it hints at. Real provider keys are tens of
 * characters, so anything this short is a paste gone wrong. The same number
 * every other credential in this codebase is held to: a key is a key wherever
 * it was typed.
 */
const SHORTEST_KEY = 8;

/** How much of a key a person may see: enough to tell two apart, no more. */
const HINT_CHARACTERS = 4;

/**
 * One credential, as everybody but the two claim paths sees it.
 *
 * There is no field here through which a secret could travel, and that is the
 * whole shape of the type: `hint` is four characters chosen so two keys can be
 * told apart, and `provider` names the account without being the key to it.
 */
export type ModelProviderCredential = {
  readonly id: string;
  readonly provider: ModelProvider;
  /** The last characters of the key. Never enough of it to use. */
  readonly hint: string;
  /** The opaque revision of the live half. Hand back as `expectedRevision`. */
  readonly revision: string;
  /** When the stored key last changed, which is what a page shows beside it. */
  readonly updatedAt: Date;
  readonly createdAt: Date;
};

/** An answer's columns, and no more — the sealed envelope is not among them. */
const COLUMNS = {
  id: modelProviderCredential.id,
  provider: modelProviderCredential.provider,
  hint: modelProviderCredential.credentialsHint,
  revision: modelProviderCredential.revision,
  updatedAt: modelProviderCredential.updatedAt,
  createdAt: modelProviderCredential.createdAt,
} as const;

function answer(row: {
  readonly id: string;
  readonly provider: string;
  readonly hint: string;
  readonly revision: string;
  readonly updatedAt: Date;
  readonly createdAt: Date;
}): ModelProviderCredential {
  // The column is pinned by a check constraint, so what comes back is one of
  // the words this module writes.
  return { ...row, provider: row.provider as ModelProvider };
}

function validProvider(provider: string): ModelProvider {
  if (!isModelProvider(provider)) {
    throw new UnprocessableInputError(
      `"${provider}" is not a model provider Egma stores credentials for; expected one of ${MODEL_PROVIDERS.join(", ")}`,
    );
  }
  return provider;
}

/**
 * Trimmed before it is sealed, like every credential this codebase stores: a
 * key pasted with whitespace would pass every check, seal the padding, and fail
 * at the provider with nothing to say the stored value was the problem.
 */
function validKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError("a model-provider credential needs a key");
  }
  if (trimmed.length < SHORTEST_KEY) {
    throw new UnprocessableInputError(
      `a provider key is at least ${SHORTEST_KEY} characters, and this one is shorter than any provider issues`,
    );
  }
  return trimmed;
}

/** The sealed envelope and the hint beside it, from one key. */
function sealed(key: string): {
  readonly credentials: string;
  readonly credentialsHint: string;
} {
  const valid = validKey(key);
  return {
    // Sealed under a fresh initialisation vector every time, exactly as a
    // connection's credentials are: two writes of the same key are two
    // different ciphertexts, so the column tells nobody that nothing changed.
    credentials: sealCredentials({ key: valid }),
    credentialsHint: valid.slice(-HINT_CHARACTERS),
  };
}

/**
 * Every credential the organization holds, in catalog order of the provider.
 *
 * Readable at every role, because it is what a Models form reads to say which
 * providers are configured — by their provider and their hint, which is all any
 * of this ever answers with.
 */
export async function listModelProviderCredentials(
  auth: AuthContext,
): Promise<readonly ModelProviderCredential[]> {
  authorize(auth, "read", here(auth));

  const rows = await db()
    .select(COLUMNS)
    .from(modelProviderCredential)
    .where(within(auth, modelProviderCredential))
    .orderBy(asc(modelProviderCredential.provider));

  return rows.map(answer);
}

export type ModelProviderCredentialInput = {
  readonly provider: string;
  /** In the clear here and sealed before it touches a row. */
  readonly key: string;
  /**
   * What the caller believes is stored, for a replacement. Absent skips the
   * check, which is what an admin adding a provider's first key means.
   */
  readonly expectedRevision?: string | undefined;
};

/**
 * Store this organization's key for one provider, adding it or rotating it.
 *
 * **Only an `admin`.** Storing a key commits the organization's own provider
 * account to every simulation and every verdict that selects it, which is a
 * decision of the same kind as retention and billing rather than one of the
 * same kind as writing a test.
 *
 * **Rotation replaces the whole envelope and keeps the row.** It is sealed over
 * the whole value, so there is no shape in which one could be edited in place;
 * nothing anywhere points at the credential by id, so nothing has to be
 * repointed; and the next claim to be prepared opens the new secret. Work
 * already claimed keeps the key it was handed, which is what makes rotation
 * safe to do in the middle of a run.
 *
 * **It mints no persona or grader version.** A credential is operational state
 * and an authored version is behavior; a rotation that created a version would
 * make every run's history depend on when somebody changed a key.
 */
export async function storeModelProviderCredential(
  auth: AuthContext,
  input: ModelProviderCredentialInput,
): Promise<ModelProviderCredential> {
  authorize(auth, "manage_organization", here(auth));

  const provider = validProvider(input.provider);
  const envelope = sealed(input.key);
  const now = new Date();

  return db().transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: modelProviderCredential.id,
        revision: modelProviderCredential.revision,
      })
      .from(modelProviderCredential)
      .where(
        within(
          auth,
          modelProviderCredential,
          eq(modelProviderCredential.provider, provider),
        ),
      )
      .limit(1)
      .for("update");

    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== existing?.revision
    ) {
      throw new IdentityConflictError(
        "Model-provider credential",
        existing?.id ?? provider,
        {
          expected: input.expectedRevision,
          current: existing?.revision ?? "none",
        },
      );
    }

    if (existing !== undefined) {
      // A bare `eq` on an id that just came off the tenancy-checked row locked
      // above, in this same transaction, so it reaches no further than that
      // check already did.
      const [rotated] = await tx
        .update(modelProviderCredential)
        .set({
          ...envelope,
          revision: newId("rev"),
          // **Theirs from now on.** This row may have been written by the
          // upgrade from a legacy key it found, and while that is true a
          // rotation of that legacy row still reaches it. An administrator
          // typing a key here is a later and better answer than any legacy row
          // can offer, so the provenance is given up and nothing the upgrade
          // does can touch this credential again.
          upgradedFrom: null,
          updatedAt: now,
        })
        .where(eq(modelProviderCredential.id, existing.id))
        .returning(COLUMNS);

      if (rotated === undefined) {
        throw new Error("the model-provider credential was not written");
      }
      return answer(rotated);
    }

    const [added] = await tx
      .insert(modelProviderCredential)
      .values({
        id: newId("mpc"),
        organizationId: auth.organizationId,
        provider,
        ...envelope,
        revision: newId("rev"),
        createdBy: auth.userId,
        updatedAt: now,
      })
      .returning(COLUMNS);

    if (added === undefined) {
      throw new Error("the model-provider credential was not written");
    }
    return answer(added);
  });
}

/**
 * Take the organization's key for one provider away.
 *
 * **Deleted rather than archived, and nothing is scanned first.** No frozen
 * plan and no pinned version names this row — a persona and a grader name the
 * *provider* — so there is no work to strand and no history to make
 * unreadable. Removing it is the honest way to say "Egma no longer holds our
 * key for this account", and a simulation that then needs one lands as an
 * infrastructure error naming the provider, which is a better answer than a
 * credential nobody meant to keep.
 *
 * Answers the credential that was removed, or `undefined` where the
 * organization held none — which is the same outcome as removing one, said
 * without pretending a row existed.
 */
export async function removeModelProviderCredential(
  auth: AuthContext,
  provider: string,
): Promise<ModelProviderCredential | undefined> {
  authorize(auth, "manage_organization", here(auth));

  const [row] = await db()
    .delete(modelProviderCredential)
    .where(
      within(
        auth,
        modelProviderCredential,
        eq(modelProviderCredential.provider, validProvider(provider)),
      ),
    )
    .returning(COLUMNS);

  return row === undefined ? undefined : answer(row);
}
