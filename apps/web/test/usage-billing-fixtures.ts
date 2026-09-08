import type { BillingAccount } from "../lib/billing.ts";
import type { PeriodUsage } from "../lib/organization-usage.ts";

export const USAGE: PeriodUsage = {
  periodStartedAt: "2026-09-15T08:00:00.000Z",
  resetsAt: "2026-10-15T08:00:00.000Z",
  allowances: [
    { kind: "chat_simulations", unit: "simulations", used: 128 },
    { kind: "web_call_minutes", unit: "minutes", used: 41.5 },
    { kind: "phone_minutes", unit: "minutes", used: 3 },
  ],
  inference: {
    amountMicros: 640_240,
    requests: 313,
    byModel: [
      {
        provider: "openai",
        model: "gpt-4o-mini",
        unit: "tokens",
        requests: 312,
        quantities: { input_tokens: 1200, output_tokens: 100 },
        amountMicros: 640_000,
      },
      {
        provider: "openai",
        model: "gpt-4.1-mini",
        unit: "tokens",
        requests: 1,
        quantities: { input_tokens: 100, output_tokens: 20 },
        amountMicros: 240,
      },
    ],
  },
};
export const HOBBY: BillingAccount = {
  plan: {
    code: "hobby",
    name: "Hobby",
    feeMicros: 0,
    allowances: USAGE.allowances.map((row) => ({
      ...row,
      allowed: 500,
      overageMicrosPerMinute: 0,
    })),
  },
  balanceMicros: 4_250_000,
  scheduledDowngradeAt: null,
  periodStartedAt: USAGE.periodStartedAt,
  usageStartedAt: "2026-09-18T08:00:00.000Z",
  resetsAt: USAGE.resetsAt,
  mayManageBilling: true,
  ledger: {
    entries: [
      {
        id: "cle_welcome",
        kind: "welcome_credit",
        amountMicros: 5_000_000,
        occurredAt: "2026-09-18T08:00:00Z",
        intervalStartedAt: null,
        intervalEndedAt: null,
      },
      {
        id: "cle_charge",
        kind: "inference_charge",
        amountMicros: -750_000,
        occurredAt: "2026-09-18T08:05:00Z",
        intervalStartedAt: "2026-09-18T08:00:00Z",
        intervalEndedAt: "2026-09-18T08:05:00Z",
      },
    ],
    nextCursor: null,
  },
  actions: {
    available: true,
    creditAmountsMicros: [10_000_000, 25_000_000, 50_000_000, 100_000_000],
    smallestCreditMicros: 5_000_000,
    largestCreditMicros: 1_000_000_000,
  },
};
export const PRO: BillingAccount = {
  ...HOBBY,
  plan: {
    code: "pro",
    name: "Pro",
    feeMicros: 50_000_000,
    allowances: USAGE.allowances.map((row) => ({
      ...row,
      allowed:
        row.kind === "chat_simulations"
          ? null
          : row.kind === "phone_minutes"
            ? 2000
            : 5000,
      overageMicrosPerMinute:
        row.kind === "phone_minutes"
          ? 20_000
          : row.kind === "web_call_minutes"
            ? 10_000
            : 0,
    })),
  },
};
export function memberSession(role = "admin") {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };
}
