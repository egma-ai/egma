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

/** Verified payment facts, current subscription reads, and billing setup. */
export {
  accountForBillingAction,
  applyStripeEvent,
  recordStripeCustomer,
  recordStripeOperationFailure,
  markStripeCustomerFailed,
  setStripePaymentsReady,
  recordStripePlanObjects,
  type BillingActor,
  type StripePlanObjects,
} from "./stripe.ts";

export {
  METER_TIMESTAMP_WINDOW_DAYS,
  MOST_HOURS_CAUGHT_UP_AT_ONCE,
  visitMeterAccounts,
  type MeterAccount,
  type MeterPeriodFact,
  type MeterProgress,
  type NextMeterReport,
  type PendingMeterReport,
} from "./meter.ts";
