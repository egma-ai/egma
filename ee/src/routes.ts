import { ALLOWANCE_KINDS, ALLOWANCE_UNITS, type AuthContext } from "@egma/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { readBillingOverview, type CloudPlan } from "./access/index.ts";

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
 * paused for money has to explain itself to whoever started it. What an admin
 * alone reads is the breakdown of what the money went on, and what an admin
 * alone will do — upgrade, buy credit, manage payment — is the Stripe ticket's
 * and is not here yet, so this surface offers no action at all.
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
};

/** Where the Billing section reads from. Named so the API can log it. */
export const BILLING_PATH = "/api/organization/billing";

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

  app.get(BILLING_PATH, async (request, reply) => {
    const auth = options.contextOf(request);
    const { account, plan, period, charges, mayManageBilling } =
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
        })),
      },
      balanceMicros: account.balanceMicros,
      periodStartedAt: period.startedAt.toISOString(),
      resetsAt: period.resetsAt.toISOString(),
      mayManageBilling,
      charges: charges.map((charge) => ({
        provider: charge.provider,
        model: charge.model,
        requests: charge.requests,
        amountMicros: charge.amountMicros,
      })),
    });
  });
}
