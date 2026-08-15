/**
 * One read of the product API, and the four things a page can be told.
 *
 * Every product page in this application asks the same question — *give me
 * this, in this project* — and has to answer the same four situations for
 * somebody looking at it: it is here, it is not here, egma refused, and you
 * are not signed in. Writing that fold once is what lets a page's own code be
 * about its own subject, and what stops one page quietly deciding that a 404
 * is a failure while its neighbour decides it is an empty list.
 *
 * **A missing thing and a project that is not yours are the same answer**, and
 * deliberately so: the API answers both as an absence so that following a
 * stranger's link never reveals whether the thing on the other end exists.
 *
 * The refusal's own sentence is always kept and never paraphrased. It is
 * written to be shown, it names the next move, and a second copy of it in a
 * page would be a second thing to keep in step.
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

/** One read, with the project named in it where the caller named one. */
export async function readJson<T>(
  path: string,
  options: { readonly project?: string; readonly signal?: AbortSignal } = {},
): Promise<Answer<T>> {
  const address =
    options.project === undefined
      ? path
      : `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(options.project)}`;

  try {
    const response = await fetch(address, {
      cache: "no-store",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await response.json().catch(() => null);
    return answerFor<T>(response.status, body);
  } catch {
    return unreachable<T>();
  }
}
