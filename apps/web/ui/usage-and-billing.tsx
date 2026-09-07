"use client";
import { useState } from "react";
import type { Answer } from "../lib/api.ts";
import {
  moneyLabel,
  readBillingLedger,
  type BillingAccount,
  type BillingLedgerEntry,
  type BillingLedgerPage,
} from "../lib/billing.ts";
import {
  allowanceLabel,
  usedLabel,
  type AllowanceUsage,
  type ModelUsage,
  type PeriodUsage,
} from "../lib/organization-usage.ts";
import { asListInstant } from "../lib/instants.ts";
import { DataTable, type Column } from "./data-table.tsx";
import { Empty, Failure, Loading } from "./page-state.tsx";
import { Section } from "./section.tsx";

export function UsageAllowances({
  account,
  usage,
  onRetry,
}: {
  readonly account: BillingAccount | null;
  readonly usage: Answer<PeriodUsage> | null;
  readonly onRetry: () => void;
}) {
  const period = account ?? (usage?.status === "ready" ? usage.value : null);
  const rows =
    account?.plan.allowances ??
    (usage?.status === "ready" ? usage.value.allowances : null);
  return (
    <Section
      title="Usage this period"
      lead={
        period === null ? undefined : (
          <span className="tabular-nums">
            <time dateTime={period.periodStartedAt}>
              {asListInstant(period.periodStartedAt)}
            </time>{" "}
            — resets{" "}
            <time dateTime={period.resetsAt}>
              {asListInstant(period.resetsAt)}
            </time>
          </span>
        )
      }
    >
      {rows === null ? (
        usage === null ? (
          <Loading what="usage" />
        ) : (
          <UsageFailure answer={usage} onRetry={onRetry} />
        )
      ) : (
        <DataTable
          label="Organization usage this period"
          keyOf={(row) => row.kind}
          rows={rows}
          columns={[
            {
              key: "kind",
              header: "Allowance",
              primary: true,
              cell: (row: AllowanceUsage) => allowanceLabel(row.kind),
            },
            { key: "used", header: "Used", mono: true, cell: usedLabel },
            ...(account === null
              ? []
              : [
                  {
                    key: "included",
                    header: "Included",
                    mono: true,
                    cell: (row: AllowanceUsage) => {
                      const allowance = account.plan.allowances.find(
                        (item) => item.kind === row.kind,
                      )!;
                      return allowance.allowed === null
                        ? "Unlimited"
                        : `${allowance.allowed.toLocaleString("en-US")} ${allowance.unit}`;
                    },
                  },
                  {
                    key: "overage",
                    header: "Overage",
                    cell: (row: AllowanceUsage) => {
                      const allowance = account.plan.allowances.find(
                        (item) => item.kind === row.kind,
                      )!;
                      return account.plan.code === "pro" &&
                        allowance.overageMicrosPerMinute > 0
                        ? `${moneyLabel(allowance.overageMicrosPerMinute)}/minute`
                        : "—";
                    },
                  },
                ]),
          ]}
        />
      )}
    </Section>
  );
}

function UsageFailure({
  answer,
  onRetry,
}: {
  readonly answer: Answer<PeriodUsage>;
  readonly onRetry: () => void;
}) {
  if (answer.status === "ready") return null;
  return (
    <Failure
      title="Usage is unavailable."
      message={
        answer.status === "signed-out"
          ? "Sign in again to read usage."
          : answer.refusal.message
      }
      onRetry={onRetry}
    />
  );
}

const MODEL_COLUMNS: readonly Column<ModelUsage>[] = [
  {
    key: "model",
    header: "Provider / model",
    primary: true,
    cell: (row) => `${row.provider}/${row.model}`,
  },
  {
    key: "requests",
    header: "Requests",
    mono: true,
    cell: (row) => row.requests.toLocaleString("en-US"),
  },
  {
    key: "cost",
    header: "Cost",
    mono: true,
    cell: (row) => moneyLabel(row.amountMicros),
  },
];
export function ProviderUsage({
  usage,
  onRetry,
}: {
  readonly usage: Answer<PeriodUsage> | null;
  readonly onRetry: () => void;
}) {
  return (
    <Section
      title="Provider and model costs"
      lead="Model usage during this period, at provider rates."
    >
      {usage === null ? (
        <Loading what="provider costs" />
      ) : usage.status !== "ready" ? (
        <UsageFailure answer={usage} onRetry={onRetry} />
      ) : usage.value.inference.byModel.length === 0 ? (
        <Empty
          title="No model usage this period"
          lead="Provider costs will appear after model usage is recorded."
        />
      ) : (
        <>
          <p className="m-0 text-sm tabular-nums text-muted-foreground">
            {moneyLabel(usage.value.inference.amountMicros)} across{" "}
            {usage.value.inference.requests.toLocaleString("en-US")} requests
          </p>
          <DataTable
            label="Provider and model costs"
            rows={usage.value.inference.byModel}
            columns={MODEL_COLUMNS}
            keyOf={(row) => `${row.provider}/${row.model}/${row.unit}`}
          />
        </>
      )}
    </Section>
  );
}

const LEDGER_LABELS: Readonly<Record<BillingLedgerEntry["kind"], string>> = {
  welcome_credit: "Welcome credit",
  purchased_credit: "Credit purchase",
  inference_charge: "Inference charge",
  correction: "Balance adjustment",
};
const LEDGER_COLUMNS: readonly Column<BillingLedgerEntry>[] = [
  {
    key: "kind",
    header: "Movement",
    primary: true,
    cell: (row) => LEDGER_LABELS[row.kind],
  },
  {
    key: "date",
    header: "Date",
    mono: true,
    cell: (row) => (
      <time
        dateTime={row.occurredAt}
        title={new Date(row.occurredAt).toISOString()}
      >
        {asListInstant(row.occurredAt)}
      </time>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    mono: true,
    cell: (row) =>
      `${row.amountMicros > 0 ? "+" : ""}${moneyLabel(row.amountMicros)}`,
  },
];
export function BillingHistory({
  initial,
}: {
  readonly initial: BillingLedgerPage;
}) {
  const [history, setHistory] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const more = async () => {
    if (loading || history.nextCursor === null) return;
    setLoading(true);
    setFailure(null);
    const answer = await readBillingLedger(history.nextCursor);
    setLoading(false);
    if (answer.status !== "ready") {
      setFailure(
        answer.status === "signed-out"
          ? "Sign in again to read billing history."
          : answer.refusal.message,
      );
      return;
    }
    setHistory((held) => ({
      entries: [
        ...new Map(
          [...held.entries, ...answer.value.entries].map((row) => [
            row.id,
            row,
          ]),
        ).values(),
      ],
      nextCursor: answer.value.nextCursor,
    }));
  };
  return (
    <Section
      title="Billing history"
      lead="Every credit, charge, and balance adjustment."
    >
      {failure === null ? null : (
        <p role="alert" className="m-0 text-sm text-destructive">
          {failure}
        </p>
      )}
      {history.entries.length === 0 ? (
        <Empty
          title="No billing activity yet"
          lead="Credits and charges will appear here."
        />
      ) : (
        <DataTable
          label="Billing history"
          rows={history.entries}
          columns={LEDGER_COLUMNS}
          keyOf={(row) => row.id}
          {...(history.nextCursor === null
            ? {}
            : {
                more: {
                  loading,
                  onMore: () => void more(),
                  note: `${history.entries.length} movements shown`,
                },
              })}
        />
      )}
    </Section>
  );
}
