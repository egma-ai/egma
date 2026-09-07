import type { BillingPlugIn } from "@egma/db";
import { cloudBillingPlugIn, type CloudAdapterOptions } from "./adapters.ts";
import {
  activateBilling,
  seedCloudPlans,
  settleInference,
  type SettledUsage,
} from "./access/index.ts";
import { billingRoutes } from "./routes.ts";

export type LoadedCloudBilling = {
  readonly plugIn: BillingPlugIn;
  readonly routes: typeof billingRoutes;
  readonly seededPlans: readonly string[];
  readonly caughtUp: SettledUsage;
};

/** Billing can recover after serving begins; it cannot prevent process boot. */
export async function loadCloudBilling(
  options: CloudAdapterOptions = {},
): Promise<LoadedCloudBilling> {
  let seededPlans: readonly string[] = [];
  let caughtUp: SettledUsage = { charged: 0, amountMicros: 0 };
  try {
    seededPlans = (await seedCloudPlans()).written;
    await activateBilling(options.now?.() ?? new Date());
    caughtUp = await settleInference(options.now?.() ?? new Date());
  } catch (fault) {
    console.error(
      "Billing initialization failed; customer work continues",
      fault,
    );
  }
  return {
    plugIn: cloudBillingPlugIn(options),
    routes: billingRoutes,
    seededPlans,
    caughtUp,
  };
}
