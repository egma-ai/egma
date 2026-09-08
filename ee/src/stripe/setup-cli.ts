import { connect, disconnect, runMigrations } from "@egma/db";

import { isSandboxKey, stripeGateway } from "./gateway.ts";
import { setUpStripe, type HeadOffice } from "./setup.ts";
import { HANDLED_EVENT_TYPES } from "./webhook.ts";

/**
 * `pnpm --filter @egma/ee stripe:setup` — set a Stripe account up to sell Pro.
 *
 * **One command, run as often as you like.** It finds every object before it
 * makes one, so a second run creates nothing; a run after a price change in
 * `plans.json` makes the new price and moves the lookup key onto it. What it
 * leaves behind is six identifiers on the `pro` row of `cloud_plan`, which is
 * what an upgrade reads.
 *
 * **What it reads.** `DATABASE_URL` and `EGMA_STRIPE_SECRET_KEY`, which every
 * deployment already answers, and the head office, which only this command
 * reads and which is therefore not a deployment setting:
 *
 *   EGMA_STRIPE_HEAD_OFFICE        the whole address as JSON, or
 *   EGMA_STRIPE_HEAD_OFFICE_LINE1  …_LINE2, …_CITY, …_STATE,
 *   EGMA_STRIPE_HEAD_OFFICE_POSTAL_CODE, …_COUNTRY
 *
 * With no address the run says so and leaves Stripe Tax pending; everything
 * else is still created.
 *
 * **It refuses a live key unless somebody says so out loud.** Stripe's test
 * keys start `sk_test_` or `rk_test_`; anything else can create a product and
 * a price on a real account, so it needs `EGMA_STRIPE_SETUP_ALLOW_LIVE=1`.
 */

function readHeadOffice(): HeadOffice | undefined {
  const whole = process.env["EGMA_STRIPE_HEAD_OFFICE"]?.trim();
  if (whole) {
    const parsed = JSON.parse(whole) as Record<string, unknown>;
    const line1 = parsed["line1"];
    const country = parsed["country"];
    if (typeof line1 !== "string" || typeof country !== "string") {
      throw new Error(
        "EGMA_STRIPE_HEAD_OFFICE needs at least line1 and a two-letter country",
      );
    }
    return {
      line1,
      country,
      ...optional("line2", parsed["line2"]),
      ...optional("city", parsed["city"]),
      ...optional("state", parsed["state"]),
      ...optional("postal_code", parsed["postal_code"]),
    };
  }

  const line1 = process.env["EGMA_STRIPE_HEAD_OFFICE_LINE1"]?.trim();
  const country = process.env["EGMA_STRIPE_HEAD_OFFICE_COUNTRY"]?.trim();
  if (!line1 || !country) return undefined;
  return {
    line1,
    country,
    ...optional("line2", process.env["EGMA_STRIPE_HEAD_OFFICE_LINE2"]),
    ...optional("city", process.env["EGMA_STRIPE_HEAD_OFFICE_CITY"]),
    ...optional("state", process.env["EGMA_STRIPE_HEAD_OFFICE_STATE"]),
    ...optional(
      "postal_code",
      process.env["EGMA_STRIPE_HEAD_OFFICE_POSTAL_CODE"],
    ),
  };
}

/** A field Stripe's address takes, present only when this deployment set it. */
function optional(field: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value.trim() !== ""
    ? { [field]: value.trim() }
    : {};
}

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

const secretKey = process.env["EGMA_STRIPE_SECRET_KEY"]?.trim();
if (!secretKey) {
  refuse(
    "EGMA_STRIPE_SECRET_KEY is not set. This command sets up the Stripe " +
      "account a deployment sells Pro on; a deployment with no key does not " +
      "bill anybody and needs none of it.",
  );
}
if (
  !isSandboxKey(secretKey) &&
  process.env["EGMA_STRIPE_SETUP_ALLOW_LIVE"]?.trim() !== "1"
) {
  refuse(
    "EGMA_STRIPE_SECRET_KEY is not a Stripe test key, so this run would " +
      "create a product, three prices and two meters on a live account. Set " +
      "EGMA_STRIPE_SETUP_ALLOW_LIVE=1 if that is what you mean.",
  );
}

const databaseUrl = process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) {
  refuse(
    "DATABASE_URL is not set. The setup writes the Stripe object ids onto " +
      "this deployment's own plan row, so it needs the same database the API " +
      "reads.",
  );
}

// The plan rows are seeded from `plans.json` by the setup, and a seed needs the
// table. Applying the migrations here means a fresh deployment can be set up
// before its API has ever booted.
await runMigrations(databaseUrl);
connect({ databaseUrl });
try {
  const gateway = stripeGateway({ secretKey });
  const headOffice = readHeadOffice();
  const setup = await setUpStripe(gateway, {
    ...(headOffice === undefined ? {} : { headOffice }),
  });
  console.log(
    setup.created.length === 0
      ? "Nothing was created: this Stripe account was already set up."
      : `Created: ${setup.created.join(", ")}.`,
  );
  // The other half an operator has to do by hand, said here rather than only
  // in the reference: a webhook endpoint subscribed to less than this list
  // fails quietly — a payment simply never reaches a balance.
  console.log(
    "\nAdd a Stripe webhook endpoint pointing at " +
      "<your deployment>/api/billing/stripe/webhook, subscribed to:\n" +
      HANDLED_EVENT_TYPES.map((type) => `  ${type}`).join("\n") +
      "\nThen set its signing secret as EGMA_STRIPE_WEBHOOK_SECRET.",
  );
} finally {
  await disconnect();
}
