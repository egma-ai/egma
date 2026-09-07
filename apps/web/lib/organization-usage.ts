import { readJson, type Answer } from "./api.ts";

/**
 * What this organization has used of each allowance this period.
 *
 * **On every deployment, and against no limit.** Egma counts chat simulations,
 * web-call minutes and phone minutes because that is what a month of platform
 * usage is made of; whether a plan caps any of them is a separate question
 * that a self-hosted deployment never asks. So this surface shows three
 * numbers and a reset date, and nothing on it is a warning.
 *
 * The units are the allowance's own — conversations for chat, minutes for the
 * two voice kinds — because those are the words a plan is published in, and a
 * reader holding this against a plan has to find the same ones.
 */

/** One allowance, and how much of it this period has used. */
export type AllowanceUsage = {
  /** `chat_simulations`, `web_call_minutes` or `phone_minutes`. */
  readonly kind: string;
  /** `simulations` or `minutes` — what the number is counted in. */
  readonly unit: string;
  readonly used: number;
};

export type PeriodUsage = {
  /** ISO-8601, the first instant of the period. */
  readonly periodStartedAt: string;
  /** ISO-8601, the next reset. */
  readonly resetsAt: string;
  readonly allowances: readonly AllowanceUsage[];
};

export function readPeriodUsage(): Promise<Answer<PeriodUsage>> {
  return readJson<PeriodUsage>("/api/organization/usage");
}

/** What each allowance is called on the page. */
const ALLOWANCE_LABELS: Readonly<Record<string, string>> = {
  chat_simulations: "Chat simulations",
  web_call_minutes: "Web-call minutes",
  phone_minutes: "Phone minutes",
};

/**
 * The allowance's name, or its stored word made readable.
 *
 * The fallback matters: an Egma one release newer than these pages can send a
 * fourth kind, and a row reading `sms minutes` is a row somebody can act on,
 * where a blank one is a bug report.
 */
export function allowanceLabel(kind: string): string {
  return ALLOWANCE_LABELS[kind] ?? kind.replaceAll("_", " ");
}

/**
 * A quantity, in the unit it is counted in.
 *
 * Conversations are whole because a conversation is. Minutes carry one decimal
 * place, because they are summed from seconds and a month of short
 * conversations that rounded to `0` would read as a month nobody used.
 */
export function usedLabel(usage: AllowanceUsage): string {
  const whole = usage.unit !== "minutes";
  return `${usage.used.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: whole ? 0 : 1,
  })} ${usage.unit}`;
}

/**
 * A date as this product writes one: the absolute short date, never an age.
 * A relative reset — "in 12 days" — cannot be put in a calendar, and this is a
 * date somebody plans around.
 */
export function periodDateLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
