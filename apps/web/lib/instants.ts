/**
 * Times, as a list and a detail page show them.
 *
 * Always UTC and always written out, never "3 days ago". A relative time is
 * unreadable in evidence — two people looking at the same run a week apart
 * would read different sentences — and a list that is sorted by time needs its
 * column to sort by eye as well.
 */

/** The day something happened: what a list column has room for. */
export function asDay(instant: string): string {
  const at = Date.parse(instant);
  return Number.isNaN(at) ? instant : new Date(at).toISOString().slice(0, 10);
}

/**
 * The moment something happened, to the minute: what a detail page and a
 * version history have room for.
 *
 * Two versions written in one afternoon are told apart by the time and not by
 * the day, so history needs more than `asDay` — and still not the seconds,
 * which nobody reads and which push the column wider than the fact is worth.
 */
export function asMoment(instant: string): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;
  const [day, clock] = new Date(at).toISOString().split("T");
  return `${day} ${clock?.slice(0, 5) ?? ""} UTC`;
}
