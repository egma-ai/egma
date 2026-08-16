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

/**
 * Which project a request named, wherever the caller put it — **the one
 * spelling of this rule in the API**.
 *
 * **The query and the body, because both are in honest use.** A terminal posts
 * the project in the body beside everything else it is sending; a browser's
 * write helper appends it to the address, which is where every read is asked.
 * A door that took only one of the two would not refuse the other — it would
 * **ignore** it, fall back to the credential's own project, which for a session
 * is the organization's *first*, and answer confidently about somebody else's
 * product area. That is not a hypothetical: `POST /api/agents` did exactly it,
 * and answered `201` about an agent in the wrong project.
 *
 * **The address wins where both are given**, because the address is what a
 * browser is looking at.
 *
 * It lives here rather than in each route group because three groups had
 * written it for themselves, two of them character for character under one
 * name that a third group used for something else entirely. One rule about
 * where a project is named, spelled once.
 */
export function projectNamed(
  query: Record<string, unknown>,
  body: Record<string, unknown>,
): string | undefined {
  return given(text(query.project)) ?? given(text(body.project));
}
