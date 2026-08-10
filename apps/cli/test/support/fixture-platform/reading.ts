/**
 * Reading what a request said, and the two constants every group of this
 * fixture has to agree about.
 *
 * Three lines of code each group would otherwise write for itself, and would
 * eventually write differently — which is exactly what happened: one half
 * trimmed a query parameter and the other did not, so `?project=%20` named a
 * project on one route and named nothing on the next.
 *
 * The rule that matters is `given`: **a parameter that arrived empty is a
 * parameter nobody set.** `?project=` is what a form submits for a field left
 * blank, and reading it as a name would answer about a project that cannot
 * exist. It does not trim, because the API does not: a body field is trimmed by
 * `text` before `given` sees it, and a query parameter is read as it arrived.
 * Every route that treats absence as a meaningful case has to agree about what
 * absence is.
 */

// The platform's own identifier reader, reached by path rather than by package
// name. `@egma/ids` is a name only the test runner knows how to resolve, and the
// smoke checks run this fixture under plain node, where a name nothing has
// installed is a name that does not exist.
export { isId, newId } from "../../../../../packages/ids/src/index.ts";

/**
 * How many rows one page holds, matching the data-access layer's default.
 *
 * Written down once because it is a number a client can see: a list is followed
 * by its cursor and by nothing else, so where the first page ends is part of
 * what this fixture promises.
 */
export const PAGE_SIZE = 50;

/** A string somebody sent, trimmed, or nothing at all for anything else. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * What a caller actually said, as against a field that arrived empty.
 *
 * `null` is here as well as `undefined` because that is what a query string
 * answers for a parameter nobody sent.
 */
export function given(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}

/** A list of strings, as a body carries one. Anything else is no list at all. */
export function textList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((entry) => text(entry)) : [];
}

/**
 * A project this credential may not act in.
 *
 * One sentence for reads and writes alike, and for every group that has one to
 * make. A surface that refused a stranger's project on a write and answered an
 * empty list on a read would have two rules, and the empty list is the worse
 * half: it reads as "you have no tests there" rather than as "that is not yours
 * to ask about".
 */
export function cannotActIn(projectId: string): string {
  return (
    `this credential may not act in project ${projectId}. A credential ` +
    `authorized for one project acts in that one, and a key for the whole ` +
    `organization acts in any project of that organization. Leave project out ` +
    `to use the project this credential already acts in.`
  );
}

/** One refusal, in the envelope every refusal in this API arrives in. */
export function refuse(
  status: number,
  error: string,
  message: string,
): { readonly status: number; readonly body: Record<string, unknown> } {
  return { status, body: { error, message } };
}

/**
 * What every group answers a request carrying no key, or one this instance
 * never minted, word for word as the real credential door answers it.
 *
 * A client relays a 401 to a terminal unchanged, so this sentence is contract
 * as much as any other — and a fixture with a shorter one would let a client
 * ship a check against words the real thing never says.
 */
export const NOT_AUTHENTICATED = {
  error: "not_authenticated",
  message:
    "this request carried no session and no usable API key. " +
    "Sign in, or send Authorization: Bearer with an egma key.",
} as const;
