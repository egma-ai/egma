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
  loadCloudBilling,
  type LoadedCloudBilling,
} from "./load.ts";

export {
  cloudBillingPlugIn,
  cloudEntitlementSource,
  cloudUsageSink,
  type CloudAdapterOptions,
  type CustomerFundedProviders,
} from "./adapters.ts";

export {
  BILLING_PATH,
  BILLING_WEBHOOK_PATH,
  CREDIT_PATH,
  DOWNGRADE_PATH,
  PORTAL_PATH,
  UPGRADE_PATH,
  billingRoutes,
  billingWebhookRoutes,
  type BillingRoutesOptions,
  type BillingWebhookOptions,
} from "./routes.ts";

/**
 * The Stripe adapter: the client, the signature check, the four admin actions,
 * the hourly meter job and the account setup.
 *
 * Nothing outside this package may import `stripe`, and nothing inside it
 * holds a second client: the gateway below is where the secret is read and
 * where a delivery is proved.
 */
export {
  isSandboxKey,
  stripeGateway,
  type StripeGateway,
  type StripeSettings,
} from "./stripe/gateway.ts";

export {
  BillingStateError,
  CREDIT_AMOUNTS_MICROS,
  CreditAmountError,
  LARGEST_CREDIT_MICROS,
  SMALLEST_CREDIT_MICROS,
  creditAmountRefusal,
  openBillingPortal,
  openCreditCheckout,
  openUpgradeCheckout,
  scheduleDowngrade,
  type HostedPage,
  type ScheduledDowngrade,
} from "./stripe/actions.ts";

export {
  PRO_STATUSES,
  centsFromMicros,
  hourAround,
  isPaying,
  microsFromCents,
  previousHour,
  type AppliedDelivery,
  type MeteredHour,
  type StripeDelivery,
  type StripeFact,
} from "./stripe/facts.ts";

export {
  METER_EVENT_NAMES,
  reportOverageOwed,
  startOverageMeterJob,
  type MeterLog,
  type MeterReport,
  type OverageMeterJob,
} from "./stripe/meter.ts";

export {
  PRICE_LOOKUP_KEYS,
  PRODUCT_METADATA_KEY,
  setUpStripe,
  type HeadOffice,
  type StripeSetup,
  type StripeSetupOptions,
} from "./stripe/setup.ts";

export {
  HANDLED_EVENT_TYPES,
  applyStripeDelivery,
  deliveryFrom,
} from "./stripe/webhook.ts";

export {
  METER_TIMESTAMP_WINDOW_DAYS,
  MOST_HOURS_CAUGHT_UP_AT_ONCE,
  MOST_RECORDS_SWEPT_AT_ONCE,
  accountForBillingAction,
  applyStripeEvent,
  chargeForStoredUsage,
  markOverageReported,
  openBillingAccount,
  overageOwedThrough,
  recordStripeCustomer,
  recordStripePlanObjects,
  readBillingOverview,
  readEntitlementFacts,
  readLedgerBalance,
  seedCloudPlans,
  sweepUnchargedUsage,
  type BillingAccount,
  type BillingOverview,
  type ChargedUsage,
  type CloudPlan,
  type BillingActor,
  type EntitlementFacts,
  type OrganizationOverage,
  type OverageMark,
  type PeriodCharge,
  type SeededPlans,
  type StripePlanObjects,
  type SweptUsage,
} from "./access/index.ts";

export {
  inferenceChargeKey,
  meterEventIdentifier,
  purchasedCreditKey,
  stripeAttemptKey,
  stripeCustomerKey,
  welcomeCreditKey,
} from "./idempotency.ts";

export {
  planCatalogFile,
  readPlanCatalog,
  type PlanCatalog,
  type PlanCode,
  type PlanEntry,
} from "./plans.ts";
