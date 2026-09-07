/** Cloud account, money and Stripe access. Person-facing calls carry AuthContext. */

export {
  activateBilling,
  createBillingAccount,
  openBillingAccount,
  readBillingOverview,
  readEntitlementFacts,
  type BillingAccount,
  type BillingOverview,
  type EntitlementFacts,
} from "./accounts.ts";

export {
  InvalidLedgerCursorError,
  readLedgerBalance,
  readBillingLedger,
  settleInference,
  settleInferenceForOrganization,
  markInferenceSettlementFailed,
  type SettledUsage,
  type BillingLedgerEntry,
  type BillingLedgerPage,
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
