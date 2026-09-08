import { eq } from "drizzle-orm";
import { db } from "../client.ts";
import { providerKey } from "../schema/provider-keys.ts";
import { isModelProvider, type ModelProvider } from "../models/catalog.ts";
/** Metadata-only organization funding facts for the installed billing adapter. */
export async function listCustomerFundedProviders(
  organizationId: string,
): Promise<readonly ModelProvider[]> {
  const rows = await db()
    .select({ provider: providerKey.provider })
    .from(providerKey)
    .where(eq(providerKey.organizationId, organizationId));
  return rows.map((row) => {
    if (!isModelProvider(row.provider))
      throw new Error("The saved provider key has an invalid provider.");
    return row.provider;
  });
}
