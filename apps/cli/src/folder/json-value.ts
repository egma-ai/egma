/**
 * JSON the way the folder compares it: by value, never by object-key order.
 *
 * Two places in a test file hold arbitrary JSON a person authored — what a mock
 * tool answers with, and the world the test is conducted in — and both are
 * compared against what the platform answered. PostgreSQL can hand back the
 * keys of a stored object in a different order from the file that wrote them,
 * so a comparison on the bytes would call an unchanged test changed and a pull
 * would keep a draft nobody had drafted.
 *
 * Object-key order is not part of a JSON value, so it is sorted away. Array
 * order *is* part of the value, so it is kept.
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
