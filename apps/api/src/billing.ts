import {
  billingIsConfigured,
  type AuthContext,
  type BillingPlugIn,
} from "@egma/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Which billing adapter this deployment runs on, chosen once at boot.
 *
 * **The one place in the open product that names the commercially licensed
 * package**, and it names it through a dynamic `import()` taken only when a
 * Stripe secret is set. A self-hoster's process never evaluates that line, so
 * `@egma/ee` is never loaded, and the product is exactly the product. Shared
 * code — `packages/db` and everything under it — never mentions `ee/` at all;
 * this is one layer out, which is the whole reason the selection moved here.
 *
 * **Nothing here asks whether this deployment is Egma Cloud.** The setting is
 * the selection. A self-hoster who names the same secret gets the same
 * billing, which is what makes billing a hosted service rather than a
 * cloud-only feature (ADR-0024).
 *
 * **A failure to load is a boot failure, out loud.** An operator who set a
 * Stripe key expects to be charging, and a deployment that took the key and
 * billed nobody is the worse of the two failures by a long way.
 */

/**
 * The Billing section's routes, as the API sees them.
 *
 * Written structurally rather than imported, so this type costs nothing on a
 * deployment that never loads the package it comes from. The API supplies the
 * one thing the routes cannot know: how a request became the context it acts
 * in.
 */
export type BillingRoutes = (
  app: FastifyInstance,
  options: {
    readonly contextOf: (request: FastifyRequest) => AuthContext;
  },
) => Promise<void>;

/**
 * Stripe's own door, mounted outside the credentialed scope.
 *
 * Its own type because it is registered in its own scope: the caller is
 * Stripe, which holds no credential of Egma's, and the raw body its signature
 * is over must reach it unparsed.
 */
export type BillingWebhookRoutes = (app: FastifyInstance) => Promise<void>;

/** Where this process says what its hourly billing job did. */
export type BillingLog = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

/** A job this process holds until it shuts down. */
export type StoppableJob = { stop(): void };

/** What a deployment with billing got when it loaded the cloud package. */
export type CloudBilling = {
  readonly plugIn: BillingPlugIn;
  readonly routes: BillingRoutes;
  /** Absent where the deployment named no Stripe webhook signing secret. */
  readonly webhookRoutes: BillingWebhookRoutes | undefined;
  /**
   * The plan codes this boot wrote, for the log. The rows themselves come with
   * the plug-in rather than from a line here: the grader installs the same
   * adapter and either process can boot first, so whichever loads it writes
   * them and the other finds them there.
   */
  readonly seededPlans: readonly string[];
  /**
   * The hourly job that reports each Pro organization's minutes to Stripe.
   *
   * Started once this process is serving, because it is neither a gate on
   * serving nor something a request waits for: a Stripe that is unreachable
   * delays a bill and stops no work.
   */
  startMeterJob(log: BillingLog): StoppableJob;
};

export async function loadCloudBilling(settings: {
  readonly stripeSecretKey: string | undefined;
  readonly stripeWebhookSecret?: string | undefined;
  readonly baseUrl: string;
}): Promise<CloudBilling | undefined> {
  if (!billingIsConfigured(settings)) return undefined;

  const ee = await import("@egma/ee");
  const loaded = await ee.loadCloudBilling();
  // The one Stripe client this process holds. The secret never leaves the
  // commercially licensed package, and nothing in the open product imports
  // `stripe` at all. It is built here rather than inside the load above
  // because the grader loads the same adapter and has no Stripe work to do:
  // it asks the two ports and serves no route, reports no hour and takes no
  // webhook.
  const stripe = ee.stripeGateway({
    secretKey: settings.stripeSecretKey ?? "",
    ...(settings.stripeWebhookSecret === undefined
      ? {}
      : { webhookSecret: settings.stripeWebhookSecret }),
    baseUrl: settings.baseUrl,
  });

  return {
    plugIn: loaded.plugIn,
    routes: (app, options) => loaded.routes(app, { ...options, stripe }),
    // **No signing secret, no door.** A webhook's signature is its only
    // credential, so an endpoint that could not check one would be an
    // endpoint anybody could post a payment to. A deployment that set a
    // Stripe key without a webhook secret still sells: the buttons work, and
    // Stripe's answers land when the secret is set.
    webhookRoutes: stripe.hasWebhookSecret
      ? (app) => ee.billingWebhookRoutes(app, { stripe })
      : undefined,
    seededPlans: loaded.seededPlans,
    startMeterJob: (log) => ee.startOverageMeterJob({ gateway: stripe, log }),
  };
}
