import { upsertRateCard } from "@egma/db";
import type { FastifyBaseLogger } from "fastify";

/** Pricing retries after serving starts; retained usage waits for complete rates. */
export function startRateCardInitialization(
  log: Pick<FastifyBaseLogger, "info" | "error">,
  onUnavailable?: () => Promise<void>,
): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let backoffMilliseconds = 1_000;

  const attempt = async (): Promise<void> => {
    try {
      const result = await upsertRateCard();
      if (result.written.length > 0) {
        log.info(
          { prices: result.written },
          "Rate-card prices were written from the shipped file",
        );
      }
      return;
    } catch (cause) {
      try {
        await onUnavailable?.();
      } catch (fault) {
        log.error(
          { err: fault },
          "Pricing failure could not reach the billing adapter; initialization will retry",
        );
      }
      log.error(
        { err: cause, retryInMilliseconds: backoffMilliseconds },
        "Rate-card initialization failed; serving continues and pricing will retry",
      );
    }
    if (stopped) return;
    timer = setTimeout(() => {
      void attempt();
    }, backoffMilliseconds);
    timer.unref();
    backoffMilliseconds = Math.min(backoffMilliseconds * 2, 300_000);
  };
  void attempt();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
