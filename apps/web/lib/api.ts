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

/**
 * One write, with the project named in the body where the caller named one.
 *
 * The same four answers a read has, for the same reason: a page has to be able
 * to tell a refusal it can show from a session that has expired, and inventing
 * a second vocabulary for writes would give it two ways to get that wrong.
 *
 * **The project travels in the body rather than the query**, which is where
 * every write route in this API looks for it — so a page cannot accidentally
 * send a write that names no project and have it land somewhere plausible.
 */
export async function sendJson<T>(
  path: string,
  options: {
    readonly method: "POST" | "PATCH" | "PUT";
    readonly body: Record<string, unknown>;
    readonly project?: string;
    readonly signal?: AbortSignal;
  },
): Promise<Answer<T>> {
  try {
    const response = await fetch(path, {
      method: options.method,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        options.project === undefined
          ? options.body
          : { ...options.body, project: options.project },
      ),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await response.json().catch(() => null);
    return answerFor<T>(response.status, body);
  } catch {
    return unreachable<T>();
  }
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
 * **`project` here means the address, and it is the only spelling a page should
 * use.** Three pages used to put the project in the body instead, because three
 * doors read only a body key — and a reader had nothing at the type level
 * telling the two spellings apart, so the next page written from either
 * neighbour had even odds of being ignored. The doors now read the address as
 * well as the body, so there is one way to say it here and the CLI's body key
 * still works where a terminal sends one.
 */
export async function writeJson<T>(
  path: string,
  options: {
    readonly method: "POST" | "PATCH";
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
