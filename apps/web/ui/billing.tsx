"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { Answer } from "../lib/api.ts";
import {
  allowedLabel,
  buyCredit,
  creditMicrosFromDollars,
  downgradeAtPeriodEnd,
  feeLabel,
  moneyLabel,
  openPaymentPortal,
  planLabel,
  upgradeToPro,
  type BillingAccount,
  type BillingActions,
  type PeriodCharge,
} from "../lib/billing.ts";
import { allowanceLabel } from "../lib/organization-usage.ts";
import { asListInstant } from "../lib/instants.ts";
import { DataTable, type Column } from "./data-table.tsx";
import { Dialog } from "./dialog.tsx";
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
 * **Only an admin sees a button, and only where one can work.** The four
 * actions appear for whoever may manage the organization, on a deployment
 * whose Stripe adapter is in place — the read says which, because a page
 * cannot tell that from a plan. A member sees the same facts and no controls.
 *
 * **Every button opens a page Stripe hosts.** Egma never asks for a card, so
 * pressing one takes the person to Checkout or the Customer Portal and the
 * plan moves when Stripe says the subscription exists. The one exception is
 * Downgrade, which settles here because nothing is being paid: it asks Stripe
 * to stop at the end of the period and the organization stays on Pro until
 * then.
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
        <>
          <BillingActionsRow account={account} />
          <Charges charges={account.charges} />
        </>
      ) : null}
    </Section>
  );
}

/**
 * The four things an admin does, and whatever the last one said.
 *
 * **A refusal is shown word for word.** Each of these can be refused for a
 * reason a person can act on — a role that may not spend, an organization that
 * is not on Pro, a deployment whose Stripe has no Pro product yet — and every
 * one of those sentences was written to be read.
 */
function BillingActionsRow({
  account,
}: {
  readonly account: BillingAccount;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const actions = account.actions;
  if (actions === undefined || !actions.available) return null;

  const onPro = account.plan.code === "pro";

  /**
   * Follow Stripe where it says to go, or keep the refusal.
   *
   * The browser leaves the page on success, which is why nothing here clears
   * the busy state on that path: a control that went idle while the tab was
   * already navigating would flicker back to ready on its way out.
   */
  const follow = async (
    what: string,
    ask: () => Promise<Answer<{ readonly url: string }>>,
  ): Promise<void> => {
    setBusy(what);
    setSaid(null);
    const answer = await ask();
    if (answer.status === "ready") {
      window.location.assign(answer.value.url);
      return;
    }
    setBusy(null);
    setSaid(
      answer.status === "signed-out"
        ? "Sign in again to change this organization's billing."
        : answer.refusal.message,
    );
  };

  const stopAtPeriodEnd = async (): Promise<void> => {
    setBusy("downgrade");
    setSaid(null);
    const answer = await downgradeAtPeriodEnd();
    setBusy(null);
    if (answer.status === "ready") {
      setSaid(
        answer.value.endsAt === null
          ? "Pro will stop at the end of this period."
          : `Pro stops on ${asListInstant(answer.value.endsAt)}. Everything it ` +
              "includes stays available until then.",
      );
      return;
    }
    setSaid(
      answer.status === "signed-out"
        ? "Sign in again to change this organization's billing."
        : answer.refusal.message,
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            setSaid(null);
            setPicking(true);
          }}
        >
          Buy credit
        </Button>
        {onPro ? null : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void follow("upgrade", upgradeToPro)}
          >
            {busy === "upgrade" ? "Opening Stripe…" : "Upgrade to Pro"}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          onClick={() => void follow("portal", openPaymentPortal)}
        >
          {busy === "portal" ? "Opening Stripe…" : "Manage payment and invoices"}
        </Button>
        {onPro ? (
          /*
           * Ending a paid plan is the destructive action on this surface, so it
           * is a quiet text action kept at the far end of the row from the one
           * that spends — `DESIGN.md`, "keep destructive actions separate from
           * normal save actions". It needs no confirmation dialog because it
           * destroys nothing now: the organization keeps Pro until the period
           * ends, and pressing Upgrade again before then is the way back.
           */
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            disabled={busy !== null}
            onClick={() => {
              setSaid(null);
              setStopping(true);
            }}
          >
            {busy === "downgrade" ? "Asking Stripe…" : "Downgrade at period end"}
          </Button>
        ) : null}
      </div>

      {said === null ? null : (
        <p className="m-0 text-sm text-muted-foreground" role="status">
          {said}
        </p>
      )}

      {picking ? (
        <BuyCreditDialog
          actions={actions}
          onClose={() => setPicking(false)}
          onChosen={(amountMicros) => {
            setPicking(false);
            void follow("credit", () => buyCredit(amountMicros));
          }}
        />
      ) : null}

      {stopping ? (
        <StopProDialog
          plan={planLabel(account.plan)}
          endsAt={account.resetsAt}
          onClose={() => setStopping(false)}
          onConfirmed={() => {
            setStopping(false);
            void stopAtPeriodEnd();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The confirmation that ends a paid plan.
 *
 * **`DESIGN.md` asks for it and the sentence is the point.** A destructive
 * action is confirmed and says what will happen, and the button inside the
 * confirmation is a filled failure-colour button. What makes this one
 * answerable is the date: nothing is cancelled now, the organization keeps
 * everything the plan includes until the period ends, and that is the fact a
 * person needs before they press.
 */
function StopProDialog({
  plan,
  endsAt,
  onClose,
  onConfirmed,
}: {
  readonly plan: string;
  /** ISO-8601: the end of the period this organization has paid for. */
  readonly endsAt: string;
  readonly onClose: () => void;
  readonly onConfirmed: () => void;
}) {
  const stops = asListInstant(endsAt);
  return (
    <Dialog title={`Stop ${plan} at the end of this period?`} onClose={onClose}>
      {(dismiss) => (
        <div className="flex flex-col gap-4 p-5">
          <p className="m-0 text-sm text-muted-foreground">
            {`This organization stays on ${plan} until ${stops}. Everything the ` +
              "plan includes — its allowances and its overage — stays " +
              "available until then, and nothing is charged after it."}
          </p>
          <p className="m-0 text-sm text-muted-foreground">
            {`On ${stops} it returns to the Hobby plan, and its month starts ` +
              "counting from the day the organization was created again. " +
              "Inference credit is untouched: it never expires and it is " +
              "separate from the plan."}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="lg" onClick={dismiss}>
              {`Keep ${plan}`}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="lg"
              onClick={onConfirmed}
            >
              {`Stop ${plan} on ${stops}`}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * How much inference credit to buy.
 *
 * Four amounts and a box, because most people take one of the four and the
 * rest know exactly what they want. The bounds are the deployment's own, sent
 * with the read, so this refuses exactly what the route refuses and says the
 * same numbers.
 */
function BuyCreditDialog({
  actions,
  onClose,
  onChosen,
}: {
  readonly actions: BillingActions;
  readonly onClose: () => void;
  readonly onChosen: (amountMicros: number) => void;
}) {
  const [custom, setCustom] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const chooseCustom = (): void => {
    const micros = creditMicrosFromDollars(custom);
    if (micros === undefined) {
      setProblem("Write an amount in dollars, such as 40 or 40.50.");
      return;
    }
    if (micros < actions.smallestCreditMicros) {
      setProblem(
        `The smallest amount is ${moneyLabel(actions.smallestCreditMicros)}.`,
      );
      return;
    }
    if (micros > actions.largestCreditMicros) {
      setProblem(
        `The largest amount is ${moneyLabel(actions.largestCreditMicros)}. ` +
          "Buy that or less, more than once if you need to.",
      );
      return;
    }
    onChosen(micros);
  };

  return (
    <Dialog title="Buy inference credit" onClose={onClose}>
      <div className="flex flex-col gap-4 p-5">
        <p className="m-0 text-sm text-muted-foreground">
          Inference credit pays for model usage made with Egma&rsquo;s provider
          keys. It never expires and it is separate from the plan.
        </p>
        <div className="flex flex-wrap gap-2">
          {actions.creditAmountsMicros.map((amountMicros) => (
            <Button
              key={amountMicros}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onChosen(amountMicros)}
            >
              {moneyLabel(amountMicros)}
            </Button>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <label
            className="text-sm font-medium"
            htmlFor="billing-custom-credit"
          >
            Another amount [optional]
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="billing-custom-credit"
              inputMode="decimal"
              value={custom}
              placeholder="40.00"
              onChange={(event) => {
                setCustom(event.target.value);
                setProblem(null);
              }}
            />
            <Button type="button" size="sm" onClick={chooseCustom}>
              Continue
            </Button>
          </div>
          {problem === null ? null : (
            <p className="m-0 text-sm text-destructive" role="alert">
              {problem}
            </p>
          )}
        </div>
        <p className="m-0 text-sm text-muted-foreground">
          Payment happens on Stripe. Tax is added at checkout, and the balance
          rises by the amount you buy.
        </p>
      </div>
    </Dialog>
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
