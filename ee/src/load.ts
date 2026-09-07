import type { BillingPlugIn } from "@egma/db";

import { cloudBillingPlugIn, type CloudAdapterOptions } from "./adapters.ts";
import {
  seedCloudPlans,
  sweepUnchargedUsage,
  type SweptUsage,
} from "./access/index.ts";
import { billingRoutes } from "./routes.ts";

/**
 * Loading the cloud billing adapter: the plan rows, the catch-up, the two
 * ports, and the Billing section's reads.
 *
 * **The plan rows come with the plug-in and not with one of the processes.**
 * An account names a plan code and the database holds it to a plan row, so a
 * process that installed the adapter without writing the rows would meet that
 * key the first time a customer asked a money question. Two processes install
 * this adapter — the API and the grader — and either can boot first, so the
 * seed is part of loading rather than a line in one entry point.
 *
 * **The catch-up comes with it for the same reason.** A usage sink may fail
 * without failing the write that stored the record, and a resend cannot
 * replace the lost delivery — so every stored record that carries no charge is
 * charged here, at the boot after the fault, in whichever process loads the
 * adapter first. The hourly job in the API runs it again before each meter
 * tick, which is what makes an hour the longest a charge can be late.
 *
 * It is safe to run on every boot in every process: the plan upsert writes
 * nothing where the file has not changed, exactly as the rate card's does, and
 * a charge is keyed on the usage record, so a second process sweeping at the
 * same moment writes nothing rather than charging twice.
 */
export type LoadedCloudBilling = {
  readonly plugIn: BillingPlugIn;
  /** The Billing section's routes, for the process that serves HTTP. */
  readonly routes: typeof billingRoutes;
  /** The plan codes this boot wrote. Empty when the file changed nothing. */
  readonly seededPlans: readonly string[];
  /**
   * What the boot's catch-up charged. All zeros on a deployment whose
   * deliveries all landed, which is every ordinary boot.
   */
  readonly caughtUp: SweptUsage;
};

/** Nothing found and nothing charged: what a failed sweep reports. */
const NOTHING_SWEPT: SweptUsage = { found: 0, charged: 0, amountMicros: 0 };

/**
 * Charge what the sink lost, and never fail a boot over it.
 *
 * The rule the sink stands on, one step further out: the records are durable
 * rows and the money can be collected on the next wake, so a sweep that could
 * not run is a charge that is late. A process that refused to start over it
 * would turn a billing fault into a deployment that accepts no work at all,
 * which is the worse of the two by a long way.
 *
 * Reported on standard error, because this package has no logger of its own
 * and a catch-up that silently stopped running is money nobody is collecting.
 */
async function catchUpOnLostDeliveries(): Promise<SweptUsage> {
  try {
    return await sweepUnchargedUsage();
  } catch (fault) {
    console.error(
      "the inference balance could not be caught up for the stored usage " +
        "records that carry no charge; they are stored and the next sweep " +
        "charges them",
      fault,
    );
    return NOTHING_SWEPT;
  }
}

export async function loadCloudBilling(
  options: CloudAdapterOptions = {},
): Promise<LoadedCloudBilling> {
  const seeded = await seedCloudPlans();
  // After the seed and never before it: the catch-up opens a billing account
  // for a customer nobody has asked a money question about yet, and an account
  // names a plan row that has to be there.
  const caughtUp = await catchUpOnLostDeliveries();
  return {
    plugIn: cloudBillingPlugIn(options),
    routes: billingRoutes,
    seededPlans: seeded.written,
    caughtUp,
  };
}
