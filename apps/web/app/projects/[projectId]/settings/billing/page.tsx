"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { toast } from "sonner";
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

export default function UsageAndBillingPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Suspense fallback={<Loading what="usage and billing" />}>
      <UsageAndBillingBody projectId={projectId} />
    </Suspense>
  );
}

function UsageAndBillingBody({ projectId }: { readonly projectId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const returnedPlan = search.get("plan");
  const returnedCredit = search.get("credit");
  const handledReturn = useRef<string | null>(null);
  const [billing, setBilling] = useState<
    Answer<BillingAccount> | null | undefined
  >();
  const [usage, setUsage] = useState<Answer<PeriodUsage> | null>(null);
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
  useEffect(() => {
    if (
      billing === undefined ||
      (returnedPlan === null && returnedCredit === null)
    ) {
      return;
    }

    const returnKey = `${returnedPlan ?? ""}\u0000${returnedCredit ?? ""}`;
    if (handledReturn.current === returnKey) return;
    handledReturn.current = returnKey;

    const action = { label: "Check again", onClick: refresh };
    if (failure !== null) {
      toast.error("Your billing details could not be checked.", { action });
    } else if (returnedPlan === "pro" && account?.plan.code === "pro") {
      toast.success("Your organization is on Pro.", { action });
    } else if (returnedPlan === "pro") {
      toast.warning("Pro is not active yet. Refresh after checkout finishes.", {
        action,
      });
    } else if (returnedCredit === "bought") {
      toast.info(
        "Check billing history for your payment. If it has not appeared yet, refresh in a moment.",
        { action },
      );
    } else {
      toast.info(
        "Checkout closed. Your current billing details are shown below.",
        { action },
      );
    }

    const nextSearch = new URLSearchParams(search.toString());
    nextSearch.delete("plan");
    nextSearch.delete("credit");
    router.replace(
      nextSearch.size === 0 ? pathname : `${pathname}?${nextSearch.toString()}`,
    );
  }, [
    account?.plan.code,
    billing,
    failure,
    pathname,
    refresh,
    returnedCredit,
    returnedPlan,
    router,
    search,
  ]);

  return (
    <>
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
                Usage and provider costs are available below. There is no plan
                or inference balance.
              </p>
            </Card>
          ) : (
            <BillingAccountSections account={account} onRefresh={refresh} />
          )}
          <UsageAllowances account={account} usage={usage} onRetry={refresh} />
          <ProviderUsage usage={usage} onRetry={refresh} />
          {account === null ? null : (
            <BillingHistory
              key={JSON.stringify(account.ledger.entries.map((entry) => entry.id))}
              initial={account.ledger}
            />
          )}
        </>
      )}
    </>
  );
}
