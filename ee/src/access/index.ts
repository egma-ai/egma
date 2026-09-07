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
 *
 * A fourth is named there and takes nothing at all: the sweep that charges the
 * stored records a failed sink never charged. It walks the deployment's own
 * unpaid records, so there is no customer to name it and no context to carry.
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
  MOST_RECORDS_SWEPT_AT_ONCE,
  chargeForStoredUsage,
  readLedgerBalance,
  sweepUnchargedUsage,
  type ChargedUsage,
  type PeriodCharge,
  type SweptUsage,
} from "./ledger.ts";

export { seedCloudPlans, type CloudPlan, type SeededPlans } from "./plans.ts";

/**
 * The rows Stripe moves. Nothing here reaches Stripe: the client is one
 * directory over, and each of these is handed a fact it has already proved.
 *
 * Three of them take no `AuthContext` and the lint rule names all three. A
 * webhook carries no person — the signature is the credential and the
 * organization is read off Egma's own account row, never off the payload — and
 * the hourly sweep walks every Pro organization on the deployment, so there is
 * none to hand it.
 */
export {
  METER_TIMESTAMP_WINDOW_DAYS,
  MOST_HOURS_CAUGHT_UP_AT_ONCE,
  accountForBillingAction,
  applyStripeEvent,
  markOverageReported,
  overageOwedThrough,
  recordStripeCustomer,
  recordStripePlanObjects,
  type BillingActor,
  type OrganizationOverage,
  type OverageMark,
  type StripePlanObjects,
} from "./stripe.ts";
