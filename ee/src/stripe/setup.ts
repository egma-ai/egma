import Stripe from "stripe";

import {
  recordStripePlanObjects,
  seedCloudPlans,
  type CloudPlan,
} from "../access/index.ts";
import { centsFromMicros } from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";
import { METER_EVENT_NAMES } from "./meter.ts";

/**
 * The Stripe account this deployment sells Pro on, set up as code.
 *
 * **Idempotent, and that is what makes it code rather than a runbook.** Every
 * object is found before it is made — meters by their event name, the product
 * by its metadata, prices by their lookup key — so running it twice creates
 * nothing and running it after a price change in `plans.json` moves the lookup
 * key onto a new price, because a Stripe price is immutable and a changed
 * price is a new one.
 *
 * **Why it exists at all.** The Stripe objects are not in `plans.json` and
 * cannot be: a product id and a price id are made by Stripe and belong to one
 * account, so a fresh sandbox, a second sandbox and a live account each need
 * their own. A dashboard click-through would put six identifiers in a runbook
 * nobody re-reads. This is one command whose result is the same however many
 * times it runs.
 *
 * **Nothing here is on a request path**, and nothing on one calls it.
 */

/** Where the fee and the two metered prices are found again, by lookup key. */
export const PRICE_LOOKUP_KEYS = {
  fee: "egma_pro_fee_monthly",
  web_call_minutes: "egma_pro_web_call_minutes",
  phone_minutes: "egma_pro_phone_minutes",
} as const;

/** What names the Pro product on the Stripe account, so it can be found again. */
export const PRODUCT_METADATA_KEY = "egma_plan";

/** The business address Stripe Tax works a rate out from. */
export type HeadOffice = {
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city?: string | undefined;
  readonly state?: string | undefined;
  readonly postal_code?: string | undefined;
  /** Two letters, ISO 3166-1. Stripe Tax cannot be enabled without one. */
  readonly country: string;
};

export type StripeSetupOptions = {
  /**
   * The head office, or absent.
   *
   * Absent is not a failure: Stripe Tax stays pending, the setup says so, and
   * everything else is created. A deployment whose founders have not decided
   * where the business is still needs its product and its meters.
   */
  readonly headOffice?: HeadOffice | undefined;
  /** Where the setup says what it did. Standard output by default. */
  readonly say?: (message: string) => void;
};

/** What one run of the setup found or made. */
export type StripeSetup = {
  readonly taxStatus: "active" | "pending" | "skipped";
  readonly productId: string;
  readonly feePriceId: string;
  readonly webCallMeterId: string;
  readonly phoneMeterId: string;
  readonly webCallMeterPriceId: string;
  readonly phoneMeterPriceId: string;
  /** Which of the six this run created rather than found. */
  readonly created: readonly string[];
};

/**
 * Set this Stripe account up to sell Pro, and write the object ids onto the
 * plan row.
 *
 * The plan rows are seeded first, because the prices are made from Pro's fee,
 * its two allowances and its two overage prices — and a price created from a
 * plan row nobody wrote would be a price that does not match what the product
 * enforces.
 */
export async function setUpStripe(
  gateway: StripeGateway,
  options: StripeSetupOptions = {},
): Promise<StripeSetup> {
  const say = options.say ?? ((message: string) => console.log(message));
  const created: string[] = [];

  const seeded = await seedCloudPlans();
  const pro = seeded.plans.find((plan) => plan.code === "pro");
  if (pro === undefined) {
    throw new Error(
      "this deployment has no Pro plan row, so there is nothing to create " +
        "Stripe prices from",
    );
  }

  const taxStatus = await setHeadOffice(gateway, options.headOffice, say);

  const webCallMeter = await findOrCreateMeter(
    gateway,
    METER_EVENT_NAMES.web_call_minutes,
    "Egma web-call minutes",
    created,
    say,
  );
  const phoneMeter = await findOrCreateMeter(
    gateway,
    METER_EVENT_NAMES.phone_minutes,
    "Egma phone minutes",
    created,
    say,
  );

  const product = await findOrCreateProduct(gateway, pro, created, say);
  const feePrice = await findOrCreateFeePrice(
    gateway,
    product.id,
    pro,
    created,
    say,
  );
  const webCallPrice = await findOrCreateMeteredPrice(
    gateway,
    product.id,
    {
      lookupKey: PRICE_LOOKUP_KEYS.web_call_minutes,
      nickname: "Pro web-call minutes",
      meterId: webCallMeter.id,
      includedMinutes: pro.webCallMinutesAllowance,
      overageMicrosPerMinute: pro.webCallOverageMicrosPerMinute,
    },
    created,
    say,
  );
  const phonePrice = await findOrCreateMeteredPrice(
    gateway,
    product.id,
    {
      lookupKey: PRICE_LOOKUP_KEYS.phone_minutes,
      nickname: "Pro phone minutes",
      meterId: phoneMeter.id,
      includedMinutes: pro.phoneMinutesAllowance,
      overageMicrosPerMinute: pro.phoneOverageMicrosPerMinute,
    },
    created,
    say,
  );

  const objects = {
    planCode: "pro",
    productId: product.id,
    feePriceId: feePrice.id,
    webCallMeterId: webCallMeter.id,
    phoneMeterId: phoneMeter.id,
    webCallMeterPriceId: webCallPrice.id,
    phoneMeterPriceId: phonePrice.id,
  } as const;
  await recordStripePlanObjects(objects);
  say(`Wrote the six Stripe object ids onto the ${objects.planCode} plan row.`);

  return { taxStatus, created, ...objects };
}

/**
 * Set the head office, which is what turns Stripe Tax on.
 *
 * Stripe Tax's status is `pending` until a head office is set and `active`
 * afterwards; there is no separate switch. With no address supplied the
 * account is left as it is and the setup says so, because a made-up address
 * would be worse than no tax calculation.
 */
async function setHeadOffice(
  gateway: StripeGateway,
  headOffice: HeadOffice | undefined,
  say: (message: string) => void,
): Promise<"active" | "pending" | "skipped"> {
  if (headOffice === undefined) {
    // Read rather than assumed, and a read that fails is not a failure: an
    // account whose Tax settings cannot be retrieved is an account with no
    // head office, which is the case this branch is already for.
    const held = await gateway.api.tax.settings
      .retrieve()
      .catch(() => undefined);
    if (held?.status === "active") {
      say("Stripe Tax is already active; no head office was supplied.");
      return "active";
    }
    say(
      "No head office was supplied, so Stripe Tax stays pending. Set " +
        "EGMA_STRIPE_HEAD_OFFICE (JSON) or the EGMA_STRIPE_HEAD_OFFICE_* " +
        "variables and run this again.",
    );
    return "skipped";
  }

  const settings = await gateway.api.tax.settings.update({
    // Written key by key rather than spread, because Stripe's address
    // parameter has no place for an explicit `undefined` and an optional line
    // this deployment did not supply must be absent rather than empty.
    head_office: { address: addressParam(headOffice) },
    // Every Egma price adds tax on top of the amount rather than taking it
    // out, so this is the default the account states as well.
    defaults: { tax_behavior: "exclusive" },
  });
  say(
    settings.status === "active"
      ? "Stripe Tax is active: the head office is set."
      : `Stripe Tax is still ${settings.status} after setting the head office.`,
  );
  return settings.status === "active" ? "active" : "pending";
}

/**
 * The meter for one event name, found or made once.
 *
 * **Found by its event name and never deleted.** Stripe's test-data deletion
 * does not remove a meter, so a sandbox keeps its meters across every reset —
 * which is exactly why the lookup is by name and the id is stored rather than
 * assumed.
 */
async function findOrCreateMeter(
  gateway: StripeGateway,
  eventName: string,
  displayName: string,
  created: string[],
  say: (message: string) => void,
): Promise<Stripe.Billing.Meter> {
  for await (const meter of gateway.api.billing.meters.list({
    status: "active",
    limit: 100,
  })) {
    if (meter.event_name === eventName) return meter;
  }

  const meter = await gateway.api.billing.meters.create({
    display_name: displayName,
    event_name: eventName,
    // Minutes add up over a period, so the aggregation is a sum. The customer
    // is named by Stripe's own id in the payload, which is what the hourly job
    // reads off the billing account.
    default_aggregation: { formula: "sum" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
    value_settings: { event_payload_key: "value" },
  });
  created.push(`meter ${eventName}`);
  say(`Created the ${eventName} meter (${meter.id}).`);
  return meter;
}

/** The Pro product, found by its metadata or made. */
async function findOrCreateProduct(
  gateway: StripeGateway,
  plan: CloudPlan,
  created: string[],
  say: (message: string) => void,
): Promise<Stripe.Product> {
  const found = await findProduct(gateway, plan.code);
  if (found !== undefined) return found;

  const product = await gateway.api.products.create({
    name: `Egma ${plan.name}`,
    description:
      "The Egma Pro plan: unlimited chat simulations, included web-call and " +
      "phone minutes, and per-minute overage past them.",
    metadata: { [PRODUCT_METADATA_KEY]: plan.code },
  });
  created.push(`product ${plan.code}`);
  say(`Created the ${plan.name} product (${product.id}).`);
  return product;
}

/**
 * The product whose metadata names this plan.
 *
 * Search first, because that is what the metadata index is for; then a bounded
 * list, because search is eventually consistent and a product created a minute
 * ago may not be in it yet — and a setup that could not see its own last run
 * would make a second product every time.
 */
async function findProduct(
  gateway: StripeGateway,
  planCode: string,
): Promise<Stripe.Product | undefined> {
  try {
    const searched = await gateway.api.products.search({
      query: `metadata['${PRODUCT_METADATA_KEY}']:'${planCode}'`,
      limit: 1,
    });
    const first = searched.data[0];
    if (first !== undefined) return first;
  } catch {
    // Search is not available on every account state. The list below is the
    // answer either way.
  }

  let seen = 0;
  for await (const product of gateway.api.products.list({ limit: 100 })) {
    if (product.metadata[PRODUCT_METADATA_KEY] === planCode) return product;
    seen += 1;
    // A bound, so a very large account cannot turn a setup into a full scan.
    // A product this deployment made is one of the newest, and the list comes
    // back newest first.
    if (seen >= 500) break;
  }
  return undefined;
}

/** The monthly fee price: $50 a month, licensed, tax added on top. */
async function findOrCreateFeePrice(
  gateway: StripeGateway,
  productId: string,
  plan: CloudPlan,
  created: string[],
  say: (message: string) => void,
): Promise<Stripe.Price> {
  const wanted = centsFromMicros(plan.feeMicros);
  const held = await findPrice(gateway, PRICE_LOOKUP_KEYS.fee);
  if (
    held !== undefined &&
    held.unit_amount === wanted &&
    held.recurring?.interval === "month" &&
    held.recurring.usage_type === "licensed"
  ) {
    return held;
  }

  const price = await gateway.api.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: wanted,
    tax_behavior: "exclusive",
    recurring: { interval: "month", usage_type: "licensed" },
    lookup_key: PRICE_LOOKUP_KEYS.fee,
    // A Stripe price is immutable, so a fee change is a new price. Moving the
    // lookup key onto it is what keeps "the Pro fee" one name.
    transfer_lookup_key: held !== undefined,
    nickname: `${plan.name} monthly fee`,
  });
  created.push(`price ${PRICE_LOOKUP_KEYS.fee}`);
  say(
    held === undefined
      ? `Created the Pro fee price (${price.id}).`
      : `Replaced the Pro fee price with ${price.id}; the lookup key moved.`,
  );
  return price;
}

type MeteredPricePlan = {
  readonly lookupKey: string;
  readonly nickname: string;
  readonly meterId: string;
  /** The minutes the plan includes. `null` is unlimited: nothing is metered. */
  readonly includedMinutes: number | null;
  readonly overageMicrosPerMinute: number;
};

/**
 * One tiered metered price: the allowance at nothing, everything past it at
 * the overage price.
 *
 * **Two graduated tiers, and the first one is the allowance.** Stripe prices
 * the tiers itself, so a Pro customer's invoice shows the included minutes at
 * zero and the rest at the published price — which is the same allowance Egma
 * enforces from its own rows, expressed once more where the invoice is made.
 *
 * The overage is written as `unit_amount_decimal` because a per-minute price
 * can be a fraction of a cent, and `unit_amount` is whole cents.
 */
async function findOrCreateMeteredPrice(
  gateway: StripeGateway,
  productId: string,
  wanted: MeteredPricePlan,
  created: string[],
  say: (message: string) => void,
): Promise<Stripe.Price> {
  if (wanted.includedMinutes === null) {
    throw new Error(
      `the ${wanted.lookupKey} price needs an allowance to put in its first ` +
        "tier, and this plan's is unlimited",
    );
  }
  const centsPerMinute = wanted.overageMicrosPerMinute / 10_000;
  const held = await findPrice(gateway, wanted.lookupKey, true);
  if (held !== undefined && meteredPriceMatches(held, wanted, centsPerMinute)) {
    return held;
  }

  const price = await gateway.api.prices.create({
    product: productId,
    currency: "usd",
    tax_behavior: "exclusive",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: wanted.includedMinutes, unit_amount: 0 },
      {
        up_to: "inf",
        // A per-minute price can be a fraction of a cent, and `unit_amount` is
        // whole cents. Stripe's own decimal type carries it exactly.
        unit_amount_decimal: Stripe.Decimal.from(String(centsPerMinute)),
      },
    ],
    recurring: {
      interval: "month",
      usage_type: "metered",
      meter: wanted.meterId,
    },
    lookup_key: wanted.lookupKey,
    transfer_lookup_key: held !== undefined,
    nickname: wanted.nickname,
  });
  created.push(`price ${wanted.lookupKey}`);
  say(
    held === undefined
      ? `Created the ${wanted.nickname} price (${price.id}).`
      : `Replaced the ${wanted.nickname} price with ${price.id}; the lookup ` +
          "key moved.",
  );
  return price;
}

/** Whether a held price already says what the plan row says. */
function meteredPriceMatches(
  held: Stripe.Price,
  wanted: MeteredPricePlan,
  centsPerMinute: number,
): boolean {
  if (held.recurring?.usage_type !== "metered") return false;
  if (held.recurring.meter !== wanted.meterId) return false;
  const tiers = held.tiers;
  if (tiers === undefined || tiers.length !== 2) return false;
  const [included, beyond] = tiers;
  if (included === undefined || beyond === undefined) return false;
  if (included.up_to !== wanted.includedMinutes) return false;
  if (included.unit_amount !== 0 && Number(String(included.unit_amount_decimal)) !== 0) {
    return false;
  }
  if (beyond.up_to !== null) return false;
  const beyondCents =
    beyond.unit_amount_decimal === null
      ? beyond.unit_amount
      : Number(String(beyond.unit_amount_decimal));
  return beyondCents === centsPerMinute;
}

/** The head office as Stripe's address parameter takes it: no absent keys. */
function addressParam(headOffice: HeadOffice): Stripe.AddressParam {
  return {
    line1: headOffice.line1,
    country: headOffice.country,
    ...(headOffice.line2 === undefined ? {} : { line2: headOffice.line2 }),
    ...(headOffice.city === undefined ? {} : { city: headOffice.city }),
    ...(headOffice.state === undefined ? {} : { state: headOffice.state }),
    ...(headOffice.postal_code === undefined
      ? {}
      : { postal_code: headOffice.postal_code }),
  };
}

/** The active price a lookup key names, or nothing. */
async function findPrice(
  gateway: StripeGateway,
  lookupKey: string,
  withTiers = false,
): Promise<Stripe.Price | undefined> {
  const found = await gateway.api.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
    ...(withTiers ? { expand: ["data.tiers"] } : {}),
  });
  return found.data[0];
}
