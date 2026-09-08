import { listCustomerFundedProviders } from "@egma/db";
import { setStripePaymentsReady } from "./access/index.ts";
import { startInferenceSettlementJob } from "./settlement.ts";
import type { FastifyInstance } from "fastify";

import { loadCloudBilling } from "./load.ts";
import { billingWebhookRoutes, type BillingRoutesOptions } from "./routes.ts";
import { stripeGateway } from "./stripe/gateway.ts";
import { startOverageMeterJob, type MeterLog } from "./stripe/meter.ts";

export type ApiBillingSettings = {
  readonly stripeSecretKey: string | undefined;
  readonly stripeWebhookSecret?: string | undefined;
  readonly baseUrl: string;
};

/** Bind the billing routes and jobs to this API's Stripe connection. */
export async function loadApiBilling(settings: ApiBillingSettings) {
  const loaded = await loadCloudBilling({
    customerFundedProviders: listCustomerFundedProviders,
  });
  await setStripePaymentsReady(false).catch((fault: unknown) => {
    console.error(
      "Stripe readiness could not be persisted; customer work continues",
      fault,
    );
  });
  const stripe = stripeGateway({
    secretKey: settings.stripeSecretKey ?? "",
    ...(settings.stripeWebhookSecret === undefined
      ? {}
      : { webhookSecret: settings.stripeWebhookSecret }),
    baseUrl: settings.baseUrl,
  });

  return {
    plugIn: loaded.plugIn,
    routes: (
      app: FastifyInstance,
      options: Pick<BillingRoutesOptions, "contextOf">,
    ) =>
      loaded.routes(app, {
        ...options,
        ...(stripe.hasWebhookSecret ? { stripe } : {}),
      }),
    webhookRoutes: stripe.hasWebhookSecret
      ? (app: FastifyInstance) => billingWebhookRoutes(app, { stripe })
      : undefined,
    seededPlans: loaded.seededPlans,
    caughtUp: loaded.caughtUp,
    startMeterJob: (log: MeterLog) => {
      const inference = startInferenceSettlementJob(log);
      const overage = startOverageMeterJob({ gateway: stripe, log });
      return {
        stop() {
          inference.stop();
          overage.stop();
        },
      };
    },
  };
}
