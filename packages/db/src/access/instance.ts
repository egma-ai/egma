import { db } from "../client.ts";
import { organization } from "../schema/tenancy.ts";

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
