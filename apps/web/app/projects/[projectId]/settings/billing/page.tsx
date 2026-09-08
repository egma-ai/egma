"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Answer } from "@/lib/api";
import { readBillingAccount, type BillingAccount } from "@/lib/billing";
import { readPeriodUsage, type PeriodUsage } from "@/lib/organization-usage";
import { BillingAccountSections } from "@/ui/billing";
import {
  BillingHistory,
  ProviderUsage,
  UsageAllowances,
} from "@/ui/usage-and-billing";
import { Failure, Loading } from "@/ui/page-state";
import { SettingsLayout } from "@/ui/settings-nav";
import { AppShell, PageBody, PageHeader, ProductPage } from "@/ui/shell";

export default function UsageAndBillingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Suspense fallback={<Loading what="usage and billing" />}>
        <UsageAndBillingBody projectId={projectId} />
      </Suspense>
    </AppShell>
  );
}

function UsageAndBillingBody({ projectId }: { readonly projectId: string }) {
  const search = useSearchParams();
  const returned = search.has("credit") || search.has("plan");
  const [billing, setBilling] = useState<
    Answer<BillingAccount> | null | undefined
  >();
  const [usage, setUsage] = useState<Answer<PeriodUsage> | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let current = true;
    setBilling(undefined);
    setUsage(null);
    void (async () => {
      const account = await readBillingAccount();
      if (!current) return;
      setBilling(account);
      // The account determines the eligibility floor. A failed read cannot
      // substitute the organization's older period and show historical charges.
      if (account !== null && account.status !== "ready") return;
      const next = await readPeriodUsage(
        account === null
          ? undefined
          : {
              from: account.value.usageStartedAt,
              to: account.value.resetsAt,
            },
      );
      if (current) setUsage(next);
    })();
    return () => {
      current = false;
    };
  }, [revision]);

  const account = billing?.status === "ready" ? billing.value : null;
  const failure =
    billing !== undefined && billing !== null && billing.status !== "ready"
      ? billing
      : null;
  const reading = billing === undefined || (failure === null && usage === null);
  const returnMessage = reading
    ? "Checking your current billing details…"
    : failure !== null
      ? "Your billing details could not be checked. Refresh to try again."
      : search.get("plan") === "pro" && account?.plan.code === "pro"
        ? "Your organization is on Pro."
        : search.get("plan") === "pro"
          ? "Pro is not active yet. Refresh after checkout finishes."
          : search.get("credit") === "bought"
            ? "Check billing history for your payment. If it has not appeared yet, refresh in a moment."
            : "Checkout closed. Your current billing details are shown below.";

  return (
    <ProductPage viewport>
      <PageHeader title="Usage and billing" />
      <PageBody>
        <SettingsLayout projectId={projectId} current="billing">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={refresh}
              busy={reading}
              disabled={reading || actionBusy}
            >
              Refresh
            </Button>
          </div>
          {returned ? (
            <p className="m-0 text-sm text-muted-foreground" role="status">
              {returnMessage}
            </p>
          ) : null}
          {billing === undefined ? (
            <Loading what="usage and billing" />
          ) : failure !== null ? (
            <Failure
              title="Billing details are unavailable."
              message={
                failure.status === "signed-out"
                  ? "Sign in again to read usage and billing."
                  : failure.refusal.message
              }
              onRetry={refresh}
            />
          ) : (
            <>
              {account === null ? (
                <Card>
                  <p className="m-0 text-base">
                    Billing is not enabled on this deployment.
                  </p>
                  <p className="m-0 text-sm text-muted-foreground">
                    Usage and provider costs are available below. There is no
                    plan or inference balance.
                  </p>
                </Card>
              ) : (
                <BillingAccountSections
                  account={account}
                  onRefresh={refresh}
                  onBusyChange={setActionBusy}
                />
              )}
              <UsageAllowances
                account={account}
                usage={usage}
                onRetry={refresh}
              />
              <ProviderUsage usage={usage} onRetry={refresh} />
              {account === null ? null : (
                <BillingHistory key={revision} initial={account.ledger} />
              )}
            </>
          )}
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}
