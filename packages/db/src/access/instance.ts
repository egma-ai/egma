import { db } from "../client.ts";
import { organization } from "../schema/tenancy.ts";

/**
 * Check whether an organization exists so self-hosted signup can close after
 * the first claim. This public deployment check takes no scope and returns no rows.
 */
export async function instanceIsClaimed(): Promise<boolean> {
  const [row] = await db()
    .select({ id: organization.id })
    .from(organization)
    .limit(1);
  return row !== undefined;
}
