/**
 * Compare authored JSON by value: sort object keys and preserve array order.
 * Database key reordering must not make unchanged mock answers or env look edited.
 */

/** The same value with every object's keys in one order, top to bottom. */
export function jsonInOneOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonInOneOrder);
  if (typeof value !== "object" || value === null) return value;

  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, jsonInOneOrder(record[key])]),
  );
}

/** Whether two JSON values say the same thing, in whatever order they say it. */
export function sameJsonValue(first: unknown, second: unknown): boolean {
  return (
    JSON.stringify(jsonInOneOrder(first)) === JSON.stringify(jsonInOneOrder(second))
  );
}
