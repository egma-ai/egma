"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Answer } from "../lib/api.ts";
import {
  buyCredit,
  creditMicrosFromDollars,
  downgradeAtPeriodEnd,
  moneyLabel,
  openPaymentPortal,
  upgradeToPro,
  type BillingAccount,
  type BillingActions,
} from "../lib/billing.ts";
import { asListInstant } from "../lib/instants.ts";
import { Dialog } from "./dialog.tsx";

export function BillingActionsRow({
  account,
  onRefresh,
  onBusyChange,
}: {
  readonly account: BillingAccount;
  readonly onRefresh: () => void;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const actions = account.actions;
  useEffect(() => {
    onBusyChange(busy !== null);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    const returned = () => {
      setBusy(null);
      onRefresh();
    };
    window.addEventListener("pageshow", returned);
    return () => window.removeEventListener("pageshow", returned);
  }, [onRefresh]);
  if (!actions.available)
    return (
      <p className="m-0 text-sm text-muted-foreground">
        Payment actions are unavailable. Ask your administrator to check billing
        setup.
      </p>
    );

  const onPro = account.plan.code === "pro";
  const downgradeScheduled = account.scheduledDowngradeAt !== null;

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
      try {
        window.location.assign(answer.value.url);
        return;
      } catch {
        setBusy(null);
        setSaid("The payment page could not open. Try again.");
        return;
      }
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
      onRefresh();
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
          {busy === "portal"
            ? "Opening Stripe…"
            : "Manage payment and invoices"}
        </Button>
        {onPro && downgradeScheduled ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={busy !== null}
            onClick={() => void follow("portal", openPaymentPortal)}
          >
            Keep Pro in Stripe
          </Button>
        ) : onPro ? (
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
            {busy === "downgrade"
              ? "Asking Stripe…"
              : "Downgrade at period end"}
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
          plan={account.plan.name}
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
              "available until then. Any usage already incurred is still payable."}
          </p>
          <p className="m-0 text-sm text-muted-foreground">
            {`On ${stops} this organization returns to Hobby with a full monthly allowance. Its monthly reset date starts from that change. Inference credit stays available and does not expire.`}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={dismiss}
            >
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
