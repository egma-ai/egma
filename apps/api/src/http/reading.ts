/**
 * Reading what a request said, for the routes that read JSON bodies and query
 * strings.
 *
 * Three lines of code that every route would otherwise write for itself, and
 * would eventually write differently. The one that matters is `given`: **a
 * parameter that arrived empty is a parameter nobody set.** `?project=` is what
 * a form submits for a field left blank, and reading it as a name would answer
 * about a project that cannot exist. Every route that treats absence as a
 * meaningful case has to agree about what absence is.
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
