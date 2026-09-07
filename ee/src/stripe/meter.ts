import Stripe from "stripe";

import {
  markOverageReported,
  overageOwedThrough,
  type OrganizationOverage,
  type OverageMark,
} from "../access/index.ts";
import { meterEventIdentifier } from "../idempotency.ts";
import { previousHour, type MeteredHour } from "./facts.ts";
import type { StripeGateway } from "./gateway.ts";

/**
 * The hourly job that tells Stripe what a Pro month has used.
 *
 * **Counted from Egma's own rows, once an hour, and never on a request.** The
 * allowances are enforced from Postgres; this job only reports what a period
 * has used so Stripe can price the tiers and put the overage line on the
 * invoice. Nothing a customer does waits for it, and a Stripe that is
 * unreachable delays a bill and stops no work (ADR-0024).
 *
 * **Every hour is reported, including the ones a wake missed.** The minutes an
 * hour owes are the difference between the whole minutes its period had at the
 * end of the hour and at the start of it — which is what carries a part-minute
 * forward, and equally what would swallow an hour that was never posted. So
 * each account remembers the last hour Stripe took, this job reports every
 * completed hour after it in order, and the mark moves only once Stripe has
 * taken an hour or refused it as one it already has.
 *
 * **A replayed hour is refused by Stripe rather than counted twice.** The
 * identifier on every event is the meter, the organization and the hour, so a
 * second attempt at an hour Stripe already has is a 400 that says exactly
 * that. It is swallowed and counted, and the mark advances past it — that
 * refusal is Stripe saying the fact is already recorded, which is the outcome
 * the job wanted.
 *
 * **A failure stops that organization's catch-up and nobody else's.** The hour
 * that failed keeps the mark where it is, so the next wake begins there again.
 */

/** The two meter event names, which are also how the meters are found. */
export const METER_EVENT_NAMES = {
  web_call_minutes: "egma_web_call_minutes",
  phone_minutes: "egma_phone_minutes",
} as const;

/** What one run of the job did. */
export type MeterReport = {
  /** The last hour that had closed when this run began. */
  readonly latestClosedHour: MeteredHour;
  /** How many paying Pro organizations the run had to report for. */
  readonly organizations: number;
  /** How many organization-hours it tried. More than one each is a catch-up. */
  readonly hours: number;
  /** How many meter events Stripe accepted. */
  readonly posted: number;
  /** How many Stripe already had under the same identifier. */
  readonly alreadyReported: number;
  /** How many could not be posted at all. Each one is in the log. */
  readonly failed: number;
  /**
   * How many hours were older than Stripe's own 35-day window.
   *
   * Nobody can bill them: Stripe refuses a meter event timestamped further
   * back than that. They are marked as reported rather than retried for ever,
   * and counted here so an outage that lost money says so out loud.
   */
  readonly tooOld: number;
};

/** Where this job says what it did. The API hands it its own logger. */
export type MeterLog = {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
};

const QUIET: MeterLog = { info: () => {}, error: () => {}, warn: () => {} };

/**
 * Whether this is Stripe refusing an identifier it already has.
 *
 * **Stripe's own error class first.** A duplicate identifier comes back as an
 * `invalid_request_error`, which is the same class as a malformed request — so
 * the class alone cannot tell them apart, and the identifier being named in
 * the message is the only thing that does. Narrowing on the class before
 * reading the message is what keeps a network fault or a rate limit from ever
 * reaching that reading.
 */
function isAlreadyReported(fault: unknown): boolean {
  if (!(fault instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  const said = fault.message;
  return said.includes("identifier") && said.includes("already");
}

/** What posting one organization's hour came to. */
type Posted = {
  readonly posted: number;
  readonly alreadyReported: number;
  readonly failed: number;
};

/**
 * Post one organization's two meter events for one hour.
 *
 * Both are posted even when the value is zero, so an hour with no event means
 * the job did not run rather than that nothing happened.
 */
async function postOneHour(
  gateway: StripeGateway,
  overage: OrganizationOverage,
  log: MeterLog,
): Promise<Posted> {
  let posted = 0;
  let alreadyReported = 0;
  let failed = 0;
  const minutes = {
    [METER_EVENT_NAMES.web_call_minutes]: overage.webCallMinutes,
    [METER_EVENT_NAMES.phone_minutes]: overage.phoneMinutes,
  };

  for (const [eventName, value] of Object.entries(minutes)) {
    const identifier = meterEventIdentifier(
      eventName,
      overage.organizationId,
      overage.hour.startedAt,
    );
    try {
      await gateway.api.billing.meterEvents.create(
        {
          event_name: eventName,
          identifier,
          // Seconds since the epoch, at the top of the hour: what puts the
          // usage in the billing period Stripe should charge it to.
          timestamp: Math.floor(overage.hour.startedAt.getTime() / 1_000),
          payload: {
            stripe_customer_id: overage.stripeCustomerId,
            // A whole number. Stripe's meter events take whole values, and
            // the part-minute an hour leaves behind is carried into the next
            // hour by the arithmetic that produced this one.
            value: String(value),
          },
        },
        // The same string twice over: Stripe's own uniqueness on the
        // identifier is what makes a replayed hour a refusal, and the request
        // key makes a retried HTTP attempt one write.
        { idempotencyKey: identifier },
      );
      posted += 1;
    } catch (fault) {
      if (isAlreadyReported(fault)) {
        alreadyReported += 1;
        continue;
      }
      failed += 1;
      log.error(
        { err: fault, identifier, organizationId: overage.organizationId },
        "an hour of Pro usage could not be reported to Stripe",
      );
    }
  }
  return { posted, alreadyReported, failed };
}

/**
 * Report every hour each paying Pro organization still owes, up to the last
 * one that has closed.
 *
 * Exported so a test, a Stripe-lane run and the hourly timer all report the
 * same way.
 */
export async function reportOverageOwed(
  gateway: StripeGateway,
  latestClosedHour: MeteredHour,
  log: MeterLog = QUIET,
  at: Date = new Date(),
): Promise<MeterReport> {
  const owed = await overageOwedThrough(latestClosedHour, at);
  const organizations = new Set(owed.map((one) => one.organizationId));

  let posted = 0;
  let alreadyReported = 0;
  let failed = 0;
  let tooOld = 0;
  // The last hour each organization got through. A failure stops that
  // organization's catch-up where it stands, so the mark it takes away is the
  // last hour Stripe actually has.
  const reached = new Map<string, Date>();
  const stopped = new Set<string>();

  for (const hour of owed) {
    if (stopped.has(hour.organizationId)) continue;

    if (hour.tooOldForStripe) {
      // Stripe will not take a meter event this far back, so retrying it every
      // hour for ever would be the only alternative to passing over it. It is
      // counted and said out loud rather than hidden.
      tooOld += 1;
      log.warn(
        {
          organizationId: hour.organizationId,
          hour: hour.hour.startedAt.toISOString(),
        },
        "an hour of Pro usage is older than Stripe's meter window and can no " +
          "longer be reported",
      );
      reached.set(hour.organizationId, hour.hour.startedAt);
      continue;
    }

    const counted = await postOneHour(gateway, hour, log);
    posted += counted.posted;
    alreadyReported += counted.alreadyReported;
    failed += counted.failed;
    if (counted.failed > 0) {
      // Neither event is retried inside this wake, and the mark stays behind
      // this hour, so the next wake begins here again. The identifier makes
      // the half that did get through a refusal rather than a second charge.
      stopped.add(hour.organizationId);
      continue;
    }
    reached.set(hour.organizationId, hour.hour.startedAt);
  }

  const marks: OverageMark[] = [...reached].map(
    ([organizationId, reportedThrough]) => ({ organizationId, reportedThrough }),
  );
  if (marks.length > 0) await markOverageReported(marks);

  return {
    latestClosedHour,
    organizations: organizations.size,
    hours: owed.length,
    posted,
    alreadyReported,
    failed,
    tooOld,
  };
}

export type OverageMeterJob = {
  /** Stop the timer. What a shutting-down process calls. */
  stop(): void;
};

export type OverageMeterJobOptions = {
  readonly gateway: StripeGateway;
  readonly log?: MeterLog;
  /** The clock, so a test can stand at the top of an hour. */
  readonly now?: () => Date;
};

/** How often the timer wakes: once an hour, on the hour. */
const AN_HOUR = 3_600_000;

/**
 * Start the hourly job.
 *
 * **Once at boot, then on the hour.** The boot run is what makes a deployment
 * that was down report the hours it missed; the mark on each account is what
 * says which those are. The first timer is aligned to the top of the next hour
 * rather than to an hour after boot, so every instance reports the same hour at
 * about the same time and an hour is never split across two windows.
 *
 * **A failure never stops the timer.** An hour that could not be reported is
 * logged and its mark is left where it was, so the next wake begins there
 * again — which is the whole reason the mark exists.
 */
export function startOverageMeterJob(
  options: OverageMeterJobOptions,
): OverageMeterJob {
  const log = options.log ?? QUIET;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runFor = (at: Date): void => {
    void reportOverageOwed(options.gateway, previousHour(at), log, at)
      .then((report) => {
        if (report.organizations === 0) return;
        log.info(
          {
            latestClosedHour: report.latestClosedHour.startedAt.toISOString(),
            organizations: report.organizations,
            hours: report.hours,
            posted: report.posted,
            alreadyReported: report.alreadyReported,
            failed: report.failed,
            tooOld: report.tooOld,
          },
          "Pro usage was reported to Stripe",
        );
      })
      .catch((fault: unknown) => {
        log.error(
          { err: fault },
          "the hourly Stripe meter job could not read the hours it owes",
        );
      });
  };

  const wakeOnTheHour = (): void => {
    if (stopped) return;
    const at = now();
    const untilTheHour = AN_HOUR - (at.getTime() % AN_HOUR);
    timer = setTimeout(() => {
      if (stopped) return;
      runFor(now());
      wakeOnTheHour();
    }, untilTheHour);
    // Unref'd, so a timer waiting for the top of the hour never keeps a
    // process from exiting.
    timer.unref();
  };

  runFor(now());
  wakeOnTheHour();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
