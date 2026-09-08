import {
  billingIsConfigured,
  listCustomerFundedProviders,
  type BillingPlugIn,
  type BillingSettings,
} from "@egma/db";

/** The grader consumes the shared plug-in and boot result only. */
export type GraderBilling = {
  readonly plugIn: BillingPlugIn;
  readonly seededPlans: readonly string[];
  readonly caughtUp: { readonly charged: number };
};

type BillingModule = {
  loadCloudBilling(options: {
    readonly customerFundedProviders: typeof listCustomerFundedProviders;
  }): Promise<GraderBilling>;
};

export async function loadCloudBilling(
  settings: BillingSettings,
): Promise<GraderBilling | undefined> {
  if (!billingIsConfigured(settings)) return undefined;

  // Resolve the optional package only at runtime, after billing is selected.
  try {
    const packageName: string = "@egma/ee";
    const billing: BillingModule = await import(packageName);
    return await billing.loadCloudBilling({
      customerFundedProviders: listCustomerFundedProviders,
    });
  } catch (fault) {
    console.error("Billing could not load; customer work continues", fault);
    return undefined;
  }
}
