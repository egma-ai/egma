import {
  activateBilling,
  seedCloudPlans,
  settleInference,
  markInferenceSettlementFailed,
} from "./access/index.ts";
import { readPlanCatalog } from "./plans.ts";

export type SettlementLog = {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

/** Retry initialization and settlement independently from Stripe's meter job. */
export function startInferenceSettlementJob(log: SettlementLog): {
  stop(): void;
} {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let plansInitialized = false;
  let intervalMs = 300_000;
  const tick = async (): Promise<void> => {
    try {
      // The shipped file configures this process once. Retry failed startup
      // writes, but do not rewrite plan rows during every settlement interval.
      if (!plansInitialized) {
        const catalog = await readPlanCatalog();
        await seedCloudPlans(catalog);
        intervalMs = catalog.chargingIntervalSeconds * 1000;
        plansInitialized = true;
      }
      await activateBilling();
      const settled = await settleInference();
      if (settled.charged > 0)
        log.info({ ...settled }, "Inference usage settled");
    } catch (fault) {
      await markInferenceSettlementFailed();
      log.error(
        { err: fault },
        "Inference settlement failed; customer work continues",
      );
    }
    if (!stopped) {
      timer = setTimeout(
        () => {
          void tick();
        },
        intervalMs - (Date.now() % intervalMs),
      );
      timer.unref();
    }
  };
  void tick();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
