import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { db } from "../client.ts";
import { platformInstance } from "../schema/platform.ts";
import { organization } from "../schema/tenancy.ts";

/**
 * The stable, public identity of this whole Egma platform.
 *
 * It belongs to no organization and carries no customer data. The first read
 * mints it. A concurrent first read can lose the insert race, then reads the
 * winner, so every API process answers with one value.
 */
export async function platformInstanceId(): Promise<string> {
  const minted = newId("pf");
  const [inserted] = await db()
    .insert(platformInstance)
    .values({ singleton: true, id: minted })
    .onConflictDoNothing({ target: platformInstance.singleton })
    .returning({ id: platformInstance.id });
  if (inserted !== undefined) return inserted.id;

  const [held] = await db()
    .select({ id: platformInstance.id })
    .from(platformInstance)
    .where(eq(platformInstance.singleton, true))
    .limit(1);
  if (held === undefined) {
    throw new Error("the platform instance identity could not be read");
  }
  return held.id;
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
