import { newId, type IdPrefix } from "@egma/ids";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./client.ts";
import { deviceCode } from "./schema/device.ts";
import { account, session, user, verification } from "./schema/identity.ts";

/**
 * Bind Better Auth to explicit identity tables through the private database pool.
 * Egma SQL migrations own their schema; no provider migrator is configured.
 */

/**
 * Explicit Better Auth model-to-table mapping. Organization, project, membership,
 * invitation, and API key tables remain behind Egma's data access functions.
 */
const IDENTITY_TABLES = {
  user,
  session,
  account,
  verification,
  deviceCode,
} as const;

export type IdentityModel = keyof typeof IDENTITY_TABLES;

/** The provider's models, and the prefix each one's identifiers carry. */
const IDENTITY_PREFIXES = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "vrf",
  deviceCode: "dvc",
} as const satisfies Record<IdentityModel, IdPrefix>;

export const IDENTITY_MODELS = Object.keys(
  IDENTITY_PREFIXES,
) as readonly IdentityModel[];

/**
 * An identifier for one of the provider's rows, in egma's format.
 *
 * One generator serves every table, egma's and the provider's alike, because an
 * identifier reaches customers' scripts, bookmarked URLs and every referencing
 * row — so two formats would be two formats forever. The provider is handed
 * this rather than left to mint its own.
 */
export function identityId(model: string): string {
  const prefix = IDENTITY_PREFIXES[model as IdentityModel];
  if (prefix === undefined) {
    throw new Error(
      `the auth provider asked for an id for "${model}", which is not one of its tables: ${IDENTITY_MODELS.join(", ")}`,
    );
  }
  return newId(prefix);
}

/**
 * Configure the adapter without provider transactions. After-write provisioning
 * opens a separate transaction and needs the user row to be committed first.
 */
export function identityStore(): ReturnType<typeof drizzleAdapter> {
  return drizzleAdapter(db(), {
    provider: "pg",
    schema: IDENTITY_TABLES,
    transaction: false,
  });
}
