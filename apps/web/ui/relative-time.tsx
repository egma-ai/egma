"use client";

import { useEffect, useState } from "react";

import {
  asListInstant,
  formatViewerInstant,
  relativeViewerInstant,
  type InstantPrecision,
} from "../lib/instants.ts";

/** One clock for every relative instant on a page. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

/**
 * A readable age with the exact viewer-local instant still on the element.
 *
 * `now` comes from one page clock. Keeping it outside this component avoids a
 * timer for every row in a table.
 */
export function RelativeInstant({
  instant,
  now,
  precision = "minute",
}: {
  readonly instant: string;
  readonly now: number;
  readonly precision?: InstantPrecision;
}) {
  return (
    <time
      /*
       * "Metrics, dates, durations, and scores use tabular numerals."
       * An age is a figure, and a column of them is what somebody scans: a
       * proportional face puts "2 minutes ago" and "9 minutes ago" at two
       * widths, so the eye has to read each row instead of seeing the column.
       */
      className="tabular-nums"
      dateTime={instant}
      title={formatViewerInstant(instant, precision)}
      suppressHydrationWarning
    >
      {relativeViewerInstant(instant, now)}
    </time>
  );
}

/**
 * Render a fixed list date with a machine-readable instant and an exact
 * viewer-local timestamp in the title. Unlike relative age, it needs no page clock.
 */
export function ListInstant({
  instant,
  precision = "day",
}: {
  readonly instant: string;
  readonly precision?: InstantPrecision;
}) {
  return (
    <time
      className="tabular-nums"
      dateTime={instant}
      title={formatViewerInstant(instant, precision)}
      suppressHydrationWarning
    >
      {asListInstant(instant, precision)}
    </time>
  );
}
