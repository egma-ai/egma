import type { ConnectionType, Modality } from "../schema/agents.ts";

/**
 * What a month of platform usage is: the three kinds it is counted in, how
 * much of one a conversation used, and when the month turns over.
 *
 * **All of it is the product's, on every deployment.** A self-hoster counts
 * the same three numbers against no limit at all; a plan that turns one of
 * them into a limit is the cloud's business and lives behind the entitlement
 * source. Nothing in this file knows what a plan is, and nothing in it reaches
 * a store: a simulation row goes in, a quantity comes out.
 *
 * **One definition each, deliberately.** The month's boundary, what a minute
 * means and which allowance a conversation belongs to are each written once
 * here, because a second copy of any of them is a second answer to "how much
 * have I used", and the two would be found disagreeing by a customer rather
 * than by a test.
 */

/**
 * The three kinds of platform work a plan gives an allowance of.
 *
 * They are the glossary's words and the plan's words: chat simulations,
 * web-call minutes, phone minutes. Chat is counted in conversations because
 * its cost is inference and the inference balance pays for that; the two voice
 * kinds are counted in minutes because their cost is time on a channel, and
 * they are two kinds rather than one because a carrier charges for a phone
 * minute and nobody charges for a web-call minute.
 */
export const ALLOWANCE_KINDS = [
  "chat_simulations",
  "web_call_minutes",
  "phone_minutes",
] as const;

export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number];

/** The unit one allowance is counted in, for anything that has to say so. */
export const ALLOWANCE_UNITS = {
  chat_simulations: "simulations",
  web_call_minutes: "minutes",
  phone_minutes: "minutes",
} as const satisfies Readonly<Record<AllowanceKind, string>>;

/**
 * Which allowance one conversation is counted against.
 *
 * The whole rule, and it reads off two frozen facts of the simulation row:
 *
 * - A chat is a chat simulation, whichever chat lane carried it.
 * - A voice conversation over a phone number is phone minutes, because a
 *   carrier is charging Egma for the leg.
 * - Every other voice lane — a Retell web call, a LiveKit room — is web-call
 *   minutes, because nobody is.
 *
 * The modality is asked first, so a lane that gains a chat variant later
 * cannot quietly start counting as minutes.
 */
export function allowanceKindOf(simulation: {
  readonly modality: Modality;
  readonly connectionType: ConnectionType;
}): AllowanceKind {
  if (simulation.modality === "chat") return "chat_simulations";
  return simulation.connectionType === "phone_number"
    ? "phone_minutes"
    : "web_call_minutes";
}

/**
 * The smallest a conversation can be counted as, in seconds.
 *
 * A two-second simulation still opened a channel, dialed or joined a room, and
 * ran a persona's first turn, so it is not free; ten seconds is what the
 * founders set as the floor. It is a floor per simulation and never a rounding
 * unit — a forty-second conversation counts forty seconds, not sixty.
 */
export const SHORTEST_BILLABLE_SECONDS = 10;

/** Seconds in one minute, so no arithmetic below writes `60` by hand. */
const SECONDS_IN_A_MINUTE = 60;

/**
 * How many seconds one conversation is counted as.
 *
 * **Persona-connected time, from execution start to execution end**, which is
 * exactly the span the simulation row already stamps: the simulator writes
 * `started_at` when it begins conducting and `execution_ended_at` when it stops. A
 * simulation the agent never answered needs no special case, because that span
 * already covers the wait — the platform bounds it at thirty seconds for a
 * room and sixty for a ring, so a misconfigured connection costs seconds and
 * is visibly the customer's to fix.
 *
 * **Counted per second and rounded up.** A part of a second is a second the
 * providers were speaking, and the alternative — rounding to the nearest
 * minute, as a carrier does — is the thing the founders decided against, so
 * the rounding goes the only way that never charges for time nobody used.
 *
 * **A conversation with no span counts nothing.** One that never began, or one
 * still running, has no measured time yet; that is zero rather than the
 * minimum, because the minimum is the floor under a conversation that
 * happened, not a fee for asking.
 *
 * A reversed span — an end before its start, which is a clock going backwards
 * rather than a conversation that did not happen — counts the minimum.
 */
export function billableSecondsOf(simulation: {
  readonly startedAt: Date | null;
  readonly executionEndedAt: Date | null;
}): number {
  const { startedAt, executionEndedAt } = simulation;
  if (startedAt === null || executionEndedAt === null) return 0;
  const elapsed = Math.max(
    0,
    (executionEndedAt.getTime() - startedAt.getTime()) / 1_000,
  );
  return Math.max(SHORTEST_BILLABLE_SECONDS, Math.ceil(elapsed));
}

/**
 * The same seconds as minutes, which is the unit the two voice allowances are
 * published in. Summed first and divided once: dividing each conversation and
 * adding the parts would round the floor into every one of them.
 */
export function minutesFromSeconds(seconds: number): number {
  return seconds / SECONDS_IN_A_MINUTE;
}

/**
 * How much of one allowance one conversation used, in that allowance's own
 * unit. A chat counts as one at the moment it starts; a voice conversation
 * counts its minutes.
 *
 * It is here rather than at the two call sites so that the aggregate a page
 * shows and the arithmetic a test does are the same sentence.
 */
export function allowanceUsedBy(simulation: {
  readonly modality: Modality;
  readonly connectionType: ConnectionType;
  readonly startedAt: Date | null;
  readonly executionEndedAt: Date | null;
}): { readonly kind: AllowanceKind; readonly used: number } {
  const kind = allowanceKindOf(simulation);
  if (kind === "chat_simulations") {
    return { kind, used: simulation.startedAt === null ? 0 : 1 };
  }
  return { kind, used: minutesFromSeconds(billableSecondsOf(simulation)) };
}

/**
 * Which allowances a set of conversations would be counted against, in the
 * order the three kinds are declared in.
 *
 * The claim path's own question, and it is asked of rows the caller already
 * holds rather than of the database: a batch of claims carries each
 * conversation's frozen modality and lane, and what the entitlement source is
 * asked once per organization is the set of kinds among them. Ordered and
 * de-duplicated here so that two callers asking the same question ask it with
 * the same list.
 */
export function allowanceKindsAmong(
  simulations: readonly {
    readonly modality: Modality;
    readonly connectionType: ConnectionType;
  }[],
): readonly AllowanceKind[] {
  const kinds = new Set(simulations.map((one) => allowanceKindOf(one)));
  return ALLOWANCE_KINDS.filter((kind) => kinds.has(kind));
}

/** One month of allowance: when it began, and the instant it resets. */
export type AllowancePeriod = {
  readonly startedAt: Date;
  /** The next reset. Exclusive: a conversation at this instant is next month's. */
  readonly resetsAt: Date;
};

/**
 * The period one instant falls in, counted from an organization's own anchor.
 *
 * **The rule, written once and nowhere else.** An allowance period is one
 * calendar month long and begins on the anchor's own day of the month, at the
 * anchor's own time of day, read in UTC. The anchor is the organization's
 * creation instant on Hobby and Stripe's subscription anchor on Pro, so a
 * customer's reset date is theirs and needs no Stripe object to exist.
 *
 * **A short month clamps and never drifts.** An organization created on the
 * 31st resets on the 28th of February and on the 31st of March — the clamp
 * applies to the month being computed and never moves the anchor, so one short
 * February cannot walk a customer's date backwards for the rest of their life.
 *
 * **UTC, not a local midnight.** Egma stores every moment with its zone, and a
 * reset that meant local midnight would move for a customer who travelled and
 * for a deployment whose server was moved. The reset is a fixed instant.
 *
 * An instant before the anchor — a clock skew, or a fixture asking about a
 * moment before its organization existed — answers the first period, because
 * there is no earlier month for an organization that did not exist.
 */
export function allowancePeriodAt(anchor: Date, at: Date): AllowancePeriod {
  if (at.getTime() < anchor.getTime()) {
    return { startedAt: anchor, resetsAt: monthsAfter(anchor, 1) };
  }
  const whole =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (at.getUTCMonth() - anchor.getUTCMonth());
  // The month arithmetic above counts calendar months and knows nothing about
  // the day or the time of day, so the boundary it lands on can still be later
  // than the instant asked about — the 3rd of a month, for an anchor on the
  // 20th. One step back is always enough, because two consecutive boundaries
  // are one month apart and `at` is between them by construction.
  const elapsed = monthsAfter(anchor, whole).getTime() > at.getTime()
    ? whole - 1
    : whole;
  return {
    startedAt: monthsAfter(anchor, elapsed),
    resetsAt: monthsAfter(anchor, elapsed + 1),
  };
}

/**
 * The anchor moved on by whole months, its day clamped into the month it lands
 * in. `Date.UTC` would roll a 31st into the 1st of the next month, which is
 * the drift the rule above forbids, so the day is chosen before the date is
 * built rather than corrected after.
 */
function monthsAfter(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  // `Date.UTC` normalises a month outside 0-11 into the right year for us; the
  // day is the part it must not be trusted with.
  const landing = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(
    Date.UTC(landing.getUTCFullYear(), landing.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      landing.getUTCFullYear(),
      landing.getUTCMonth(),
      Math.min(anchor.getUTCDate(), daysInMonth),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}
