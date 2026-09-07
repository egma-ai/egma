/**
 * Shared body and query readers. given treats an empty parameter as absent,
 * so project= follows the same selection rules as an omitted project.
 */

/** A string somebody sent, trimmed, or nothing at all for anything else. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** What a caller actually said, as against a field that arrived empty. */
export function given(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** A list of strings, as a body carries one. Anything else is no list at all. */
export function textList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry)) : [];
}
