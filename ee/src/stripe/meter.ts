import {
  MOST_HOURS_CAUGHT_UP_AT_ONCE,
  visitMeterAccounts,
} from "../access/index.ts";
import { previousHour, type MeteredHour } from "./facts.ts";
import { refreshStripePaymentsReady, type StripeGateway } from "./gateway.ts";
import { currentStripeCustomer, stripeMeterPeriods } from "./periods.ts";

export const METER_EVENT_NAMES = {
  web_call_minutes: "egma_web_call_minutes",
  phone_minutes: "egma_phone_minutes",
} as const;
export type MeterLog = {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
};
const QUIET: MeterLog = { info: () => {}, error: () => {}, warn: () => {} };
export type MeterReport = {
  readonly latestClosedHour: MeteredHour;
  readonly organizations: number;
  readonly hours: number;
  readonly posted: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly needsAttention: number;
  readonly unresolved: number;
};
const HOUR = 3_600_000;
// Stop before Stripe's minimum duplicate window, allowing clock/request latency.
export const SAFE_METER_RETRY_MILLISECONDS = 23 * HOUR;

/** Report each period independently; customer work never waits for this job. */
export async function reportOverageOwed(
  gateway: StripeGateway,
  latestClosedHour: MeteredHour,
  log: MeterLog = QUIET,
  at: Date = new Date(),
): Promise<MeterReport> {
  const report = {
    latestClosedHour,
    organizations: 0,
    hours: 0,
    posted: 0,
    failed: 0,
    uncertain: 0,
    needsAttention: 0,
    unresolved: 0,
  };
  await visitMeterAccounts(
    async (account, progress) => {
      const version = await progress.failureVersion();
      await progress.reconcile(
        (customerId, needsHobbyTransition) =>
          currentStripeCustomer(gateway, customerId, at, needsHobbyTransition),
        at,
      );
      const periods = await stripeMeterPeriods(
        gateway,
        account,
        at,
        await progress.periods(),
      );
      report.organizations += 1;
      let needsRecovery = false;
      const stoppedChannels = new Set<string>();
      for (const period of periods) {
        if (stoppedChannels.has(period.channel)) continue;
        for (let count = 0; count < MOST_HOURS_CAUGHT_UP_AT_ONCE; count += 1) {
          const next = await progress.next(period, latestClosedHour, at);
          if (next.kind === "idle") break;
          report.hours += 1;
          if (next.kind === "advanced") continue;
          if (next.kind === "attention") {
            report.needsAttention += 1;
            needsRecovery = true;
            log.error(
              { organizationId: account.organizationId, period, ...next },
              "known usage needs a billing decision because its original invoice cannot accept it",
            );
            break;
          }
          const pending = next.report;
          if (
            at.getTime() - pending.firstSentAt.getTime() >=
            SAFE_METER_RETRY_MILLISECONDS
          ) {
            await progress.finish(pending, "uncertain", at);
            report.uncertain += 1;
            needsRecovery = true;
            log.error(
              {
                organizationId: account.organizationId,
                identifier: pending.identifier,
                seconds: pending.seconds,
              },
              "Stripe acceptance is unknown after the retry window; this quantity will not be sent twice",
            );
            continue;
          }
          if (!period.acceptingUsage) {
            report.needsAttention += 1;
            needsRecovery = true;
            stoppedChannels.add(period.channel);
            log.error(
              {
                organizationId: account.organizationId,
                identifier: pending.identifier,
                period,
              },
              "the original invoice closed while this meter send was unresolved; the pending quantity is retained",
            );
            break;
          }
          try {
            await gateway.api.billing.meterEvents.create(
              {
                event_name: period.eventName,
                identifier: pending.identifier,
                timestamp: Math.floor(pending.timestamp.getTime() / 1_000),
                payload: {
                  stripe_customer_id: account.stripeCustomerId,
                  value: pending.value,
                },
              },
              { idempotencyKey: pending.identifier },
            );
            await progress.finish(pending, "accepted", at);
            report.posted += 1;
          } catch (fault) {
            report.failed += 1;
            needsRecovery = true;
            stoppedChannels.add(period.channel);
            log.error(
              {
                err: fault,
                organizationId: account.organizationId,
                identifier: pending.identifier,
              },
              "Stripe usage remains pending for an identical retry",
            );
            break;
          }
        }
      }
      if (needsRecovery) await progress.failed();
      else if (!(await progress.recovered(version, latestClosedHour, at))) report.unresolved += 1;
    },
    (account, fault) => {
      report.failed += 1;
      log.error(
        { err: fault, organizationId: account.organizationId },
        "Stripe reporting could not read this account",
      );
    },
  );
  return report;
}

export type OverageMeterJob = { stop(): void };
export type OverageMeterJobOptions = {
  readonly gateway: StripeGateway;
  readonly log?: MeterLog;
  readonly now?: () => Date;
};
export function startOverageMeterJob(
  options: OverageMeterJobOptions,
): OverageMeterJob {
  const log = options.log ?? QUIET;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = async (): Promise<void> => {
    const at = now();
    try {
      if (await refreshStripePaymentsReady(options.gateway)) {
        const report = await reportOverageOwed(
          options.gateway,
          previousHour(at),
          log,
          at,
        );
        if (report.organizations > 0)
          log.info({ ...report }, "hourly Stripe reconciliation finished");
      }
    } catch (err) {
      log.error({ err }, "hourly Stripe usage reporting failed");
    }
    if (stopped) return;
    timer = setTimeout(
      () => {
        void wake();
      },
      HOUR - (now().getTime() % HOUR),
    );
    timer.unref();
  };
  void wake();
  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
