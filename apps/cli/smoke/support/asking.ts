/**
 * Asking a real egma what it holds, the way any other client would.
 *
 * A check that drove the CLI and then read the database to see what happened
 * would be proving something no customer can observe. So what landed is read
 * back over the same HTTP surface, with the same key the terminal is holding —
 * and the status comes back beside the body, because a check that read a field
 * off a 403 would pass by agreeing with an empty object.
 */

export type Asked = { readonly status: number; readonly body: Record<string, unknown> };

export async function ask(
  origin: string,
  key: string,
  at: string,
  method: "GET" | "POST" = "GET",
): Promise<Asked> {
  const answered = await fetch(`${origin}${at}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
  });
  const body = (await answered.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: answered.status, body };
}

/** A list off an answer, as rows, or nothing at all when it is not one. */
export function itemsOf(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const held = body[key];
  return Array.isArray(held) ? (held as Record<string, unknown>[]) : [];
}
