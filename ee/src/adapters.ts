import {
  ALLOWANCE_UNITS,
  type AllowanceKind,
  type AllowanceRefusal,
  type BillingPlugIn,
  type EntitlementSource,
  type FundingDecision,
  type FundingRequest,
  type StartDecision,
  type StartRequest,
  faultTolerantEntitlements,
  discardingUsageSink,
  type UsageSink,
} from "@egma/db";

import { readPlanCatalog } from "./plans.ts";

import {
  createBillingAccount,
  openBillingAccount,
  readEntitlementFacts,
  type BillingAccount,
  type CloudPlan,
  type EntitlementFacts,
} from "./access/index.ts";

/**
 * The cloud adapters: the two the open product's defaults stand in for.
 *
 * **They answer from rows and never from a network call.** The plan, the
 * allowances used this period and the inference balance are all in Egma's own
 * Postgres, so the two questions the product asks — may this work start, may
 * Egma's key pay for it — are indexed local reads. Stripe is never on this
 * path; it moves money through webhooks and an hourly job, and a Stripe that
 * is down never stops a customer who has already paid. See ADR-0024 and
 * ADR-0025.
 *
 * **Nothing here asks whether this deployment is Egma Cloud.** These adapters
 * are installed because a Stripe secret is set, by whoever set it. A
 * self-hoster who sets one gets exactly this.
 */

/**
 * Where a provider's work is paid from, per provider, for one organization.
 *
 * **The seam Naman's provider-keys effort plugs into.** Today no organization
 * holds a key of its own, so the default answers "none" and every provider is
 * funded from the balance — which is the behaviour of the product as it
 * stands. When organization-scoped customer keys arrive, the deployment hands
 * one function in here and nothing else in this package moves.
 *
 * It answers the providers this organization holds its **own working key**
 * for. A key that fails is not this seam's business: a failing customer key
 * fails the work by name and never falls back to Egma's key, which is decided
 * where the key is used, not here.
 */
export type CustomerFundedProviders = (
  organizationId: string,
) => Promise<readonly string[]>;

export type CloudAdapterOptions = {
  readonly customerFundedProviders?: CustomerFundedProviders;
  /** The clock, so a test can stand in a month. */
  readonly now?: () => Date;
};

const NOBODY_HAS_THEIR_OWN_KEY: CustomerFundedProviders = () =>
  Promise.resolve([]);

/** The three months, four... the absolute short date, as `DESIGN.md` asks. */
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * A date a person can put in a calendar, written the same way in every locale
 * this process might be started in. `toLocaleDateString` would answer
 * differently on a machine with a different ICU build, and a reset date that
 * moved with the server is a support ticket.
 */
function dateLabel(at: Date): string {
  return `${MONTHS[at.getUTCMonth()] ?? "?"} ${at.getUTCDate()}, ${at.getUTCFullYear()}`;
}

/** Millionths of a US dollar, as money is written. */
function moneyLabel(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / 1_000_000).toFixed(2)}`;
}

/** What a plan allows of one kind. `null` is unlimited. */
function allowanceOf(plan: CloudPlan, kind: AllowanceKind): number | null {
  switch (kind) {
    case "chat_simulations":
      return plan.chatSimulationsAllowance;
    case "web_call_minutes":
      return plan.webCallMinutesAllowance;
    case "phone_minutes":
      return plan.phoneMinutesAllowance;
  }
}

/** What the allowance is called in a sentence. */
const ALLOWANCE_NAMES: Readonly<Record<AllowanceKind, string>> = {
  chat_simulations: "chat simulations",
  web_call_minutes: "web-call minutes",
  phone_minutes: "phone minutes",
};

/**
 * The sentence a person meets when an allowance is spent.
 *
 * Written here rather than assembled by whoever shows it, because the layer
 * that shows a refusal would have to read the parts back to rebuild the
 * sentence — and the prose is the part deliberately left free to improve.
 */
function allowanceSpentMessage(
  kind: AllowanceKind,
  plan: CloudPlan,
  allowed: number,
  resetsAt: Date,
): string {
  const what = ALLOWANCE_NAMES[kind];
  const unit = ALLOWANCE_UNITS[kind];
  const counted = unit === "minutes" ? `${allowed} minutes` : `${allowed}`;
  const next =
    plan.code === "hobby"
      ? "Move to Pro for a larger allowance, or wait for the reset."
      : "The allowance resets then.";
  return (
    `This organization has used all ${counted} of its ${what} on the ` +
    `${plan.name} plan for this period. It resets on ${dateLabel(resetsAt)}. ` +
    `${next} Open Settings → Usage and billing to see the plan and this period's ` +
    "usage."
  );
}

/** The sentence a person meets when Egma's key cannot pay for a provider. */
function unfundedMessage(
  providers: readonly string[],
  balanceMicros: number,
): string {
  const named =
    providers.length === 1
      ? providers[0]
      : `${providers.slice(0, -1).join(", ")} and ${providers.at(-1)}`;
  return (
    `Egma's provider keys cannot fund ${named}: this organization's ` +
    `inference balance is ${moneyLabel(balanceMicros)}. Add inference credit ` +
    "under Settings → Usage and billing, or use your own provider keys, and this " +
    "work runs on its own."
  );
}

/** Which of the asked allowances this plan and this period have spent. */
function refusalsAmong(
  asked: readonly AllowanceKind[],
  facts: EntitlementFacts,
): readonly AllowanceRefusal[] {
  const refusals: AllowanceRefusal[] = [];
  for (const kind of asked) {
    // Pro voice continues beyond its included minutes and incurs metered overage.
    if (facts.plan.code === "pro" && kind !== "chat_simulations") continue;
    const allowed = allowanceOf(facts.plan, kind);
    if (allowed === null) continue;
    if (facts.usage.used[kind] < allowed) continue;
    refusals.push({
      allowance: kind,
      resetsAt: facts.period.resetsAt,
      message: allowanceSpentMessage(kind, facts.plan, allowed, facts.period.resetsAt),
    });
  }
  return refusals;
}

function billingIsUnreliable(account: BillingAccount): boolean {
  return account.settlementFailedAt !== null || account.stripeFailedAt !== null || !account.stripePaymentsReady;
}

export function cloudEntitlementSource(
  options: CloudAdapterOptions = {},
): EntitlementSource {
  const now = options.now ?? (() => new Date());
  const customerFunded =
    options.customerFundedProviders ?? NOBODY_HAS_THEIR_OWN_KEY;

  return faultTolerantEntitlements({
    async mayStart(request: StartRequest): Promise<StartDecision> {
      // Nothing was asked about, so nothing can be refused. The contract says
      // so and it is the honest answer: an empty batch spends no allowance.
      if (request.allowances.length === 0) return { allowed: true };

      const facts = await readEntitlementFacts(request.organizationId, now());
      if (billingIsUnreliable(facts.account)) return { allowed: true };
      const refusals = refusalsAmong(request.allowances, facts);
      return refusals.length === 0 ? { allowed: true } : { allowed: false, refusals };
    },

    async mayPlatformKeyFund(request: FundingRequest): Promise<FundingDecision> {
      if (request.providers.length === 0) return { funded: true };

      // A provider the customer holds their own key for is not Egma's to fund
      // and costs this balance nothing.
      const theirs = new Set(await customerFunded(request.organizationId));
      const onEgmasKey = request.providers.filter(
        (provider) => !theirs.has(provider),
      );
      if (onEgmasKey.length === 0) return { funded: true };

      // Balance, billing health and the welcome grant share one indexed read.
      // Funding does not need the conversation aggregate or a Stripe request.
      const account = await openBillingAccount(request.organizationId);

      // **Above zero, and not "enough".** Egma cannot know what a simulation
      // will cost before it runs, so the rule is the one the founders set: new
      // balance-funded work is refused at zero, and work already claimed
      // finishes and is charged.
      if (billingIsUnreliable(account) || account.balanceMicros > 0) return { funded: true };

      return {
        funded: false,
        providers: onEgmasKey,
        message: unfundedMessage(onEgmasKey, account.balanceMicros),
      };
    },
  });
}

/** Charging runs on observed intervals; notifications need no cloud action. */
export function cloudUsageSink(): UsageSink {
  return discardingUsageSink();
}

/** Both cloud adapters, as one deployment holds them. */
export function cloudBillingPlugIn(
  options: CloudAdapterOptions = {},
): BillingPlugIn {
  return {
    entitlements: cloudEntitlementSource(options),
    usage: cloudUsageSink(),
    async organizationCreated(on, organizationId) {
      await createBillingAccount(on, organizationId, await readPlanCatalog());
    },
  };
}
