import { newId, type IdPrefix } from "@egma/ids";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "./client.ts";
import { deviceCode } from "./schema/device.ts";
import { account, session, user, verification } from "./schema/identity.ts";

/**
 * How the auth provider reaches the five tables it reads and writes.
 *
 * The provider owns identity and egma owns everything past the front door, but
 * there is still exactly one database and the pool that reaches it is private
 * to this module. So the provider does not get a connection; it gets a binding
 * this module hands it, over five named tables, built on the same pool as every
 * other read and write. That is the boundary working rather than an exception
 * to it: a leak still takes a new export here.
 *
 * egma writes the DDL for all five. The provider's own migrator is not wired up
 * — the adapter below has none, and egma's numbered `.sql` files are the only
 * thing that ever creates or alters a column. The provider can use the tables
 * and cannot change them.
 */

/**
 * The provider's whole footprint on the schema, named one table at a time
 * rather than handed the schema wholesale, so that widening it is a visible
 * change to this list.
 *
 * The keys are the provider's own model names, which is what it looks tables up
 * by. `organization`, `project`, `membership`, `invitation` and `api_key` are
 * deliberately absent: those are egma's, with egma's foreign keys, and the
 * provider is never asked about them.
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
 * The binding the auth provider is configured with. It reaches the five tables
 * above through the module's own pool and nothing else.
 *
 * Transactions are left off: the provider's own after-write hooks are where
 * egma provisions an organization, and that provisioning opens a transaction of
 * its own on a second connection. Inside a provider transaction it could not
 * see the uncommitted user row it is provisioning for, so the two are kept
 * sequential and each is atomic on its own.
 */
export function identityStore(): ReturnType<typeof drizzleAdapter> {
  return drizzleAdapter(db(), {
    provider: "pg",
    schema: IDENTITY_TABLES,
    transaction: false,
  });
}
