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

/** What a deployment with billing got when it loaded the cloud package. */
export type CloudBilling = {
  readonly plugIn: BillingPlugIn;
  readonly routes: BillingRoutes;
  /**
   * The plan codes this boot wrote, for the log. The rows themselves come with
   * the plug-in rather than from a line here: the grader installs the same
   * adapter and either process can boot first, so whichever loads it writes
   * them and the other finds them there.
   */
  readonly seededPlans: readonly string[];
};

export async function loadCloudBilling(settings: {
  readonly stripeSecretKey: string | undefined;
}): Promise<CloudBilling | undefined> {
  if (!billingIsConfigured(settings)) return undefined;

  const ee = await import("@egma/ee");
  const loaded = await ee.loadCloudBilling();
  return {
    plugIn: loaded.plugIn,
    routes: loaded.routes,
    seededPlans: loaded.seededPlans,
  };
}
