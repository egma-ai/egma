export type FinalizedPeriodEvidence = {
  readonly invoiceId: string;
  readonly includedSeconds: number;
  readonly centsPerMinute: number;
  readonly invoicedSeconds: number;
  readonly invoicedCents: number;
};

/** Round the complete period once; later batches charge only its new difference. */
export function periodOverageCents(
  seconds: number,
  includedSeconds: number,
  centsPerMinute: number,
): number {
  if (
    ![seconds, includedSeconds, centsPerMinute].every(Number.isSafeInteger) ||
    seconds < 0 ||
    includedSeconds < 0 ||
    centsPerMinute <= 0
  ) {
    throw new Error("invalid original-period pricing basis");
  }
  const cents =
    (BigInt(Math.max(seconds - includedSeconds, 0)) * BigInt(centsPerMinute) +
      30n) /
    60n;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("period charge exceeds safe currency range");
  return Number(cents);
}

export type PendingLateInvoice = {
  readonly identifier: string;
  readonly throughSeconds: number;
  readonly amountCents: number;
  readonly invoiceCreateStartedAt: Date | null;
  readonly invoiceId: string | null;
  readonly itemCreateStartedAt: Date | null;
  readonly invoiceItemId: string | null;
};

export function latePaymentDefaults(facts: {
  customerPaymentMethod: string | null;
  subscriptionPaymentMethod: string | null;
  customerSource: string | null;
  subscriptionSource: string | null;
}):
  | { default_payment_method: string }
  | { default_source: string }
  | undefined {
  const method = facts.customerPaymentMethod ?? facts.subscriptionPaymentMethod;
  if (method !== null) return { default_payment_method: method };
  const source = facts.customerSource ?? facts.subscriptionSource;
  return source === null ? undefined : { default_source: source };
}
