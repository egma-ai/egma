import {
  billingIsConfigured,
  type AuthContext,
  type BillingPlugIn,
} from "@egma/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Load the optional adapter only with a Stripe key. Billing faults allow boot. */

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
   * Eligible usage collected from the cumulative snapshot during boot.
   *
   * Zero on every ordinary boot. Anything else is a delivery that was lost
   * before this process started, collected late, and worth a line in the log
   * for exactly that reason.
   */
  readonly caughtUp: {
    readonly charged: number;
    readonly amountMicros: number;
  };
  /**
   * The hourly job that reports each Pro organization's minutes to Stripe.
   *
   * Started once this process is serving, because it is neither a gate on
   * serving nor something a request waits for: a Stripe that is unreachable
   * delays a bill and stops no work.
   */
  startMeterJob(log: BillingLog): StoppableJob;
};

export type CloudBillingSettings = {
  readonly stripeSecretKey: string | undefined;
  readonly stripeWebhookSecret?: string | undefined;
  readonly baseUrl: string;
};

type BillingModule = {
  loadApiBilling(settings: CloudBillingSettings): Promise<CloudBilling>;
};

export async function loadCloudBilling(
  settings: CloudBillingSettings,
): Promise<CloudBilling | undefined> {
  if (!billingIsConfigured(settings)) return undefined;

  // Resolve the optional package only at runtime, after billing is selected.
  try {
    const packageName: string = "@egma/ee";
    const billing: BillingModule = await import(packageName);
    return await billing.loadApiBilling(settings);
  } catch (fault) {
    console.error("Billing could not load; customer work continues", fault);
    return undefined;
  }
}
