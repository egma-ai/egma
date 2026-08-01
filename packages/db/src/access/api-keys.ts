import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../client.ts";
import { apiKey } from "../schema/tenancy.ts";
import type { ApiKeyScope } from "../schema/columns.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
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

/**
 * Every key in the caller's organization, including the organization-scoped
 * ones that name no project: an owner responding to a leak has to be able to
 * see and revoke every key, not only the ones for the project they are in.
 */
export async function listApiKeys(auth: AuthContext): Promise<readonly ApiKey[]> {
  return db()
    .select(COLUMNS)
    .from(apiKey)
    .where(within(auth, apiKey))
    .orderBy(apiKey.id);
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
 */
export async function revokeApiKey(
  auth: AuthContext,
  apiKeyId: string,
): Promise<ApiKey | undefined> {
  const [row] = await db()
    .update(apiKey)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      within(auth, apiKey, and(eq(apiKey.id, apiKeyId), isNull(apiKey.revokedAt))),
    )
    .returning(COLUMNS);
  return row;
}
