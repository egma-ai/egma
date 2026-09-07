import Stripe from "stripe";

/**
 * The Stripe adapter: the one place in Egma that holds a Stripe client.
 *
 * **A true external dependency, injected only so the product boots without
 * it.** Nothing here is ever simulated — no in-memory Stripe exists anywhere
 * in this repository, by the founders' rule of 2026-09-07. Tests of billing
 * logic seed the rows this adapter's webhooks would have written; tests of the
 * adapter itself run against the real Stripe sandbox in their own lane and are
 * skipped when no key is present. So this file has exactly one seam — the
 * settings that build it — and no second implementation to keep honest.
 *
 * **It owns four things**, and they are here together because they are the
 * four that need the secret: the client, the API version pinned with the
 * package, the webhook signature check, and the sandbox guard that keeps the
 * Stripe lane away from a live account.
 *
 * Nothing on a request path reaches this. Stripe is consulted by an admin
 * pressing a button, by a webhook, and by an hourly job (ADR-0024).
 */

export type StripeSettings = {
  /** `EGMA_STRIPE_SECRET_KEY`. Its presence is what selects billing at all. */
  readonly secretKey: string;
  /**
   * `EGMA_STRIPE_WEBHOOK_SECRET`, or absent.
   *
   * Absent means this deployment has Stripe but no webhook endpoint yet: the
   * buttons work, and the door that would apply Stripe's answers refuses every
   * delivery rather than trusting an unsigned one. A signature is the only
   * credential a webhook carries, so there is nothing weaker to fall back to.
   */
  readonly webhookSecret?: string | undefined;
  /** The origin a person's browser reaches Egma on. Where Checkout returns to. */
  readonly baseUrl?: string | undefined;
};

export type StripeGateway = {
  /**
   * The client itself.
   *
   * **Handed out rather than wrapped**, because a wrapper around forty Stripe
   * calls would be forty shallow methods whose only content is the name of the
   * call underneath — and the deletion test says so: removing it would move
   * complexity rather than concentrate it. What is worth owning is what is
   * owned here: where the secret is read, which API version is pinned, and how
   * a delivery is proved. Only `ee/src/stripe/` may reach this.
   */
  readonly api: Stripe;
  /** Whether this deployment has a signing secret, and so a webhook door. */
  readonly hasWebhookSecret: boolean;
  /**
   * Whether this key can only ever reach a Stripe sandbox.
   *
   * Stripe's test keys start `sk_test_` or `rk_test_`, and nothing else can
   * be one. The Stripe lane refuses to run against a key that is not one of
   * those, so a test can never create an object on a live account.
   */
  readonly isSandbox: boolean;
  /** Where Checkout sends a person back to. */
  readonly baseUrl: string | undefined;
  /**
   * One signed delivery, verified.
   *
   * Throws where the signature does not hold, where the timestamp is outside
   * Stripe's tolerance, or where this deployment has no signing secret at all.
   * The raw bytes go in — Stripe signs the body it sent, so a body that has
   * been parsed and re-serialised is a different body and will not verify.
   */
  verify(payload: Buffer | string, signature: string): Stripe.Event;
};

/** The prefixes a Stripe key that can only reach a sandbox begins with. */
const SANDBOX_KEY_PREFIXES = ["sk_test_", "rk_test_"] as const;

/** Whether a key can only reach a Stripe sandbox. */
export function isSandboxKey(secretKey: string): boolean {
  return SANDBOX_KEY_PREFIXES.some((prefix) => secretKey.startsWith(prefix));
}

/**
 * The client this deployment's Stripe work goes through.
 *
 * **The API version is the package's own.** `stripe-node` ships pinned to the
 * version its types were generated from, so leaving it alone is what keeps the
 * types and the wire in step — naming a version here would let one move
 * without the other, which is how a field that exists in the types turns out
 * not to exist on the response.
 */
export function stripeGateway(settings: StripeSettings): StripeGateway {
  const secretKey = settings.secretKey.trim();
  if (secretKey === "") {
    throw new Error(
      "a Stripe gateway needs a secret key; a deployment with none runs the " +
        "open billing plug-in and never loads this package",
    );
  }
  const api = new Stripe(secretKey, {
    // Named so a Stripe support conversation can find this deployment's calls,
    // and so Stripe's own dashboard says which application made a write.
    appInfo: { name: "Egma", url: "https://egma.ai" },
    // One retry, so a request lost on the way out is not a button that did
    // nothing. Every write below also carries an idempotency key, which is
    // what makes a retry safe rather than merely quick.
    maxNetworkRetries: 2,
  });
  const webhookSecret = settings.webhookSecret?.trim() || undefined;

  return {
    api,
    hasWebhookSecret: webhookSecret !== undefined,
    isSandbox: isSandboxKey(secretKey),
    baseUrl: settings.baseUrl,
    verify(payload, signature) {
      if (webhookSecret === undefined) {
        throw new Error(
          "this deployment has no Stripe webhook signing secret, so no " +
            "delivery can be proved; set EGMA_STRIPE_WEBHOOK_SECRET",
        );
      }
      return api.webhooks.constructEvent(payload, signature, webhookSecret);
    },
  };
}
