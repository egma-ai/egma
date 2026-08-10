import { newId } from "@egma/ids";

import { db } from "../client.ts";
import { platformInstance } from "../schema/platform.ts";

/**
 * What this deployment calls itself, minted the first time anybody asks.
 *
 * The second question about the deployment rather than about a customer, and it
 * is asked by callers with no credential at all: an agent repository reading
 * which platform owns its identifiers, and the same repository checking later
 * that the address it holds still leads to that same platform.
 *
 * It takes no argument, so there is nothing to name and therefore nothing to
 * name wrongly, and it answers one identifier this deployment minted for
 * itself, so it can carry no customer's row out with it. Those two properties
 * are what let it skip the `AuthContext` every other read here requires, and a
 * build rule holds it to both.
 *
 * Minting on first ask rather than in the migration keeps the identifier in the
 * one format egma mints everywhere else. Two instances asking at the same
 * moment race on the single-row primary key: one insert lands, the other adds
 * nothing and reads what landed.
 */
export async function platformInstanceId(): Promise<string> {
  const held = await readInstanceId();
  if (held !== null) return held;

  const [written] = await db()
    .insert(platformInstance)
    .values({ only: true, id: newId("ins") })
    .onConflictDoNothing()
    .returning({ id: platformInstance.id });
  if (written !== undefined) return written.id;

  // Another instance inserted between the read and the write, so its identifier
  // is this deployment's identifier. There is one row and it is now there.
  const raced = await readInstanceId();
  if (raced !== null) return raced;
  throw new Error("this deployment has no instance identifier and would not take one");
}

async function readInstanceId(): Promise<string | null> {
  const [row] = await db()
    .select({ id: platformInstance.id })
    .from(platformInstance)
    .limit(1);
  return row?.id ?? null;
}
