import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";

import { simulation } from "../schema/runs.ts";
import {
  SHORTEST_BILLABLE_SECONDS,
  allowancePeriodAt,
  minutesFromSeconds,
  type AllowanceKind,
  type AllowancePeriod,
} from "./allowance.ts";

/**
 * A month of platform usage, as one query.
 *
 * **The arithmetic in `allowance.ts`, written in SQL exactly once.** A month's
 * usage is an aggregate over rows a customer can have thousands of, so it is
 * summed by the database rather than folded in this process. Two callers ask
 * for it — the organization settings page's read, and the cloud adapter
 * deciding whether an allowance is spent — and they must never be able to
 * disagree, because a customer would find the disagreement before a test did.
 * So the expressions live here, once, and both build their query from them.
 *
 * Nothing here reaches a store: it hands back predicates and expressions.
 * Whoever runs them supplies the tenancy — an `AuthContext`'s organization on
 * the product read, an organization id on the adapter's — and the connection.
 */

/** How much of each allowance one period used, and when that period turns over. */
export type PeriodUsage = {
  /** The first instant of the period. */
  readonly startedAt: Date;
  /** The next reset. Exclusive: work begun at this instant is next month's. */
  readonly resetsAt: Date;
  /**
   * The quantity used of each allowance, in that allowance's own unit —
   * conversations for chat, minutes for the two voice kinds.
   *
   * Every kind is present, at zero where nothing was used, so a page renders
   * three facts rather than however many happen to be non-zero.
   */
  readonly used: Readonly<Record<AllowanceKind, number>>;
};

/** The three totals, as Postgres hands them back: `count` and `sum` are text. */
export type AllowanceTotals = {
  readonly chatSimulations: string;
  readonly phoneSeconds: string;
  readonly webCallSeconds: string;
};

/**
 * The counted seconds of one voice conversation, exactly as `billableSecondsOf`
 * counts them: the floor under the elapsed seconds, rounded up, and nothing at
 * all for a conversation that has not both begun and ended. `greatest` covers
 * the reversed span for the same reason the pure function's `Math.max` does.
 * The floor is read from the constant rather than typed again.
 */
const countedSeconds = sql`sum(
  case when ${simulation.executionEndedAt} is null then 0
  else greatest(
    ${SHORTEST_BILLABLE_SECONDS},
    ceil(extract(epoch from (${simulation.executionEndedAt} - ${simulation.startedAt})))
  ) end
)`;

const voice = sql`${simulation.modality} <> 'chat'`;
const onAPhone = sql`${simulation.connectionType} = 'phone_number'`;

/** The two voice totals, in seconds. Both allowances and overage read these. */
export type VoiceSeconds = {
  readonly phoneSeconds: SQL<string>;
  readonly webCallSeconds: SQL<string>;
};

/**
 * What a caller selects to get the counted seconds of each voice kind.
 *
 * Split out of the three totals below because the overage a Pro organization
 * owes is these two and nothing else — chat is unlimited on Pro and is never
 * metered — and a second copy of the arithmetic would be a second answer to
 * "how many minutes was that", found by a customer comparing an invoice line
 * with the number on their own settings page.
 *
 * **The narrower goes inside the aggregate rather than into the `where`**, so
 * one query can select the same seconds over two different time bounds. The
 * hourly meter job needs exactly that: what a period owes up to the end of
 * this hour, and what it owed up to the start of it.
 */
export function voiceSecondsSelection(narrower?: SQL): VoiceSeconds {
  const also = narrower === undefined ? sql`true` : sql`(${narrower})`;
  return {
    phoneSeconds: sql<string>`coalesce(
      ${countedSeconds} filter (where ${voice} and ${onAPhone} and ${also}), 0
    )`,
    webCallSeconds: sql<string>`coalesce(
      ${countedSeconds} filter (where ${voice} and not ${onAPhone} and ${also}), 0
    )`,
  };
}

/** What a caller selects to get one period's three totals. */
export function allowanceTotalsSelection(): {
  readonly chatSimulations: SQL<string>;
  readonly phoneSeconds: SQL<string>;
  readonly webCallSeconds: SQL<string>;
} {
  return {
    chatSimulations: sql<string>`count(*) filter (
      where ${simulation.modality} = 'chat'
    )`,
    ...voiceSecondsSelection(),
  };
}

/**
 * Which conversations belong to the period, by when they began.
 *
 * A conversation queued in one month and begun in the next belongs to the
 * month it ran in, which is the only reading that never counts one twice.
 */
export function begunInThePeriod(period: AllowancePeriod, countingFloor?: Date): SQL {
  const clause = and(
    gte(simulation.startedAt, new Date(Math.max(period.startedAt.getTime(), countingFloor?.getTime() ?? -Infinity))),
    lt(simulation.startedAt, period.resetsAt),
  );
  if (clause === undefined) throw new Error("a period predicate is never empty");
  return clause;
}

/** One organization's own conversations in that period, tenancy included. */
export function organizationInThePeriod(
  organizationId: string,
  period: AllowancePeriod,
  countingFloor?: Date,
): SQL {
  const clause = and(
    eq(simulation.organizationId, organizationId),
    begunInThePeriod(period, countingFloor),
  );
  if (clause === undefined) throw new Error("a period predicate is never empty");
  return clause;
}

/** The totals as the three published quantities. */
export function periodUsageFrom(
  period: AllowancePeriod,
  totals: Partial<AllowanceTotals> | undefined,
): PeriodUsage {
  return {
    startedAt: period.startedAt,
    resetsAt: period.resetsAt,
    used: {
      chat_simulations: Number(totals?.chatSimulations ?? 0),
      phone_minutes: minutesFromSeconds(Number(totals?.phoneSeconds ?? 0)),
      web_call_minutes: minutesFromSeconds(Number(totals?.webCallSeconds ?? 0)),
    },
  };
}

/** The period one instant falls in, for an organization's own anchor. */
export function periodAt(anchor: Date, at: Date): AllowancePeriod {
  return allowancePeriodAt(anchor, at);
}
