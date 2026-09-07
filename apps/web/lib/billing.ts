import { answerFor, readJson, unreachable, type Answer } from "./api.ts";

/**
 * This organization's plan and inference balance, on a deployment that bills.
 *
 * **Absent is the ordinary answer.** A self-hosted Egma has no plan, no balance
 * and no Billing routes at all, so this read answers "not available" and the
 * page shows nothing rather than an empty panel pretending there is a plan to
 * see. That is the same shape the usage panel beside it uses for a refusal:
 * every state says what happened.
 *
 * Money crosses as whole micro-dollars — millionths of a US dollar, the unit
 * every amount in this product is counted in — so nothing rounds on the way
 * here and the page rounds once, where it prints.
 */

/** One allowance the plan includes. `allowed` of `null` is unlimited. */
export type PlanAllowance = {
  /** `chat_simulations`, `web_call_minutes` or `phone_minutes`. */
  readonly kind: string;
  /** `simulations` or `minutes`. */
  readonly unit: string;
  readonly allowed: number | null;
};

export type BillingPlan = {
  readonly code: string;
  readonly name: string;
  readonly feeMicros: number;
  readonly allowances: readonly PlanAllowance[];
};

/** One model's charge against the balance this period. Admins only. */
export type PeriodCharge = {
  readonly provider: string;
  readonly model: string;
  readonly requests: number;
  readonly amountMicros: number;
};

/**
 * What an admin may do here, as the deployment states it.
 *
 * **Sent rather than assumed.** The buttons exist only on a deployment whose
 * Stripe adapter is in place, and a page cannot tell that from a plan: a
 * deployment can hold plans and balances and still be one whose operator has
 * not finished setting Stripe up. The bounds travel too, so the custom amount
 * box refuses what the route would refuse and says the same numbers.
 */
export type BillingActions = {
  readonly available: boolean;
  /** The amounts the picker offers, in micro-dollars. */
  readonly creditAmountsMicros: readonly number[];
  readonly smallestCreditMicros: number;
  readonly largestCreditMicros: number;
};

export type BillingAccount = {
  readonly plan: BillingPlan;
  /** The inference balance in millionths of a US dollar. Can be negative. */
  readonly balanceMicros: number;
  /** ISO-8601, the first instant of the period. */
  readonly periodStartedAt: string;
  /** ISO-8601, the next reset. */
  readonly resetsAt: string;
  readonly mayManageBilling: boolean;
  readonly charges: readonly PeriodCharge[];
  /** Absent on a deployment one release behind these pages. */
  readonly actions?: BillingActions;
};

/**
 * The read, or `null` where this deployment does not bill.
 *
 * A missing answer here is not a failure: it is what a deployment with no
 * Stripe secret says, because the Billing routes are mounted only when one is
 * set. Anything else keeps its own refusal, so a signed-out browser and a
 * broken read stay as distinguishable here as they are everywhere else.
 */
export async function readBillingAccount(): Promise<Answer<BillingAccount> | null> {
  const answer = await readJson<BillingAccount>("/api/organization/billing");
  return answer.status === "missing" ? null : answer;
}

/** What each plan is called on the page, when Egma knows the code. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  hobby: "Hobby",
  pro: "Pro",
};

/**
 * The plan's name. The row's own name wins, because a plan is a row and a
 * deployment one release ahead of these pages can sell one this file has never
 * heard of.
 */
export function planLabel(plan: BillingPlan): string {
  return plan.name.trim() || PLAN_LABELS[plan.code] || plan.code;
}

/**
 * Money, as this product writes it: whole dollars and cents, from micros.
 *
 * A negative balance is written with its sign rather than in brackets. It is a
 * real state — work already claimed finishes and is charged, so a balance can
 * end a busy hour below zero — and a person reading it has to see at once that
 * they owe rather than hold.
 */
export function moneyLabel(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * What a plan includes of one allowance, in that allowance's own unit.
 *
 * `null` is unlimited and says so in a word, because "0" would read as none at
 * all — which is the opposite.
 */
export function allowedLabel(allowance: PlanAllowance): string {
  if (allowance.allowed === null) return "Unlimited";
  return `${allowance.allowed.toLocaleString("en-US")} ${allowance.unit}`;
}

/** The monthly fee, or the word for a plan that charges nothing. */
export function feeLabel(plan: BillingPlan): string {
  return plan.feeMicros === 0 ? "Free" : `${moneyLabel(plan.feeMicros)} a month`;
}

/* ----------------------------------------------------------------- *
 * What an admin does: four actions, each of which opens Stripe.
 * ----------------------------------------------------------------- */

/** Where each action is asked for. */
export const BILLING_ACTION_PATHS = {
  credit: "/api/billing/credit",
  upgrade: "/api/billing/upgrade",
  downgrade: "/api/billing/downgrade",
  portal: "/api/billing/portal",
} as const;

/** A Stripe-hosted page for the browser to follow. */
export type HostedPage = { readonly url: string };

/** What a downgrade settled on: when Pro ends. */
export type ScheduledDowngrade = { readonly endsAt: string | null };

/**
 * One action, asked of the API.
 *
 * **A refusal keeps its own sentence.** Every one of these can be refused for
 * a reason a person can act on — a role that may not spend, an amount outside
 * the bounds, an organization that is not on Pro, a deployment whose Stripe
 * has no product yet — and each of those sentences was written to be shown.
 */
async function askFor<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<Answer<T>> {
  try {
    const response = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const answered = (await response.json().catch(() => null)) as unknown;
    return answerFor<T>(response.status, answered);
  } catch {
    return unreachable<T>();
  }
}

/** Open Stripe Checkout to buy this much inference credit. */
export async function buyCredit(
  amountMicros: number,
): Promise<Answer<HostedPage>> {
  return askFor<HostedPage>(BILLING_ACTION_PATHS.credit, { amountMicros });
}

/** Open Stripe Checkout to move this organization to Pro. */
export async function upgradeToPro(): Promise<Answer<HostedPage>> {
  return askFor<HostedPage>(BILLING_ACTION_PATHS.upgrade);
}

/** Stop Pro at the end of the period. Nothing is cancelled now. */
export async function downgradeAtPeriodEnd(): Promise<
  Answer<ScheduledDowngrade>
> {
  return askFor<ScheduledDowngrade>(BILLING_ACTION_PATHS.downgrade);
}

/** Open Stripe's Customer Portal, where the card and the invoices are. */
export async function openPaymentPortal(): Promise<Answer<HostedPage>> {
  return askFor<HostedPage>(BILLING_ACTION_PATHS.portal);
}

/**
 * The amount a person typed, in micro-dollars, or nothing readable.
 *
 * Dollars go in, because that is what a person types; micro-dollars come out,
 * because that is the unit every amount in this product is counted in. Two
 * decimal places at most: a third would be a fraction of a cent nobody can pay.
 */
export function creditMicrosFromDollars(typed: string): number | undefined {
  const trimmed = typed.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return undefined;
  return Math.round(Number(trimmed) * 1_000_000);
}
