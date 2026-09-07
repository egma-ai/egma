import { readJson, type Answer } from "./api.ts";

export type AllowanceKind =
  | "chat_simulations"
  | "web_call_minutes"
  | "phone_minutes";
export type AllowanceUsage = {
  readonly kind: AllowanceKind;
  readonly unit: string;
  readonly used: number;
};
export type ModelUsage = {
  readonly provider: string;
  readonly model: string;
  readonly unit: string;
  readonly requests: number;
  readonly quantities: Readonly<Record<string, number>>;
  readonly amountMicros: number;
};
export type InferenceUsage = {
  readonly amountMicros: number;
  readonly requests: number;
  readonly byModel: readonly ModelUsage[];
};
export type PeriodUsage = {
  readonly periodStartedAt: string;
  readonly resetsAt: string;
  readonly allowances: readonly AllowanceUsage[];
  readonly inference: InferenceUsage;
};

export function readPeriodUsage(period?: {
  from: string;
  to: string;
}): Promise<Answer<PeriodUsage>> {
  const query = period === undefined ? "" : `?${new URLSearchParams(period)}`;
  return readJson<PeriodUsage>(`/api/organization/usage${query}`);
}
const ALLOWANCE_LABELS: Readonly<Record<AllowanceKind, string>> = {
  chat_simulations: "Chat simulations",
  web_call_minutes: "Web-call minutes",
  phone_minutes: "Phone minutes",
};
export function allowanceLabel(kind: AllowanceKind): string {
  return ALLOWANCE_LABELS[kind];
}
export function usedLabel(usage: AllowanceUsage): string {
  const whole = usage.unit !== "minutes";
  return `${usage.used.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: whole ? 0 : 1,
  })} ${usage.unit}`;
}
