import type Stripe from "stripe";

import type {
  MeterAccount,
  MeterPeriodFact,
  MeterProgress,
} from "../access/index.ts";
import type { MeteredHour } from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";
import {
  periodOverageCents,
  type FinalizedPeriodEvidence,
  type PendingLateInvoice,
} from "./late-facts.ts";

const RETRY_WINDOW = 23 * 3_600_000;
const idOf = (value: string | { id: string } | null): string | null =>
  typeof value === "string" ? value : (value?.id ?? null);

async function originalEvidence(
  gateway: StripeGateway,
  account: MeterAccount,
  period: MeterPeriodFact,
): Promise<FinalizedPeriodEvidence & { taxCode: string | null }> {
  if (period.invoiceId === null)
    throw new Error(
      "the original finalized usage invoice has not been identified",
    );
  const invoice = await gateway.api.invoices.retrieve(period.invoiceId);
  if (
    idOf(invoice.customer) !== account.stripeCustomerId ||
    idOf(invoice.parent?.subscription_details?.subscription ?? null) !==
      period.stripeSubscriptionId ||
    !["open", "paid", "uncollectible"].includes(invoice.status ?? "") ||
    invoice.currency !== "usd"
  ) {
    throw new Error(
      "the original usage invoice is not a valid finalized billing basis",
    );
  }
  const price = await gateway.api.prices.retrieve(period.priceId, {
    expand: ["tiers", "product"],
  });
  const [included, overage] = price.tiers ?? [];
  const normalRate = period.channel === "phone_minutes" ? 2 : 1;
  if (
    price.currency !== "usd" ||
    price.tax_behavior !== "exclusive" ||
    price.tiers_mode !== "graduated" ||
    price.billing_scheme !== "tiered" ||
    price.transform_quantity !== null ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring?.meter !== period.meterId ||
    price.tiers?.length !== 2 ||
    included?.up_to == null ||
    included.unit_amount !== 0 ||
    Number(included.flat_amount_decimal ?? included.flat_amount ?? 0) !== 0 ||
    overage?.up_to !== null ||
    Number(overage.unit_amount_decimal ?? overage.unit_amount) !== normalRate ||
    Number(overage.flat_amount_decimal ?? overage.flat_amount ?? 0) !== 0
  )
    throw new Error(
      "the original usage price does not have Egma's normal allowance and rate",
    );
  let decimalMinutes = 0n;
  let cents = 0;
  let matched = false;
  for await (const line of gateway.api.invoices.listLineItems(invoice.id, {
    limit: 100,
  })) {
    if (
      idOf(line.pricing?.price_details?.price ?? null) !== period.priceId ||
      line.period.start !== period.periodStartedAt.getTime() / 1000 ||
      line.period.end !== period.periodEndsAt.getTime() / 1000
    )
      continue;
    if (
      line.parent?.subscription_item_details?.proration ||
      line.currency !== "usd" ||
      line.quantity_decimal === null
    )
      throw new Error(
        "the original usage line cannot prove an unprorated quantity",
      );
    const value = String(line.quantity_decimal);
    if (!/^\d+(\.\d{1,12})?$/.test(value))
      throw new Error("unsupported original invoice quantity precision");
    const [whole = "0", fraction = ""] = value.split(".");
    decimalMinutes +=
      BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0"));
    // Discounts and credit notes must never be mistaken for missing billed usage.
    cents += line.subtotal;
    matched = true;
  }
  if (!matched)
    throw new Error(
      "no exact original price/service-period line proves the billed usage",
    );
  const invoicedSeconds = Number(
    (decimalMinutes * 60n + 500_000_000_000n) / 1_000_000_000_000n,
  );
  const taxCode =
    typeof price.product === "string" || price.product.deleted
      ? null
      : idOf(price.product.tax_code ?? null);
  const evidence = {
    invoiceId: invoice.id,
    includedSeconds: included.up_to * 60,
    centsPerMinute: normalRate,
    invoicedSeconds,
    invoicedCents: cents,
    taxCode,
  };
  if (
    !Number.isSafeInteger(cents) ||
    periodOverageCents(
      invoicedSeconds,
      evidence.includedSeconds,
      normalRate,
    ) !== cents
  ) {
    throw new Error(
      "original invoice subtotal does not match the original normal tier calculation",
    );
  }
  return evidence;
}

function metadata(
  account: MeterAccount,
  period: MeterPeriodFact,
  pending: PendingLateInvoice,
) {
  return {
    egma_late_usage: pending.identifier,
    egma_organization_id: account.organizationId,
    egma_original_invoice: period.invoiceId ?? "",
    egma_original_price: period.priceId,
    egma_channel: period.channel,
    egma_through_seconds: String(pending.throughSeconds),
    egma_amount_cents: String(pending.amountCents),
  };
}
function verifyMetadata(
  actual: Stripe.Metadata | null,
  expected: Record<string, string>,
) {
  if (
    !Object.entries(expected).every(([key, value]) => actual?.[key] === value)
  )
    throw new Error("Stripe later-invoice identity or amount changed");
}
function retryAllowed(started: Date | null, at: Date) {
  if (started !== null && at.getTime() - started.getTime() >= RETRY_WINDOW)
    throw new Error(
      "a prior Stripe create is unresolved beyond the safe retry window; no second invoice or item was created",
    );
}
function verifyInvoice(
  invoice: Stripe.Invoice,
  account: MeterAccount,
  expected: Record<string, string>,
) {
  verifyMetadata(invoice.metadata, expected);
  if (
    idOf(invoice.customer) !== account.stripeCustomerId ||
    invoice.currency !== "usd" ||
    invoice.collection_method !== "charge_automatically" ||
    !invoice.automatic_tax.enabled ||
    !["draft", "open", "paid", "uncollectible"].includes(invoice.status ?? "")
  )
    throw new Error(
      "Stripe later invoice changed its customer, tax or collection contract",
    );
}

/** One period's known shortfall becomes an independently recoverable invoice. */
export async function recoverLateUsage(
  gateway: StripeGateway,
  account: MeterAccount,
  progress: MeterProgress,
  period: MeterPeriodFact,
  hour: MeteredHour,
  at: Date,
): Promise<boolean> {
  const evidence = await originalEvidence(gateway, account, period);
  let pending = await progress.late(period, evidence, hour, at);
  if (pending === null) return false;
  const expected = metadata(account, period, pending);
  const label = `${period.channel === "phone_minutes" ? "Phone" : "Web"} overage for ${period.periodStartedAt.toISOString().slice(0, 10)} to ${period.periodEndsAt.toISOString().slice(0, 10)} at $0.0${evidence.centsPerMinute}/minute`;
  let invoice: Stripe.Invoice | undefined;
  if (pending.invoiceId !== null)
    invoice = await gateway.api.invoices.retrieve(pending.invoiceId);
  else {
    for await (const candidate of gateway.api.invoices.list({
      customer: account.stripeCustomerId,
      limit: 100,
    })) {
      if (candidate.metadata?.egma_late_usage !== pending.identifier) continue;
      if (invoice !== undefined)
        throw new Error(
          "multiple later invoices have the same obligation identity",
        );
      invoice = candidate;
    }
    if (invoice === undefined) {
      retryAllowed(pending.invoiceCreateStartedAt, at);
      pending = await progress.lateWriteStarted(
        period,
        pending.identifier,
        "invoice",
        at,
      );
      invoice = await gateway.api.invoices.create(
        {
          customer: account.stripeCustomerId,
          currency: "usd",
          auto_advance: false,
          collection_method: "charge_automatically",
          automatic_tax: { enabled: true },
          pending_invoice_items_behavior: "exclude",
          discounts: "",
          description: label,
          metadata: expected,
        },
        { idempotencyKey: `egma-late-invoice:${pending.identifier}` },
      );
    } else if (pending.invoiceCreateStartedAt === null) {
      pending = await progress.lateWriteStarted(
        period,
        pending.identifier,
        "invoice",
        at,
      );
    }
    verifyInvoice(invoice, account, expected);
    await progress.lateResource(
      period,
      pending.identifier,
      "invoice",
      invoice.id,
      at,
    );
  }
  verifyInvoice(invoice, account, expected);
  let item: Stripe.InvoiceItem | undefined;
  if (pending.invoiceItemId !== null)
    item = await gateway.api.invoiceItems.retrieve(pending.invoiceItemId);
  else {
    for await (const candidate of gateway.api.invoiceItems.list({
      customer: account.stripeCustomerId,
      invoice: invoice.id,
      limit: 100,
    })) {
      if (candidate.metadata?.egma_late_usage !== pending.identifier) continue;
      if (item !== undefined)
        throw new Error(
          "multiple later invoice items have the same obligation identity",
        );
      item = candidate;
    }
    if (item === undefined) {
      if (invoice.status !== "draft")
        throw new Error("a finalized later invoice has no matching usage item");
      retryAllowed(pending.itemCreateStartedAt, at);
      pending = await progress.lateWriteStarted(
        period,
        pending.identifier,
        "item",
        at,
      );
      item = await gateway.api.invoiceItems.create(
        {
          customer: account.stripeCustomerId,
          invoice: invoice.id,
          currency: "usd",
          amount: pending.amountCents,
          description: label,
          discountable: false,
          tax_behavior: "exclusive",
          ...(evidence.taxCode === null ? {} : { tax_code: evidence.taxCode }),
          metadata: expected,
          period: {
            start: period.periodStartedAt.getTime() / 1000,
            end: period.periodEndsAt.getTime() / 1000,
          },
        },
        { idempotencyKey: `egma-late-item:${pending.identifier}` },
      );
    } else if (pending.itemCreateStartedAt === null) {
      pending = await progress.lateWriteStarted(
        period,
        pending.identifier,
        "item",
        at,
      );
    }
    verifyMetadata(item.metadata, expected);
    await progress.lateResource(
      period,
      pending.identifier,
      "item",
      item.id,
      at,
    );
  }
  verifyMetadata(item.metadata, expected);
  if (
    idOf(item.customer) !== account.stripeCustomerId ||
    idOf(item.invoice) !== invoice.id ||
    item.amount !== pending.amountCents ||
    item.currency !== "usd" ||
    item.discountable ||
    item.period.start !== period.periodStartedAt.getTime() / 1000 ||
    item.period.end !== period.periodEndsAt.getTime() / 1000
  )
    throw new Error(
      "later invoice item no longer matches its frozen obligation",
    );
  if (invoice.status === "draft")
    invoice = await gateway.api.invoices.finalizeInvoice(
      invoice.id,
      { auto_advance: true },
      { idempotencyKey: `egma-late-finalize:${pending.identifier}` },
    );
  // Re-read the durable invoice even after a successful finalization response.
  invoice = await gateway.api.invoices.retrieve(invoice.id);
  verifyInvoice(invoice, account, expected);
  if (invoice.status === "draft" || invoice.subtotal !== pending.amountCents)
    throw new Error("the later invoice did not finalize at its frozen amount");
  const lines: Stripe.InvoiceLineItem[] = [];
  for await (const line of gateway.api.invoices.listLineItems(invoice.id, {
    limit: 100,
  }))
    lines.push(line);
  if (
    lines.length !== 1 ||
    lines[0]?.parent?.invoice_item_details?.invoice_item !== item.id ||
    lines[0]?.subtotal !== pending.amountCents
  ) {
    throw new Error(
      "the finalized later invoice contains a different usage obligation",
    );
  }
  await progress.finishLate(period, pending.identifier, at);
  return true;
}
