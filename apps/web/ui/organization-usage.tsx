"use client";

import type { Answer } from "../lib/api.ts";
import { asListInstant } from "../lib/instants.ts";
import {
  allowanceLabel,
  usedLabel,
  type PeriodUsage,
} from "../lib/organization-usage.ts";
import { Facts, Section } from "./section.tsx";

/**
 * What this organization has used this period.
 *
 * **On every deployment, and there is nothing here to act on.** Egma counts
 * chat simulations, web-call minutes and phone minutes because that is what a
 * month of platform usage is made of; a self-hoster reads exactly this against
 * no limit at all. So it is three facts and a reset date — the `Facts` group
 * every other settings surface uses — and not a meter, a bar or a warning:
 * none of those has anything to say until a plan exists to say it against.
 *
 * **Every role sees it.** A run that paused for money has to explain itself to
 * whoever started it, whatever they are allowed to change.
 *
 * **Empty, loading and failed are separate and each says what happened**, as
 * `DESIGN.md` asks: a month nobody has run in shows three zeroes, which is a
 * true and useful fact about the month, and not the "nothing here yet" card.
 */
export function OrganizationUsage({
  usage,
}: {
  readonly usage: Answer<PeriodUsage> | null;
}) {
  if (usage === null) {
    return (
      <Section title="Usage this period" lead={USAGE_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          Reading what this organization has used…
        </p>
      </Section>
    );
  }

  if (usage.status !== "ready") {
    // A refusal keeps its own sentence: it is written to be shown and it names
    // the next move. Everything else on the page is unaffected, so this stays
    // one quiet line rather than taking the page over.
    return (
      <Section title="Usage this period" lead={USAGE_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          {usage.status === "signed-out"
            ? "Sign in again to read what this organization has used."
            : usage.refusal.message}
        </p>
      </Section>
    );
  }

  const read = usage.value;
  return (
    <Section
      title="Usage this period"
      lead={USAGE_IS}
      action={
        <p className="m-0 text-sm tabular-nums text-muted-foreground">
          {`${asListInstant(read.periodStartedAt)} — resets ${asListInstant(
            read.resetsAt,
          )}`}
        </p>
      }
    >
      {/*
        * The grid, not the panel: the panel's shape is two short facts and one
        * full-width prose fact under them, which is a name, a number and a
        * description. These are three equal numbers, so the last of them would
        * have run the width of the page for no reason.
        */}
      <Facts
        facts={read.allowances.map((allowance) => ({
          label: allowanceLabel(allowance.kind),
          value: (
            <span className="tabular-nums">{usedLabel(allowance)}</span>
          ),
        }))}
      />
    </Section>
  );
}

const USAGE_IS =
  "What this organization has run since the period began. The period is one " +
  "month from the day the organization was created.";
