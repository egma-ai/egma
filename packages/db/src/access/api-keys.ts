import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { apiKey } from "../schema/tenancy.ts";
import type { ApiKeyScope } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { membershipsOf } from "./memberships.ts";
import { permitsApiKeyMintedBy, type ActionScope } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * An API key as anyone is ever allowed to see it again. The hash never leaves
 * this module and the secret was shown once, at creation, by whoever minted it.
 */
export type ApiKey = {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly scope: ApiKeyScope;
  readonly prefix: string;
  readonly displaySuffix: string;
  readonly name: string | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
};

const COLUMNS = {
  id: apiKey.id,
  organizationId: apiKey.organizationId,
  projectId: apiKey.projectId,
  scope: apiKey.scope,
  prefix: apiKey.prefix,
  displaySuffix: apiKey.displaySuffix,
  name: apiKey.name,
  lastUsedAt: apiKey.lastUsedAt,
  revokedAt: apiKey.revokedAt,
  createdByUserId: apiKey.createdByUserId,
  createdAt: apiKey.createdAt,
} as const;

/** Where the caller is acting, for the per-key predicate below. */
function here(auth: AuthContext): ActionScope {
  return { organizationId: auth.organizationId, projectId: auth.projectId };
}

/**
 * The keys in the caller's organization that the caller may see.
 *
 * **Filtered by role, never gated by it.** An `admin` sees every key in the
 * organization, so responding to a leak does not depend on the person who
 * created one; everybody else sees the keys they minted themselves. Refusing
 * the whole call to anyone but an admin would leave a `viewer` holding a key
 * they could never list and therefore never rotate — and login mints a key for
 * every role, so that is not an edge case, it is most of the instance.
 *
 * The predicate is applied per row rather than as one decision about the whole
 * call, and it is `permitsApiKeyMintedBy` rather than a comparison written out
 * here, because a rule spread across call sites is a rule nobody audits.
 * Organization-scoped keys that name no project are included: an owner has to
 * be able to see every key, not only the ones for the project they are in.
 */
export async function listApiKeys(auth: AuthContext): Promise<readonly ApiKey[]> {
  const rows = await db()
    .select(COLUMNS)
    .from(apiKey)
    .where(within(auth, apiKey))
    .orderBy(apiKey.id);

  return rows.filter((row) =>
    permitsApiKeyMintedBy(auth, row.createdByUserId, here(auth)),
  );
}

export type NewApiKey = {
  /** A single SHA-256 over the high-entropy secret. Hashing is the caller's. */
  readonly hash: string;
  readonly prefix: string;
  readonly displaySuffix: string;
  readonly name?: string | null;
  /** Absent means an organization-scoped key. */
  readonly projectId?: string | null;
};

/**
 * The organization comes from the context and the creator comes from the
 * context, because a key resolves its creator's *current* role at request time
 * and so must always have one.
 *
 * A project id may be named — the device-approval page is where a person picks
 * which project their terminal is authorized for — and a project belonging to
 * another customer is refused here, before the insert is attempted.
 */
export async function createApiKey(
  auth: AuthContext,
  input: NewApiKey,
): Promise<ApiKey> {
  const projectId = input.projectId ?? null;

  if (projectId !== null && !(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const [row] = await db()
    .insert(apiKey)
    .values({
      id: newId("key"),
      organizationId: auth.organizationId,
      projectId,
      scope: projectId === null ? "organization" : "project",
      hash: input.hash,
      prefix: input.prefix,
      displaySuffix: input.displaySuffix,
      name: input.name ?? null,
      createdByUserId: auth.userId,
    })
    .returning(COLUMNS);

  if (row === undefined) throw new Error("the api key was not written");
  return row;
}

/**
 * Revoking takes effect on the very next request, because verification reads
 * `revoked_at` rather than a cache. Naming a key in another customer's account
 * changes nothing and returns nothing — the predicate is the caller's own
 * organization, so the row is not there to update.
 *
 * The same per-key rule as the list applies: your own key at any role, and
 * anybody's key as an `admin`. Keys never expire, so a key is only ever retired
 * by somebody who decided to.
 */
export async function revokeApiKey(
  auth: AuthContext,
  apiKeyId: string,
): Promise<ApiKey | undefined> {
  const [existing] = await db()
    .select({ createdByUserId: apiKey.createdByUserId })
    .from(apiKey)
    .where(within(auth, apiKey, eq(apiKey.id, apiKeyId)))
    .limit(1);

  if (
    existing === undefined ||
    !permitsApiKeyMintedBy(auth, existing.createdByUserId, here(auth))
  ) {
    return undefined;
  }

  const [row] = await db()
    .update(apiKey)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      within(auth, apiKey, and(eq(apiKey.id, apiKeyId), isNull(apiKey.revokedAt))),
    )
    .returning(COLUMNS);
  return row;
}

/**
 * Every live key somebody minted in one organization, revoked at once.
 *
 * Internal, and it takes wherever the statement should run so that removing
 * somebody from an organization can revoke their keys and delete their
 * membership in a single transaction. The predicates are the organization and
 * the creator rather than an `AuthContext`, because the caller already resolved
 * both from one — this is the same write, inside the same transaction, and
 * splitting it across two exported calls is what would let one half happen
 * without the other.
 */
export async function revokeApiKeysMintedBy(
  on: Queryable,
  organizationId: string,
  userId: string,
): Promise<number> {
  const revoked = await on
    .update(apiKey)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(apiKey.organizationId, organizationId),
        eq(apiKey.createdByUserId, userId),
        isNull(apiKey.revokedAt),
      ),
    )
    .returning({ id: apiKey.id });

  return revoked.length;
}

/** A key, and the context a request carrying it acts in. */
export type ResolvedApiKey = {
  readonly apiKeyId: string;
  readonly auth: AuthContext;
};

/**
 * A key's secret hash turned into who is asking, which customer, which project
 * and what role. The sibling of resolving a browser session, and the reason the
 * auth provider is absent from the programmatic path entirely: egma minted this
 * key, egma hashed it, and egma verifies it against its own table.
 *
 * Every link in the chain is re-read on this request rather than remembered:
 *
 *     the key row → who minted it → their membership now → their role now
 *
 * **A key carries no role of its own.** Demote somebody and every key they ever
 * minted acts at the new role on their next request, with no key row edited and
 * nothing to hunt down. The membership is read through the one resolver, so the
 * same rule holds here as everywhere else.
 *
 * Three ways this answers nobody, and each is a promise the product makes. The
 * key was revoked, so revocation takes effect on the very next request with no
 * cache to wait out. The person who minted it was deactivated, so an IT
 * deprovisioning script stops their credentials working without touching a line
 * of what they authored. Or they are no longer in that organization, so a key
 * cannot outlive the membership it borrows its powers from.
 *
 * The second of those is read off the membership rather than looked up here, so
 * that the browser path and this one are answering it from the same place
 * rather than each remembering to ask.
 *
 * The organization is the key row's. Nothing the client sent is consulted, so a
 * copied key cannot reach across a boundary by asking nicely.
 */
export async function resolveApiKey(
  hash: string,
): Promise<ResolvedApiKey | undefined> {
  const [key] = await db()
    .select({
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      projectId: apiKey.projectId,
      createdByUserId: apiKey.createdByUserId,
    })
    .from(apiKey)
    .where(and(eq(apiKey.hash, hash), isNull(apiKey.revokedAt)))
    .limit(1);

  if (key === undefined) return undefined;

  const membership = (await membershipsOf(key.createdByUserId)).find(
    (held) => held.organizationId === key.organizationId,
  );
  if (membership === undefined) return undefined;
  if (membership.deactivatedAt !== null) return undefined;

  await noteApiKeyUsed(key.id);

  return {
    apiKeyId: key.id,
    auth: {
      userId: key.createdByUserId,
      organizationId: key.organizationId,
      // Exactly what the key row says, and nothing filled in for it. An
      // organization-scoped key names no project because it is for the whole
      // customer, so the context it produces names none either.
      projectId: key.projectId ?? undefined,
      role: membership.role,
      via: "api_key",
    },
  };
}

/**
 * When a key was last used, so a key nobody needs is visible as one and gets
 * revoked deliberately rather than left running.
 *
 * Internal, and written on the request it describes: a separate call would be a
 * thing to forget, and the whole value of the column is that it is never stale
 * in the direction that matters.
 */
async function noteApiKeyUsed(apiKeyId: string): Promise<void> {
  await db()
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, apiKeyId));
}
