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
