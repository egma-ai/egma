import { readJson, type Answer } from "./api.ts";

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
