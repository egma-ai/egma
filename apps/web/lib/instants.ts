/**
 * Times, as the person looking at this browser reads them.
 *
 * The API keeps RFC 3339 instants and the database keeps UTC. This module is
 * the display boundary: it changes only what is shown, using the viewer's
 * system time zone. Evidence keeps the exact instant. Freshness lists may use
 * the relative formatter below, with the exact instant kept beside it.
 */

export type InstantPrecision = "day" | "minute" | "second";

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
});

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAYS_PER_MONTH = 30.4375;
const DAYS_PER_YEAR = 365.25;

function formatterFor(
  precision: InstantPrecision,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  const key = `${precision}:${timeZone ?? "viewer"}`;
  const cached = FORMATTERS.get(key);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(precision === "day"
      ? {}
      : {
          hour: "2-digit",
          minute: "2-digit",
          ...(precision === "second" ? { second: "2-digit" } : {}),
          hourCycle: "h23",
          timeZoneName: "short",
        }),
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  FORMATTERS.set(key, formatter);
  return formatter;
}

/**
 * The boards' short absolute form, cached the same way as the ISO one above.
 *
 * `en-US` rather than `en-CA`: the month name and the comma are what make
 * "Aug 16, 2026" the date the boards draw, and the ISO formatter beside it
 * stays exactly as it was for evidence and for the elements' titles.
 */
function listFormatterFor(precision: InstantPrecision): Intl.DateTimeFormat {
  const key = `list:${precision}`;
  const cached = FORMATTERS.get(key);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(precision === "day"
      ? {}
      : {
          hour: "2-digit",
          minute: "2-digit",
          ...(precision === "second" ? { second: "2-digit" } : {}),
          hourCycle: "h23",
        }),
  });
  FORMATTERS.set(key, formatter);
  return formatter;
}

/**
 * One formatter for every visible absolute instant.
 *
 * Product callers omit `timeZone`, which lets the browser use the viewer's
 * system setting. The explicit form keeps this boundary deterministic when it
 * is checked and is also useful to any future view that names another zone.
 */
export function formatViewerInstant(
  instant: string,
  precision: InstantPrecision,
  timeZone?: string,
): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;

  const parts = formatterFor(precision, timeZone).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((one) => one.type === type)?.value ?? "";
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  if (precision === "day") return day;

  const clock = `${part("hour")}:${part("minute")}${
    precision === "second" ? `:${part("second")}` : ""
  }`;
  return `${day} ${clock} ${part("timeZoneName")}`.trimEnd();
}

/**
 * The one absolute form a list column carries: `Aug 16, 2026`.
 *
 * **A list's date column is an absolute short date, and never a relative age.**
 * The boards print `Aug 16, 2026` in every list column that holds a time
 * (`6ZJ-0`, `8TQ-0`, `8P4-0`), and the product printed two other things: an ISO
 * day on the agents list and a changing age on personas, suites, tests, runs,
 * transcripts, keys and invitations. A column of ages is a column that cannot
 * be scanned — every row says "a moment ago" until it says "2 days ago" — and
 * two rows a minute apart are indistinguishable by the time anybody reads them.
 * Relative time stays where it is a fact inside a sentence: "started just now",
 * "last received 2 min ago".
 *
 * `precision` is here because one column names a *moment* rather than a day:
 * the transcript list's leading column is the exchange's own identity and has
 * always been to the second. It keeps that precision and takes this shape, so
 * there is still one absolute form in the product rather than two.
 *
 * The exact instant is not lost. `ListInstant` keeps the RFC 3339 value on the
 * element and the viewer-local moment with its zone in the title.
 */
export function asListInstant(
  instant: string,
  precision: InstantPrecision = "day",
): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;
  return listFormatterFor(precision).format(new Date(at));
}

/** The local moment to the minute: what detail and history views need. */
export function asMoment(instant: string): string {
  return formatViewerInstant(instant, "minute");
}

/** The local moment to the second: what technical evidence needs. */
export function asSecond(instant: string): string {
  return formatViewerInstant(instant, "second");
}

/**
 * A short, changing age for a list whose first question is "how recent?".
 *
 * This is not used as evidence by itself. A caller keeps the RFC 3339 value in
 * a `time` element and the exact viewer-local moment in its title. `now` is an
 * argument so one table uses one clock and the boundary stays deterministic in
 * tests.
 */
export function relativeViewerInstant(
  instant: string,
  now = Date.now(),
): string {
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return instant;

  const difference = at - now;
  const distance = Math.abs(difference);
  if (distance < MINUTE_MS) return difference > 0 ? "in a moment" : "just now";

  if (distance < HOUR_MS) {
    return RELATIVE_FORMATTER.format(Math.round(difference / MINUTE_MS), "minute");
  }

  const localDay = (value: number): number => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
  };
  const dayDifference = localDay(at) - localDay(now);

  if (dayDifference === 0) {
    return RELATIVE_FORMATTER.format(Math.round(difference / HOUR_MS), "hour");
  }
  if (Math.abs(dayDifference) < 7) {
    return RELATIVE_FORMATTER.format(dayDifference, "day");
  }
  if (Math.abs(dayDifference) < 28) {
    return RELATIVE_FORMATTER.format(Math.round(dayDifference / 7), "week");
  }
  if (Math.abs(dayDifference) < DAYS_PER_YEAR) {
    return RELATIVE_FORMATTER.format(
      Math.round(dayDifference / DAYS_PER_MONTH),
      "month",
    );
  }
  return RELATIVE_FORMATTER.format(
    Math.round(dayDifference / DAYS_PER_YEAR),
    "year",
  );
}
