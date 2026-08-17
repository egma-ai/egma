import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../client.ts";
import { inferenceKey } from "../schema/models.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * The keys an organization holds for the Egma model gateway, as hosted Egma
 * keeps them: **a hash, a name, a safe hint and four times.**
 *
 * There is no read here that returns a key, and that is the shape rather than a
 * rule: `COLUMNS` names every column an answer may carry and the hash is not
 * among them, so the secret is absent from every shape this module produces
 * rather than blanked in one it could be forgotten in. An administrator sees a
 * key once, at the moment they create it, and afterwards sees only enough of it
 * to tell it from the other three.
 *
 * **An inference key is not a product key and this is not `api_key`.** A
 * product key resolves to a person, their current role and a project, and opens
 * every ordinary Egma door. This one resolves to an organization and opens one
 * thing: managed model traffic through the Egma model gateway. Two tables
 * rather than a scope column, because that is what makes "an inference key
 * cannot use a normal Egma product interface" true by where the secret is
 * looked up — the product's resolver reads `api_key`, and no row here is in it.
 */

/** An inference key as anybody is ever allowed to see it again. */
export type InferenceKey = {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  /** `<prefix>…<last four>`. Enough to tell two keys apart, never enough to be one. */
  readonly looksLike: string;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
};

const COLUMNS = {
  id: inferenceKey.id,
  organizationId: inferenceKey.organizationId,
  name: inferenceKey.name,
  prefix: inferenceKey.prefix,
  displaySuffix: inferenceKey.displaySuffix,
  createdByUserId: inferenceKey.createdBy,
  createdAt: inferenceKey.createdAt,
  lastUsedAt: inferenceKey.lastUsedAt,
  revokedAt: inferenceKey.revokedAt,
} as const;

type Row = {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly prefix: string;
  readonly displaySuffix: string;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
};

function described(row: Row): InferenceKey {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    looksLike: `${row.prefix}…${row.displaySuffix}`,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * Every inference key this organization holds, live and revoked alike, oldest
 * first.
 *
 * **Administration, so `manage_organization` rather than `read`.** A product key
 * is listed at every role because every role mints one at login and has to be
 * able to rotate their own. Nobody's login mints one of these: an inference key
 * authorizes spending from Egma's provider accounts on the whole organization's
 * behalf, which is the same kind of decision as choosing model access itself,
 * and the permission table already says who makes those.
 *
 * Revoked keys stay in the answer. A key that stopped working is the record of
 * an installation that used to exist, and a list that hid it would leave an
 * administrator wondering whether they ever revoked the one they meant to.
 */
export async function listInferenceKeys(
  auth: AuthContext,
): Promise<readonly InferenceKey[]> {
  authorize(auth, "manage_organization", here(auth));

  const rows = await db()
    .select(COLUMNS)
    .from(inferenceKey)
    .where(within(auth, inferenceKey))
    .orderBy(inferenceKey.id);

  return rows.map(described);
}

export type NewInferenceKey = {
  /** What an administrator calls this key. Required; an unnamed key is unrevokable in practice. */
  readonly name: string;
  /** A single SHA-256 over the high-entropy secret. Hashing is the caller's. */
  readonly hash: string;
  readonly prefix: string;
  readonly displaySuffix: string;
};

/**
 * Mint one, from a secret this module never sees.
 *
 * **The plaintext does not arrive here and cannot.** What is passed in is a
 * hash, a prefix and four characters; the secret itself exists in the route
 * that minted it for exactly as long as it takes to write it into one response,
 * and nothing in this package has ever held it. So "Egma Cloud does not store a
 * readable copy" is true of the argument list before it is true of the table.
 */
export async function createInferenceKey(
  auth: AuthContext,
  input: NewInferenceKey,
): Promise<InferenceKey> {
  authorize(auth, "manage_organization", here(auth));

  const name = input.name.trim();
  if (name === "") {
    throw new UnprocessableInputError(
      "an inference key needs a name — which installation it is for — so that a list of several says which one to revoke",
    );
  }
  if (name.length > 200) {
    throw new UnprocessableInputError(
      "an inference key's name fits in 200 characters; it is a label for telling two installations apart, not a place for anything longer",
    );
  }

  const [row] = await db()
    .insert(inferenceKey)
    .values({
      id: newId("ifk"),
      organizationId: auth.organizationId,
      name,
      hash: input.hash,
      prefix: input.prefix,
      displaySuffix: input.displaySuffix,
      createdBy: auth.userId,
    })
    .returning(COLUMNS);

  if (row === undefined) throw new Error("the inference key was not written");
  return described(row);
}

/**
 * Stop one working, from the next connection onward.
 *
 * **Effective on the next connection and never on the current frame**, which is
 * the promise the gateway's own authentication makes: a key is checked when an
 * HTTP request or a WebSocket opens, so a simulation already speaking finishes
 * on the credential it opened with and the one after it is refused. Nothing
 * caches the answer, so there is no window to wait out.
 *
 * Naming a key in another customer's account changes nothing and answers
 * nothing — the predicate is the caller's own organization, so the row is not
 * there to update. Revoking one already revoked is the same outcome, said
 * without pretending a second revocation happened.
 */
export async function revokeInferenceKey(
  auth: AuthContext,
  inferenceKeyId: string,
): Promise<InferenceKey | undefined> {
  authorize(auth, "manage_organization", here(auth));

  const now = new Date();
  const [row] = await db()
    .update(inferenceKey)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      within(
        auth,
        inferenceKey,
        and(eq(inferenceKey.id, inferenceKeyId), isNull(inferenceKey.revokedAt)),
      ),
    )
    .returning(COLUMNS);

  return row === undefined ? undefined : described(row);
}

/** Which organization one good inference key acts for, and which key it was. */
export type ResolvedInferenceKey = {
  readonly inferenceKeyId: string;
  readonly organizationId: string;
};

/**
 * A key's hash turned into the organization it authorizes, or nothing.
 *
 * **The whole of what an inference key resolves to, and deliberately not an
 * `AuthContext`.** A product key resolves to a person, a role and a project
 * because it opens doors that read a customer's data; this one opens exactly
 * one thing and the only question that thing asks is which organization the
 * connection acts for. Answering with a context would be answering a question
 * nobody asked with an authority nobody granted — and it is what would let a
 * later door accept this credential by mistake.
 *
 * No context is taken either, for the reason `resolveApiKey` takes none: the
 * caller is a connection that has not established who it is yet, and this read
 * is how it does.
 *
 * A revoked key answers nothing, read from the row rather than from a cache —
 * which is what makes revocation effective on the next connection.
 */
export async function resolveInferenceKey(
  hash: string,
): Promise<ResolvedInferenceKey | undefined> {
  const [row] = await db()
    .select({
      id: inferenceKey.id,
      organizationId: inferenceKey.organizationId,
      lastUsedAt: inferenceKey.lastUsedAt,
    })
    .from(inferenceKey)
    .where(and(eq(inferenceKey.hash, hash), isNull(inferenceKey.revokedAt)))
    .limit(1);

  if (row === undefined) return undefined;

  noteUsed(row.id, row.lastUsedAt);
  return { inferenceKeyId: row.id, organizationId: row.organizationId };
}

/**
 * How stale the stamp may be before it is worth a write.
 *
 * The column answers one question — is anybody still using this key — and a
 * minute's resolution answers it exactly as well as a millisecond's. What the
 * coarseness buys is the hot path: a voice simulation opens several connections
 * and every one of them lands on this row, so a write per connection is every
 * connection on one key queueing behind the same row lock.
 */
const USE_STAMP_WINDOW_MS = 60_000;

/**
 * Write down that a key was used, without a connection waiting for it.
 *
 * **Two ways this stays off the hot path, and both are needed.** It is skipped
 * entirely while the stamp is fresh, so a busy key writes once a minute rather
 * than once a connection — which is what stops every connection on one key
 * contending on one row. And what is left is not awaited: a caller is a voice
 * connection opening, and the answer it is waiting for is already in hand.
 *
 * A failure is swallowed on purpose. This column exists so an operator can see
 * a key nobody needs; a key that works must not stop working because a
 * bookkeeping write did not land.
 */
function noteUsed(inferenceKeyId: string, lastUsedAt: Date | null): void {
  const now = Date.now();
  if (lastUsedAt !== null && now - lastUsedAt.getTime() < USE_STAMP_WINDOW_MS) {
    return;
  }

  void db()
    .update(inferenceKey)
    .set({ lastUsedAt: new Date(now) })
    .where(eq(inferenceKey.id, inferenceKeyId))
    .catch(() => undefined);
}
