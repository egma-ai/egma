import type { BillingPlugIn } from "@egma/db";

import { cloudBillingPlugIn, type CloudAdapterOptions } from "./adapters.ts";
import { seedCloudPlans } from "./access/index.ts";
import { billingRoutes } from "./routes.ts";

/**
 * Loading the cloud billing adapter: the plan rows, the two ports, and the
 * Billing section's reads.
 *
 * **The plan rows come with the plug-in and not with one of the processes.**
 * An account names a plan code and the database holds it to a plan row, so a
 * process that installed the adapter without writing the rows would meet that
 * key the first time a customer asked a money question. Two processes install
 * this adapter — the API and the grader — and either can boot first, so the
 * seed is part of loading rather than a line in one entry point.
 *
 * It is safe to run on every boot in every process: the upsert writes nothing
 * where the file has not changed, exactly as the rate card's does.
 */
export type LoadedCloudBilling = {
  readonly plugIn: BillingPlugIn;
  /** The Billing section's routes, for the process that serves HTTP. */
  readonly routes: typeof billingRoutes;
  /** The plan codes this boot wrote. Empty when the file changed nothing. */
  readonly seededPlans: readonly string[];
};

export async function loadCloudBilling(
  options: CloudAdapterOptions = {},
): Promise<LoadedCloudBilling> {
  const seeded = await seedCloudPlans();
  return {
    plugIn: cloudBillingPlugIn(options),
    routes: billingRoutes,
    seededPlans: seeded.written,
  };
}
