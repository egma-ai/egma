import { newId } from "@egma/ids";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { user } from "../schema/identity.ts";
import { apiKey } from "../schema/tenancy.ts";
import type { ApiKeyScope } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import {
  ActiveApiKeyNameConflictError,
  ProjectOutsideOrganizationError,
} from "./errors.ts";
import { membershipsOf } from "./memberships.ts";
import { authorize, here, permitsApiKeyMintedBy } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { inCredentialProject, within } from "./within.ts";

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

/** A listed key with the human identity of the member who created it. */
export type ListedApiKey = ApiKey & {
  readonly createdByEmail: string;
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

/**
 * List keys within the credential's scope: admins see all permitted keys,
 * other roles see their own. Browser sessions retain organization-wide access.
 */
export async function listApiKeys(
  auth: AuthContext,
): Promise<readonly ListedApiKey[]> {
  authorize(auth, "read", here(auth));

  const rows = await db()
    .select({
      ...COLUMNS,
      createdByEmail: user.email,
    })
    .from(apiKey)
    .innerJoin(user, eq(apiKey.createdByUserId, user.id))
    .where(within(auth, apiKey, inCredentialProject(auth, apiKey.projectId)))
    .orderBy(apiKey.id);

  return rows.filter((row) =>
    permitsApiKeyMintedBy(auth, row.createdByUserId, {
      organizationId: row.organizationId,
      projectId: row.projectId ?? undefined,
    }),
  );
}

type NewApiKeySecret = {
  /** A single SHA-256 over the high-entropy secret. Hashing is the caller's. */
  readonly hash: string;
  readonly prefix: string;
  readonly displaySuffix: string;
};

export type NewApiKey = NewApiKeySecret & (
  | {
    readonly name?: string | null;
    /** Absent means an organization-scoped key. */
    readonly projectId?: string | null;
    readonly activeNamePrefix?: undefined;
  }
  | {
    /** The complete display name, beginning with the reserved prefix. */
    readonly name: string;
    /** Prefix exclusion exists only inside one project. */
    readonly projectId: string;
    /** Refuse while any active project key name begins with this value. */
    readonly activeNamePrefix: string;
  }
);

async function insertApiKey(
  on: Queryable,
  auth: AuthContext,
  input: NewApiKey,
  projectId: string | null,
): Promise<ApiKey> {
  const [row] = await on
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

  authorize(auth, "mint_own_api_key", {
    organizationId: auth.organizationId,
    projectId: projectId ?? undefined,
  });

  if (projectId !== null && !(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  if (input.activeNamePrefix === undefined) {
    return insertApiKey(db(), auth, input, projectId);
  }

  const activeNamePrefix = input.activeNamePrefix;
  const lockKey = JSON.stringify([
    auth.organizationId,
    input.projectId,
    activeNamePrefix,
  ]);

  return db().transaction(async (tx) => {
    // Two guarded creations for the same project prefix wait here. The second
    // request then reads the row written by the first request instead of both
    // deciding from the same empty snapshot.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`,
    );

    const [held] = await tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(
        within(
          auth,
          apiKey,
          and(
            eq(apiKey.projectId, input.projectId),
            isNull(apiKey.revokedAt),
            sql`left(${apiKey.name}, char_length(${activeNamePrefix})) = ${activeNamePrefix}`,
          ),
        ),
      )
      .limit(1);

    if (held !== undefined) throw new ActiveApiKeyNameConflictError();
    return insertApiKey(tx, auth, input, input.projectId);
  });
}

/**
 * Revoke under the same ownership rule as listing: own keys at any role, all keys
 * for admins. Verification reads revoked_at on each request. Out-of-scope keys
 * return no row and remain unchanged.
 */
export async function revokeApiKey(
  auth: AuthContext,
  apiKeyId: string,
): Promise<ApiKey | undefined> {
  const [existing] = await db()
    .select({ createdByUserId: apiKey.createdByUserId, projectId: apiKey.projectId })
    .from(apiKey)
    .where(within(auth, apiKey, and(
      eq(apiKey.id, apiKeyId),
      inCredentialProject(auth, apiKey.projectId),
    )))
    .limit(1);

  if (
    existing === undefined ||
    !permitsApiKeyMintedBy(auth, existing.createdByUserId, {
      organizationId: auth.organizationId,
      projectId: existing.projectId ?? undefined,
    })
  ) {
    return undefined;
  }

  const [row] = await db()
    .update(apiKey)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      within(auth, apiKey, and(
        eq(apiKey.id, apiKeyId),
        isNull(apiKey.revokedAt),
        inCredentialProject(auth, apiKey.projectId),
      )),
    )
    .returning(COLUMNS);
  return row;
}

/**
 * Revoke a member's live organization keys inside the membership-removal transaction.
 * Use the organization and creator already resolved by the caller.
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
 * Resolve a live key using its creator's current organization membership and role.
 * Return undefined for revoked keys, missing memberships, or deactivated members.
 * Take organization and optional project scope from the key row, never the request.
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
