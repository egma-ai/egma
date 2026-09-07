/**
 * `@egma/ee` — Egma's commercially licensed code.
 *
 * Everything here is under `ee/LICENSE`, not the repository's Apache License.
 * The root `LICENSE` says so, and `AGENTS.md` beside this file says what stays
 * out of open code paths.
 *
 * **Nothing imports this package unless a Stripe secret is set.** `apps/api`
 * and `apps/grader` each hold one dynamic `import()` taken only then, so a
 * self-hoster's build never loads a line of it and the open product is exactly
 * the product. That is what makes billing a hosted service rather than a
 * cloud-only feature: a self-hoster who sets the same secret gets the same
 * billing (ADR-0024).
 *
 * What is here: the two adapters the open product's defaults stand in for, the
 * plan rows' boot seed, the Billing section's reads, and the cloud tables'
 * data access behind the same `AuthContext` fence the shared module sits
 * behind.
 */

export {
  cloudBillingPlugIn,
  cloudEntitlementSource,
  cloudUsageSink,
  type CloudAdapterOptions,
  type CustomerFundedProviders,
} from "./adapters.ts";

export {
  BILLING_PATH,
  billingRoutes,
  type BillingRoutesOptions,
} from "./routes.ts";

export {
  chargeForStoredUsage,
  openBillingAccount,
  readBillingOverview,
  readEntitlementFacts,
  readLedgerBalance,
  seedCloudPlans,
  type BillingAccount,
  type BillingOverview,
  type ChargedUsage,
  type CloudPlan,
  type EntitlementFacts,
  type PeriodCharge,
  type SeededPlans,
} from "./access/index.ts";

export { inferenceChargeKey, welcomeCreditKey } from "./idempotency.ts";

export {
  planCatalogFile,
  readPlanCatalog,
  type PlanCatalog,
  type PlanCode,
  type PlanEntry,
} from "./plans.ts";
