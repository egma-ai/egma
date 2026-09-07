import { readJson, type Answer } from "./api.ts";

/**
 * Why this run's queued work is waiting, when it is waiting for money.
 *
 * **Asked, never stored.** A conversation the claim door refused stays queued
 * and nothing writes the reason on the row: no shared table gains a column for
 * billing, and a reason written down would go stale the moment the month reset,
 * the plan changed or credit arrived. So the page asks, and what it shows is
 * what a person would be told now.
 *
 * **Absent is the ordinary answer.** A deployment that does not bill holds
 * nothing back, so the list is empty and the page draws nothing.
 */

/** One reason this run's queued work is waiting. */
export type BillingHold =
  | {
      readonly held: "allowance";
      /** `chat_simulations`, `web_call_minutes` or `phone_minutes`. */
      readonly allowance: string;
      readonly unit: string;
      /** ISO-8601, when the allowance comes back. */
      readonly resetsAt: string;
      readonly message: string;
    }
  | {
      readonly held: "funding";
      readonly providers: readonly string[];
      readonly message: string;
    };

export type RunBillingHold = {
  readonly runId: string;
  readonly holds: readonly BillingHold[];
};

export function readRunBillingHold(
  runId: string,
  projectId: string,
): Promise<Answer<RunBillingHold>> {
  return readJson<RunBillingHold>(
    `/api/runs/${encodeURIComponent(runId)}/billing-hold?projectId=${encodeURIComponent(projectId)}`,
  );
}
