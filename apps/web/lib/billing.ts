import { answerFor, readJson, unreachable, type Answer } from "./api.ts";
import type { AllowanceUsage } from "./organization-usage.ts";

export type PlanAllowance = AllowanceUsage & {
  readonly allowed: number | null;
  readonly overageMicrosPerMinute: number;
};
export type BillingPlan = {
  readonly code: "hobby" | "pro";
  readonly name: string;
  readonly feeMicros: number;
  readonly allowances: readonly PlanAllowance[];
};
export type BillingActions = {
  readonly available: boolean;
  readonly creditAmountsMicros: readonly number[];
  readonly smallestCreditMicros: number;
  readonly largestCreditMicros: number;
};
export type BillingLedgerEntry = {
  readonly id: string;
  readonly kind:
    | "welcome_credit"
    | "purchased_credit"
    | "inference_charge"
    | "correction";
  readonly amountMicros: number;
  readonly occurredAt: string;
  readonly intervalStartedAt: string | null;
  readonly intervalEndedAt: string | null;
};
export type BillingLedgerPage = {
  readonly entries: readonly BillingLedgerEntry[];
  readonly nextCursor: string | null;
};
export type BillingAccount = {
  readonly plan: BillingPlan;
  readonly balanceMicros: number;
  readonly scheduledDowngradeAt: string | null;
  readonly periodStartedAt: string;
  readonly usageStartedAt: string;
  readonly resetsAt: string;
  readonly mayManageBilling: boolean;
  readonly ledger: BillingLedgerPage;
  readonly actions: BillingActions;
};

/** A missing billing route means this deployment does not bill. */
export async function readBillingAccount(): Promise<Answer<BillingAccount> | null> {
  const answer = await readJson<BillingAccount>("/api/organization/billing");
  return answer.status === "missing" ? null : answer;
}
export function readBillingLedger(
  cursor: string,
): Promise<Answer<BillingLedgerPage>> {
  return readJson<BillingLedgerPage>(
    `/api/organization/billing/ledger?${new URLSearchParams({ cursor })}`,
  );
}

/** Keep small nonzero usage amounts visible instead of rounding them to zero. */
export function moneyLabel(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  return `${sign}$${(Math.abs(micros) / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits:
      Math.abs(micros) > 0 && Math.abs(micros) < 10_000 ? 6 : 2,
  })}`;
}
export function feeLabel(plan: BillingPlan): string {
  return plan.feeMicros === 0
    ? "Free"
    : `${moneyLabel(plan.feeMicros)} a month`;
}

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
  const micros = Math.round(Number(trimmed) * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : undefined;
}
