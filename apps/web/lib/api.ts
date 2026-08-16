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

/**
 * One write, with the project named in it and the same four answers a read
 * gets.
 *
 * **A write answers exactly what a read answers**, and that is the whole reason
 * this lives beside `readJson` rather than inside each form. A page that
 * invented its own reading of a 404 on save, or quietly swallowed a 409, would
 * be a page where a stale edit looks like a successful one. The refusal's own
 * sentence is kept and never paraphrased: it names the next move, and the
 * conflict refusals name the revision to retry against.
 *
 * **`project` here means the address, and it is now the only spelling a page
 * has.** There used to be a second helper, `sendJson`, one keystroke away, that
 * put the project in the *body* — and its comment said the body "is where every
 * write route in this API looks for it", while this one said the address was
 * the only spelling a page should use. Both sentences were in the same file,
 * sixty lines apart, and by then only one of them was true of any given door.
 * Six pages were using the wrong one, and nothing at the type level told a
 * reader which door read which.
 *
 * So `sendJson` is gone. Every write door in this API reads `projectNamed`'s
 * one rule — the query, then the body — so a page names its project in the
 * address, a terminal names it in the body, and neither spelling is ignored by
 * anything. There is one helper here because there is one rule there.
 */
export async function writeJson<T>(
  path: string,
  options: {
    readonly method: "POST" | "PATCH" | "PUT";
    readonly project?: string;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  },
): Promise<Answer<T>> {
  const address =
    options.project === undefined
      ? path
      : `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(options.project)}`;

  try {
    const response = await fetch(address, {
      method: options.method,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body ?? {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await response.json().catch(() => null);
    return answerFor<T>(response.status, body);
  } catch {
    return unreachable<T>();
  }
}

/**
 * One delete, with the project named in it and the same four answers a read
 * gets.
 *
 * **It sends no body at all**, which is what separates it from `writeJson`
 * rather than a shorter spelling of it. A delete says everything it has to say
 * in its address, and a request carrying `content-type: application/json` with
 * nothing after it is refused by the server's own body parser — a refusal about
 * an empty body, in place of the act somebody asked for.
 *
 * A 404 arrives as `missing`, exactly as it does on a read, and that is the
 * honest answer for a delete: the thing is not there, whether it never was,
 * whether it belongs to somebody else, or whether it went a moment ago.
 */
export async function deleteJson<T>(
  path: string,
  options: { readonly project?: string; readonly signal?: AbortSignal } = {},
): Promise<Answer<T>> {
  const address =
    options.project === undefined
      ? path
      : `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(options.project)}`;

  try {
    const response = await fetch(address, {
      method: "DELETE",
      cache: "no-store",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
