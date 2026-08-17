"use client";

import { useEffect, useState } from "react";

import {
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
      dateTime={instant}
      title={formatViewerInstant(instant, precision)}
      suppressHydrationWarning
    >
      {relativeViewerInstant(instant, now)}
    </time>
  );
}
