import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { db, type Database } from "../client.ts";
import { platformInstance } from "../schema/platform.ts";
import { organization } from "../schema/tenancy.ts";

/**
 * The answer, once this deployment has given it.
 *
 * It is held against the connection that answered rather than in a bare
 * variable, because one process can serve two databases in a lifetime — a test
 * closes an instance and starts another — and each of those is a different
 * platform with a different identity. `connect` builds a new query interface,
 * so a new connection is a new object here and the held answer is not reused
 * across a platform boundary, which is the one mistake a cache like this could
 * make that would matter.
 */
let held: { readonly connection: Database; readonly id: string } | undefined;

async function storedInstanceId(): Promise<string | undefined> {
  const [row] = await db()
    .select({ id: platformInstance.id })
    .from(platformInstance)
    .where(eq(platformInstance.singleton, true))
    .limit(1);
  return row?.id;
}

/**
 * The stable, public identity of this whole Egma platform.
 *
 * It belongs to no organization and carries no customer data. The first read
 * mints it, and every read after that is a read.
 *
 * **Reading before writing is the point, not an optimization.** This answers an
 * unauthenticated route that anybody who can reach the platform may call as
 * often as they like. An insert that conflicts is still an insert: Postgres
 * writes the tuple, writes the index entry, writes it to the log, and only then
 * discards it, so a speculative insert on every request lets a stranger grow
 * dead rows on this table for free. The sibling public read on this deployment,
 * `instanceIsClaimed`, is a plain select for the same reason.
 *
 * The insert stays for the one request that finds nothing, and it keeps
 * `onConflictDoNothing` because two processes can arrive at that moment
 * together — the loser reads the winner's row rather than failing.
 */
export async function platformInstanceId(): Promise<string> {
  const connection = db();
  if (held?.connection === connection) return held.id;

  const found = await storedInstanceId();
  if (found !== undefined) {
    held = { connection, id: found };
    return found;
  }

  const [inserted] = await db()
    .insert(platformInstance)
    .values({ singleton: true, id: newId("pf") })
    .onConflictDoNothing({ target: platformInstance.singleton })
    .returning({ id: platformInstance.id });

  const settled = inserted?.id ?? (await storedInstanceId());
  if (settled === undefined) {
    throw new Error("the platform instance identity could not be read");
  }
  held = { connection, id: settled };
  return settled;
}

/**
 * Whether anybody has signed up here yet.
 *
 * This is the one question about the deployment rather than about a customer,
 * and it is asked by the one caller who has no credential at all: somebody
 * looking at a signup form. On a self-hosted instance the first person to sign
 * up claims it and becomes its admin, and open signup closes behind them —
 * without that, anyone who can reach the URL signs up, joins the only
 * organization, and administers somebody else's egma.
 *
 * It takes no argument, so there is nothing to name and therefore nothing to
 * name wrongly, and it returns a boolean, so it can carry no row out with it.
 * Those two properties are the whole reason it is allowed to skip the
 * `AuthContext` every other read here requires, and a build rule holds it to
 * both.
 */
export async function instanceIsClaimed(): Promise<boolean> {
  const [row] = await db()
    .select({ id: organization.id })
    .from(organization)
    .limit(1);
  return row !== undefined;
}
