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

/** The local day something happened: what a list column has room for. */
export function asDay(instant: string): string {
  return formatViewerInstant(instant, "day");
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
