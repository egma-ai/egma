"use client";

import type { Answer } from "../lib/api.ts";
import {
  allowedLabel,
  feeLabel,
  moneyLabel,
  planLabel,
  type BillingAccount,
  type PeriodCharge,
} from "../lib/billing.ts";
import { allowanceLabel } from "../lib/organization-usage.ts";
import { asListInstant } from "../lib/instants.ts";
import { DataTable, type Column } from "./data-table.tsx";
import { Facts, Section } from "./section.tsx";

/**
 * This organization's plan and inference balance.
 *
 * **It is here only on a deployment that bills.** A self-hosted Egma has no
 * plan and no balance, so the read answers "not available" and the page draws
 * nothing at all rather than an empty panel implying there is a plan to see.
 * The usage panel above it stays on every deployment, because counting a month
 * is the product and charging for it is not.
 *
 * **Every role reads the plan and the balance.** A run that paused for money
 * has to explain itself to whoever started it, whatever they are allowed to
 * change. What only an admin reads is where the money went, which is a fact
 * about the account rather than about the limit.
 *
 * **There is nothing to act on yet, and the surface says so by being quiet.**
 * Upgrade, Buy credit and Manage payment are the Stripe change's, and a button
 * that cannot work is worse than no button.
 *
 * **Loading, unavailable and failed are separate states**, as `DESIGN.md`
 * asks, and a balance of zero is a fact rather than an empty state.
 */
export function BillingSection({
  billing,
}: {
  /** `null` before the read answers, or once it says this deployment does not bill. */
  readonly billing: Answer<BillingAccount> | null | undefined;
}) {
  // `undefined` is "still reading"; `null` is "this deployment does not bill".
  if (billing === null) return null;

  if (billing === undefined) {
    return (
      <Section title="Billing" lead={BILLING_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          Reading this organization&rsquo;s plan and balance…
        </p>
      </Section>
    );
  }

  if (billing.status !== "ready") {
    // A refusal keeps its own sentence: it was written to be shown and it
    // names the next move.
    return (
      <Section title="Billing" lead={BILLING_IS}>
        <p className="m-0 text-sm text-muted-foreground">
          {billing.status === "signed-out"
            ? "Sign in again to read this organization’s plan and balance."
            : billing.refusal.message}
        </p>
      </Section>
    );
  }

  const account = billing.value;
  const plan = account.plan;

  return (
    <Section
      title="Billing"
      lead={BILLING_IS}
      action={
        <p className="m-0 text-sm tabular-nums text-muted-foreground">
          {`${asListInstant(account.periodStartedAt)} — resets ${asListInstant(
            account.resetsAt,
          )}`}
        </p>
      }
    >
      <Facts
        facts={[
          { label: "Plan", value: planLabel(plan) },
          { label: "Plan fee", value: feeLabel(plan) },
          {
            label: "Inference balance",
            value: (
              <span className="tabular-nums">
                {moneyLabel(account.balanceMicros)}
              </span>
            ),
          },
          ...plan.allowances.map((allowance) => ({
            label: `${allowanceLabel(allowance.kind)} included`,
            value: (
              <span className="tabular-nums">{allowedLabel(allowance)}</span>
            ),
          })),
        ]}
      />

      {account.mayManageBilling ? (
        <Charges charges={account.charges} />
      ) : null}
    </Section>
  );
}

/**
 * What the balance paid for this period, by provider and model.
 *
 * Only what Egma's own keys paid for: a provider request a customer's own key
 * paid for cost this balance nothing and belongs on the simulation's own usage,
 * not here.
 */
function Charges({ charges }: { readonly charges: readonly PeriodCharge[] }) {
  if (charges.length === 0) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        Nothing has been charged to the inference balance this period.
      </p>
    );
  }

  const columns: readonly Column<PeriodCharge>[] = [
    {
      key: "model",
      header: "Model",
      primary: true,
      cell: (charge) => `${charge.provider}/${charge.model}`,
    },
    {
      key: "requests",
      header: "Requests",
      mono: true,
      hideOnMobile: true,
      cell: (charge) => charge.requests.toLocaleString("en-US"),
    },
    {
      key: "amount",
      header: "Charged",
      mono: true,
      cell: (charge) => moneyLabel(charge.amountMicros),
    },
  ];

  return (
    <DataTable
      label="What the inference balance paid for this period"
      columns={columns}
      rows={charges}
      keyOf={(charge) => `${charge.provider}/${charge.model}`}
    />
  );
}

const BILLING_IS =
  "The plan this organization is on, what it includes each period, and the " +
  "inference balance that pays for model usage made with Egma's provider keys.";
