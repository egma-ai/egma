import type { schema } from "@egma/db";
import type Stripe from "stripe";

import type { MeterAccount, MeterPeriodFact } from "../access/index.ts";
import {
  isPaying,
  type CanonicalSubscription,
  type StripeCustomerFacts,
  type PurchasedCreditFact,
} from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";

import { creditFactFrom } from "./credit.ts";

function instant(seconds: number): Date {
  return new Date(seconds * 1_000);
}

/** Use the full customer list; metadata search results can lag behind creation. */
export async function stripeCustomerIds(
  gateway: StripeGateway,
  organizationId: string,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const customer of gateway.api.customers.list({ limit: 100 })) {
    if (customer.metadata.egma_organization_id === organizationId)
      ids.push(customer.id);
  }
  return ids;
}

/** Customer-scoped reads include ended subscriptions and follow every page. */
export async function relevantSubscriptions(
  gateway: StripeGateway,
  customerId: string,
): Promise<Stripe.Subscription[]> {
  const found: Stripe.Subscription[] = [];
  for await (const subscription of gateway.api.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  })) {
    if (subscription.metadata.egma_plan === "pro") found.push(subscription);
  }
  return found;
}

export async function currentSubscription(
  gateway: StripeGateway,
  customerId: string,
  needsHobbyTransition = true,
  previousSubscriptionId: string | null = null,
): Promise<CanonicalSubscription> {
  const subscriptions = await relevantSubscriptions(gateway, customerId);
  const payable = subscriptions.filter((subscription) =>
    isPaying(subscription.status),
  );
  if (payable.length > 1)
    throw new Error(
      `Stripe customer ${customerId} has multiple payable Egma subscriptions`,
    );
  const selected =
    payable[0] ??
    subscriptions.sort(
      (left, right) =>
        right.created - left.created || right.id.localeCompare(left.id),
    )[0];
  if (selected === undefined)
    return {
      subscriptionId: null,
      status: null,
      periodAnchor: null,
      periodStartedAt: null,
      periodEndsAt: null,
      hobbyStartedAt: null,
    };
  const statuses: readonly string[] = [
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "paused",
  ];
  if (!statuses.includes(selected.status))
    throw new Error(
      `unsupported Stripe subscription status ${selected.status}`,
    );
  if (selected.items.has_more)
    throw new Error(
      "an Egma subscription has more items than the complete billing contract",
    );
  const periods = selected.items.data.map(
    (item) => [item.current_period_start, item.current_period_end] as const,
  );
  const first = periods[0];
  if (
    first === undefined ||
    periods.some(([start, end]) => start !== first[0] || end !== first[1])
  ) {
    throw new Error("Egma subscription items do not share a billing period");
  }
  return {
    subscriptionId: selected.id,
    status: selected.status as schema.SubscriptionStatus,
    periodAnchor: instant(selected.billing_cycle_anchor),
    periodStartedAt: instant(first[0]),
    periodEndsAt: instant(first[1]),
    hobbyStartedAt: needsHobbyTransition
      ? await hobbyTransitionAt(
          gateway,
          !isPaying(selected.status) && previousSubscriptionId !== null
            ? (subscriptions.find((one) => one.id === previousSubscriptionId) ??
                selected)
            : selected,
        )
      : null,
  };
}

async function hobbyTransitionAt(
  gateway: StripeGateway,
  subscription: Stripe.Subscription,
): Promise<Date | null> {
  if (isPaying(subscription.status)) return null;
  if (subscription.status === "canceled" && subscription.ended_at !== null)
    return instant(subscription.ended_at);
  if (subscription.status === "paused" && subscription.trial_end !== null)
    return instant(subscription.trial_end);
  if (
    subscription.status !== "unpaid" &&
    subscription.status !== "canceled" &&
    subscription.status !== "paused"
  )
    return null;
  for await (const event of gateway.api.events.list({
    types: ["customer.subscription.updated", "customer.subscription.deleted"],
    limit: 100,
  })) {
    if (
      event.type !== "customer.subscription.updated" &&
      event.type !== "customer.subscription.deleted"
    )
      continue;
    if (
      event.data.object.id !== subscription.id ||
      event.data.object.status !== subscription.status
    )
      continue;
    const before = event.data.previous_attributes?.status;
    if (
      event.type === "customer.subscription.deleted" ||
      (before !== undefined && isPaying(before))
    )
      return instant(event.created);
  }
  throw new Error(
    `Stripe's retained events do not prove when ${subscription.id} became ${subscription.status}; no Hobby reset date was invented`,
  );
}

/** Re-read paid Checkout identities instead of using an event timestamp watermark. */
export async function currentStripeCustomer(
  gateway: StripeGateway,
  customerId: string,
  at: Date,
  needsHobbyTransition: boolean,
  previousSubscriptionId: string | null,
): Promise<StripeCustomerFacts> {
  const credits: PurchasedCreditFact[] = [];
  for await (const session of gateway.api.checkout.sessions.list({
    customer: customerId,
    status: "complete",
    limit: 100,
  })) {
    const fact = creditFactFrom(session, at);
    if (fact !== undefined) credits.push(fact);
  }
  return {
    credits,
    subscription: await currentSubscription(
      gateway,
      customerId,
      needsHobbyTransition,
      previousSubscriptionId,
    ),
  };
}

/** Actual invoice line periods preserve history when the current anchor moves. */
export async function stripeMeterPeriods(
  gateway: StripeGateway,
  account: MeterAccount,
  at: Date,
  known: readonly MeterPeriodFact[] = [],
): Promise<MeterPeriodFact[]> {
  const subscriptions = await relevantSubscriptions(
    gateway,
    account.stripeCustomerId,
  );
  const facts = new Map<string, MeterPeriodFact>();
  const prices = new Map<string, Stripe.Price>();
  const channels = [
    {
      channel: "web_call_minutes",
      meterId: account.webCallMeterId,
      eventName: "egma_web_call_minutes",
    },
    {
      channel: "phone_minutes",
      meterId: account.phoneMeterId,
      eventName: "egma_phone_minutes",
    },
  ] as const;

  const remember = (fact: MeterPeriodFact): void => {
    if (
      fact.periodEndsAt <= account.activatedAt ||
      fact.periodEndsAt <= fact.periodStartedAt
    )
      return;
    const key = `${fact.stripeSubscriptionId}:${fact.periodStartedAt.toISOString()}:${fact.periodEndsAt.toISOString()}:${fact.channel}`;
    const held = facts.get(key);
    // A closing invoice owns eligibility once the period has ended.
    if (
      held === undefined ||
      fact.invoiceId !== null ||
      held.invoiceId === null
    )
      facts.set(key, fact);
  };

  for (const fact of known) remember({ ...fact, acceptingUsage: false });

  for (const subscription of subscriptions) {
    if (subscription.items.has_more)
      throw new Error("an Egma subscription has an incomplete item list");
    for (const item of subscription.items.data) {
      prices.set(item.price.id, item.price);
      const channel = channels.find(
        (one) => one.meterId === item.price.recurring?.meter,
      );
      if (channel === undefined || channel.meterId === null) continue;
      remember({
        stripeSubscriptionId: subscription.id,
        periodStartedAt: instant(item.current_period_start),
        periodEndsAt: instant(
          Math.min(
            item.current_period_end,
            subscription.ended_at ?? item.current_period_end,
          ),
        ),
        channel: channel.channel,
        meterId: channel.meterId,
        eventName: channel.eventName,
        priceId: item.price.id,
        invoiceId: null,
        acceptingUsage:
          isPaying(subscription.status) &&
          item.current_period_end * 1_000 > at.getTime(),
      });
    }
    for await (const invoice of gateway.api.invoices.list({
      customer: account.stripeCustomerId,
      subscription: subscription.id,
      limit: 100,
    })) {
      const lines: Stripe.InvoiceLineItem[] = [];
      for await (const line of gateway.api.invoices.listLineItems(invoice.id, {
        limit: 100,
      }))
        lines.push(line);
      for (const line of lines) {
        const priceRef = line.pricing?.price_details?.price;
        if (
          priceRef === undefined ||
          line.parent?.subscription_item_details?.proration === true
        )
          continue;
        const priceId = typeof priceRef === "string" ? priceRef : priceRef.id;
        const price =
          typeof priceRef === "string"
            ? (prices.get(priceId) ??
              (await gateway.api.prices.retrieve(priceId)))
            : priceRef;
        prices.set(priceId, price);
        const channel = channels.find(
          (one) => one.meterId === price.recurring?.meter,
        );
        if (channel === undefined || channel.meterId === null) continue;
        // The initial invoice charges the fee in advance, not this period's usage.
        if (invoice.created < line.period.end) continue;
        remember({
          stripeSubscriptionId: subscription.id,
          periodStartedAt: instant(line.period.start),
          periodEndsAt: instant(line.period.end),
          channel: channel.channel,
          meterId: channel.meterId,
          eventName: channel.eventName,
          priceId,
          invoiceId: invoice.id,
          acceptingUsage:
            invoice.status === "draft" &&
            invoice.billing_reason === "subscription_cycle",
        });
      }
    }
  }
  const periods = [...facts.values()].sort(
    (left, right) =>
      left.periodStartedAt.getTime() - right.periodStartedAt.getTime() ||
      left.channel.localeCompare(right.channel),
  );
  const previous = new Map<string, MeterPeriodFact>();
  for (const period of periods) {
    const earlier = previous.get(period.channel);
    if (
      earlier !== undefined &&
      period.periodStartedAt < earlier.periodEndsAt
    ) {
      throw new Error(
        `Stripe ${period.channel} periods overlap for customer ${account.stripeCustomerId}; usage requires reconciliation before another send`,
      );
    }
    previous.set(period.channel, period);
  }
  return periods;
}
