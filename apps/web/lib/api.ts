/**
 * Map reads to ready, missing, refused, or signed-out states. Preserve the
 * API refusal message so callers can display it without a second copy.
 */

/** The shape every refusal from this API has: a stable code, and a sentence. */
export type Refusal = {
  readonly error: string;
  readonly message: string;
};

export type Answer<T> =
  | { readonly status: "ready"; readonly value: T }
  /** Not here, or not yours — one answer, on purpose. */
  | { readonly status: "missing"; readonly refusal: Refusal }
  | { readonly status: "failed"; readonly refusal: Refusal }
  | { readonly status: "signed-out" };

/**
 * The refusal code a page shows when it needs a different sentence for a
 * project the signed-in organization does not hold.
 */
export const PROJECT_OUTSIDE_ORGANIZATION = "project_outside_organization";

function isRefusal(body: unknown): body is Refusal {
  const held = body as { error?: unknown; message?: unknown } | null;
  return (
    typeof held === "object" &&
    held !== null &&
    typeof held.error === "string" &&
    typeof held.message === "string"
  );
}

/**
 * What an HTTP answer means to a page.
 *
 * A body that is not egma's refusal shape is still answered with a sentence,
 * because a proxy, a container running a different build, or a route that is
 * not mounted all reply with something — and a page showing nothing at all
 * would present a broken deployment as a product working correctly.
 */
export function answerFor<T>(status: number, body: unknown): Answer<T> {
  if (status === 401) return { status: "signed-out" };

  if (status >= 200 && status < 300) {
    return { status: "ready", value: body as T };
  }

  const refusal: Refusal = isRefusal(body)
    ? body
    : {
        error: "unreadable_answer",
        message: `Egma answered ${status} and said nothing this page can read. Try again, and check the API if it keeps happening.`,
      };

  return status === 404
    ? { status: "missing", refusal }
    : { status: "failed", refusal };
}

/** What a page shows when the request never reached egma at all. */
export function unreachable<T>(): Answer<T> {
  return {
    status: "failed",
    refusal: {
      error: "unreachable",
      message:
        "Egma could not be reached. Check your connection and the API, then try again.",
    },
  };
}

/**
 * Forward the caller's optional abort signal. This helper sets no deadline;
 * an abort is returned as a failed read.
 */
export async function readJson<T>(
  path: string,
  options?: { readonly signal?: AbortSignal },
): Promise<Answer<T>> {
  try {
    const response = await fetch(path, {
      cache: "no-store",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await response.json().catch(() => null);
    return answerFor<T>(response.status, body);
  } catch {
    return unreachable<T>();
  }
}

/**
 * The refusal codes a form has to answer differently from every other refusal.
 *
 * A stale write is not a failure to show and forget: the person's typing is
 * still on screen and still worth keeping, and the fix is to read the resource
 * again and send the same edit against the revision it names now. So a form
 * recognises these and says so, rather than showing the sentence in the same
 * grey box as everything else.
 */
export const IDENTITY_CONFLICT = "identity_conflict";
export const NAME_TAKEN = "name_taken";
