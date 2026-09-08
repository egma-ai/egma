import {
  ALLOWANCE_KINDS,
  ALLOWANCE_UNITS,
  NotPermittedError,
  type AuthContext,
} from "@egma/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  InvalidLedgerCursorError,
  readBillingOverview,
  readBillingLedger,
  type CloudPlan,
} from "./access/index.ts";
import {
  BillingStateError,
  CREDIT_AMOUNTS_MICROS,
  CreditAmountError,
  LARGEST_CREDIT_MICROS,
  SMALLEST_CREDIT_MICROS,
  openBillingPortal,
  openCreditCheckout,
  openUpgradeCheckout,
  scheduleDowngrade,
} from "./stripe/actions.ts";
import { applyStripeDelivery, isSignatureFailure } from "./stripe/webhook.ts";
import type { StripeGateway } from "./stripe/gateway.ts";

/**
 * What this organization's Billing section reads.
 *
 * **A browser path, and never `/v1`.** The published contract gains nothing
 * from billing: no `cloud_` field may ever appear in a public API response or
 * an SDK type, and the way to keep that shut is for these routes to live
 * outside the operation set that produces OpenAPI and the generated client.
 * They are registered beside `/api/me`, by the API, and only on a deployment
 * that selected the cloud adapter — so a self-hoster's Egma answers 404 here,
 * which is the truth about a deployment with no plans and no balance.
 *
 * **The credential and the rate limit are the API's**, applied to the scope
 * these routes are registered in, exactly as they are for every other browser
 * read. This package holds no opinion about how a request becomes a person; it
 * is handed the context the API already resolved.
 *
 * **Every role reads the plan, the allowances and the balance.** A run that
 * paused for money has to explain itself to whoever started it. Every member
 * can also read the ledger. Only admins take payment actions, and each action
 * checks permission before reaching Stripe.
 *
 * **The webhook door at the foot of this file is not in that scope.** Stripe
 * holds no credential of Egma's, so its signature is the whole gate and the
 * route is mounted outside the credentialed scope, with the raw body its
 * signature is over.
 */

export type BillingRoutesOptions = {
  /**
   * How this deployment turns a request into the context it acts in. The API
   * has already resolved it: this is the one line that hands it over, so
   * nothing in `ee/` reaches into the API's authentication.
   */
  readonly contextOf: (request: FastifyRequest) => AuthContext;
  /** The clock, so a test can stand in a month. */
  readonly now?: () => Date;
  /**
   * The Stripe adapter, on a deployment that has one.
   *
   * Absent, the read below is all this surface offers — which is what a test
   * of the Billing section's numbers mounts, and what a deployment whose
   * Stripe key was set without a webhook secret still gets. The four actions
   * are registered only with one, because a button that cannot reach Stripe is
   * worse than no button.
   */
  readonly stripe?: StripeGateway | undefined;
};

/** Where the Billing section reads from. Named so the API can log it. */
export const BILLING_PATH = "/api/organization/billing";

/** The four things an admin does. Each opens a Stripe-hosted page, or ends Pro. */
export const CREDIT_PATH = "/api/billing/credit";
export const UPGRADE_PATH = "/api/billing/upgrade";
export const DOWNGRADE_PATH = "/api/billing/downgrade";
export const PORTAL_PATH = "/api/billing/portal";

/**
 * A refusal in the API's own shape: a stable code and a sentence.
 *
 * Written here rather than imported, because this package may not depend on
 * the application that mounts it. The two must agree, and they agree on two
 * fields and a status — which is the whole contract a browser branches on.
 */
function refuse(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error, message });
}

/**
 * The one place an action's failure becomes an answer.
 *
 * Three refusals a person can act on, and everything else left to the API's
 * own fault handling: a Stripe that is down is not a sentence anybody can fix,
 * and relaying its message would put a vendor's wording on Egma's page.
 */
async function answering(
  reply: FastifyReply,
  act: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await act();
  } catch (fault) {
    if (fault instanceof NotPermittedError) {
      return refuse(reply, 403, "not_permitted", fault.message);
    }
    if (fault instanceof CreditAmountError) {
      return refuse(reply, 400, "invalid_request", fault.message);
    }
    if (fault instanceof BillingStateError) {
      return refuse(reply, 422, "unprocessable", fault.message);
    }
    throw fault;
  }
}

/** The amount a Buy credit request asked for, or nothing it could read. */
function amountMicrosOf(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const asked = (body as Record<string, unknown>)["amountMicros"];
  return typeof asked === "number" ? asked : undefined;
}

function allowanceOf(plan: CloudPlan, kind: string): number | null {
  switch (kind) {
    case "chat_simulations":
      return plan.chatSimulationsAllowance;
    case "web_call_minutes":
      return plan.webCallMinutesAllowance;
    case "phone_minutes":
      return plan.phoneMinutesAllowance;
    default:
      return null;
  }
}

export async function billingRoutes(
  app: FastifyInstance,
  options: BillingRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const stripe = options.stripe;
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return refuse(reply, 403, "not_permitted", error.message);
    }
    throw error;
  });

  app.get(BILLING_PATH, async (request, reply) => {
    const auth = options.contextOf(request);
    const { account, plan, period, usage, ledger, mayManageBilling } =
      await readBillingOverview(auth, now());

    return reply.send({
      plan: {
        code: plan.code,
        name: plan.name,
        feeMicros: plan.feeMicros,
        // An ordered list rather than an object, so the page renders the same
        // three facts in the same order on every deployment, each carrying the
        // unit it is published in. `null` is unlimited and says so as itself.
        allowances: ALLOWANCE_KINDS.map((kind) => ({
          kind,
          unit: ALLOWANCE_UNITS[kind],
          allowed: allowanceOf(plan, kind),
          used: usage.used[kind],
          overageMicrosPerMinute:
            kind === "phone_minutes"
              ? plan.phoneOverageMicrosPerMinute
              : kind === "web_call_minutes"
                ? plan.webCallOverageMicrosPerMinute
                : 0,
        })),
      },
      balanceMicros: account.balanceMicros,
      scheduledDowngradeAt: account.stripeCancelAt?.toISOString() ?? null,
      periodStartedAt: period.startedAt.toISOString(),
      resetsAt: period.resetsAt.toISOString(),
      mayManageBilling,
      usageStartedAt: new Date(
        Math.max(period.startedAt.getTime(), account.activatedAt.getTime()),
      ).toISOString(),
      ledger,
      /**
       * What an admin may do here, and the amounts the picker offers.
       *
       * Sent rather than assumed, because the buttons exist only on a
       * deployment whose Stripe adapter is in place — and the page cannot know
       * that from the plan. The bounds travel too, so the custom box refuses
       * what the route would refuse and says the same numbers.
       */
      actions: {
        available:
          stripe?.hasWebhookSecret === true && account.stripePaymentsReady,
        creditAmountsMicros: [...CREDIT_AMOUNTS_MICROS],
        smallestCreditMicros: SMALLEST_CREDIT_MICROS,
        largestCreditMicros: LARGEST_CREDIT_MICROS,
      },
    });
  });

  app.get(`${BILLING_PATH}/ledger`, async (request, reply) => {
    const query = request.query as { cursor?: unknown };
    if (query.cursor !== undefined && typeof query.cursor !== "string") {
      return refuse(
        reply,
        400,
        "invalid_request",
        "The billing history cursor is invalid. Reload the page to load billing history again.",
      );
    }
    try {
      return reply.send(
        await readBillingLedger(options.contextOf(request), query.cursor),
      );
    } catch (fault) {
      if (fault instanceof InvalidLedgerCursorError)
        return refuse(
          reply,
          400,
          "invalid_request",
          "The billing history cursor is invalid. Reload the page to load billing history again.",
        );
      throw fault;
    }
  });

  if (stripe === undefined) return;

  app.post(CREDIT_PATH, async (request, reply) => {
    const auth = options.contextOf(request);
    const amountMicros = amountMicrosOf(request.body);
    if (amountMicros === undefined) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "Buying inference credit needs an amount in whole micro-dollars, as " +
          "amountMicros.",
      );
    }
    return answering(reply, async () => {
      const page = await openCreditCheckout(stripe, auth, amountMicros);
      return reply.send(page);
    });
  });

  app.post(UPGRADE_PATH, async (request, reply) =>
    answering(reply, async () => {
      const page = await openUpgradeCheckout(
        stripe,
        options.contextOf(request),
      );
      return reply.send(page);
    }),
  );

  app.post(DOWNGRADE_PATH, async (request, reply) =>
    answering(reply, async () => {
      const stopping = await scheduleDowngrade(
        stripe,
        options.contextOf(request),
      );
      return reply.send({
        endsAt: stopping.endsAt === null ? null : stopping.endsAt.toISOString(),
      });
    }),
  );

  app.post(PORTAL_PATH, async (request, reply) =>
    answering(reply, async () => {
      const page = await openBillingPortal(stripe, options.contextOf(request));
      return reply.send(page);
    }),
  );
}

/** Where Stripe posts what it has decided. */
export const BILLING_WEBHOOK_PATH = "/api/billing/stripe/webhook";

export type BillingWebhookOptions = {
  readonly stripe: StripeGateway;
  /** The clock, so a test can stand at an instant. */
  readonly now?: () => Date;
};

/**
 * Stripe's own door: no cookie, no key, and a signature for a credential.
 *
 * **Registered outside the credentialed scope, deliberately.** The caller is
 * Stripe, which holds nothing Egma issued and never will; what proves the
 * delivery is that only Stripe can sign a body against this deployment's
 * signing secret. A cookie check here would refuse every real delivery and
 * admit nothing extra.
 *
 * **The raw bytes, and that is load-bearing.** Stripe signs the body it sent,
 * so a body parsed into an object and serialised again is a different body and
 * will not verify. The parser below is declared inside this plugin's own
 * scope, where Fastify keeps it: every other route in the process still gets
 * its JSON parsed as JSON.
 *
 * **A fault answers a fault.** Egma applies a delivery in one transaction or
 * not at all, so a failure means Stripe should send it again — and Stripe
 * retries on a 5xx. A bad signature is a 400 and is never retried, which is
 * right: it will not get better.
 */
export async function billingWebhookRoutes(
  app: FastifyInstance,
  options: BillingWebhookOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(BILLING_WEBHOOK_PATH, async (request, reply) => {
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string" || signature === "") {
      return refuse(
        reply,
        400,
        "invalid_request",
        "A Stripe delivery carries a stripe-signature header. This request " +
          "did not, so nothing about it could be proved.",
      );
    }
    const payload = request.body;
    if (!Buffer.isBuffer(payload)) {
      return refuse(
        reply,
        400,
        "invalid_request",
        "A Stripe delivery is a signed body. This request carried none.",
      );
    }

    let applied;
    try {
      applied = await applyStripeDelivery(
        options.stripe,
        payload,
        signature,
        now(),
      );
    } catch (fault) {
      // A signature that did not hold is the caller's problem and will not get
      // better; anything else is Egma's and Stripe should try again. Told
      // apart by Stripe's own class for it, never by reading its wording.
      if (isSignatureFailure(fault)) {
        request.log.warn({ err: fault }, "a Stripe delivery did not verify");
        return refuse(
          reply,
          400,
          "invalid_request",
          "This delivery's signature does not hold against this " +
            "deployment's Stripe signing secret.",
        );
      }
      throw fault;
    }

    return reply.send({
      received: true,
      applied: applied.applied,
      effect: applied.effect,
    });
  });
}
