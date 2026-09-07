/**
 * The cloud data-access boundary: the second fenced home.
 *
 * Everything that reads or writes a `cloud_` table lives behind this file, on
 * the same terms `packages/db/src/access/index.ts` sets for the shared
 * tables — an `AuthContext` first on every call a person makes, tenancy
 * predicates built here rather than by a caller, and the query interface
 * reached through the one export `@egma/db` fences to this directory.
 *
 * Three exports take an organization id instead of a context, and all three
 * are named in the lint rule that enforces the rest: they answer the two
 * billing ports, whose shapes are fixed in shared code and neither of which
 * carries a person. A run start, a claim batch and a stored usage record are
 * each Egma asking itself about money it is owed or has spent.
 */

export {
  openBillingAccount,
  readBillingOverview,
  readEntitlementFacts,
  type BillingAccount,
  type BillingOverview,
  type EntitlementFacts,
} from "./accounts.ts";

export {
  chargeForStoredUsage,
  readLedgerBalance,
  type ChargedUsage,
  type PeriodCharge,
} from "./ledger.ts";

export { seedCloudPlans, type CloudPlan, type SeededPlans } from "./plans.ts";
