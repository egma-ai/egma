"use client";

import type { BillingHold } from "../lib/run-billing-hold.ts";

/**
 * Why this run's queued conversations are waiting.
 *
 * **One quiet box with a warning edge**, the shape `RunNote` already sets for a
 * fact about a run that a person has to read before they act. It is drawn only
 * when there is something to say: a run nothing is holding back draws nothing,
 * on every deployment, and a deployment that does not bill can never draw it.
 *
 * **The sentence is the adapter's own, whole.** It was written where the
 * refusal was decided, it names what is spent or unfunded and what to do next,
 * and rebuilding it here from the parts would be a second copy to keep in step.
 *
 * `DESIGN.md`: the words say what happened and the colour only supports them,
 * so the edge carries the warning and the text is the product's quiet ink.
 */
export function RunBillingHold({
  holds,
}: {
  readonly holds: readonly BillingHold[];
}) {
  if (holds.length === 0) return null;

  return (
    <div
      className="mb-4 flex flex-col gap-1 border border-warning bg-surface p-3"
      data-slot="run-billing-hold"
      role="note"
    >
      <p className="m-0 text-sm leading-(--line-normal) text-foreground">
        This run&rsquo;s remaining simulations are queued and waiting.
      </p>
      {holds.map((hold) => (
        <p
          className="m-0 text-sm leading-(--line-normal) text-faint"
          key={hold.held === "allowance" ? hold.allowance : hold.providers.join(",")}
        >
          {hold.message}
        </p>
      ))}
    </div>
  );
}
