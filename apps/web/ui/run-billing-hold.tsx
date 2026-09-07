"use client";

import type { BillingHold } from "../lib/run-billing-hold.ts";
import { NoteBox, NoteLine } from "./run-note.tsx";

/**
 * Why this run's queued conversations are waiting.
 *
 * **The note box the run surfaces already have**, rather than a second one
 * written here: this is the same kind of fact as the connection note — one a
 * person has to read before they act — so it wears the same hairline, the same
 * fill and the same warning edge, and the next change to that box reaches both.
 *
 * It is drawn only when there is something to say: a run nothing is holding
 * back draws nothing, on every deployment, and a deployment that does not bill
 * can never draw it.
 *
 * **The sentence is the adapter's own, whole.** It was written where the
 * refusal was decided, it names what is spent or unfunded and what to do next,
 * and rebuilding it here from the parts would be a second copy to keep in step.
 *
 * `DESIGN.md`: the words say what happened and the colour only supports them.
 */
export function RunBillingHold({
  holds,
}: {
  readonly holds: readonly BillingHold[];
}) {
  if (holds.length === 0) return null;

  return (
    <NoteBox accent="warning" slot="run-billing-hold" className="mb-4">
      <NoteLine>
        This run&rsquo;s remaining simulations are queued and waiting.
      </NoteLine>
      {holds.map((hold) => (
        <NoteLine
          key={
            hold.held === "allowance" ? hold.allowance : hold.providers.join(",")
          }
        >
          {hold.message}
        </NoteLine>
      ))}
    </NoteBox>
  );
}
