/**
 * One request to Retell, and the four shapes an answer to one can take.
 *
 * Every verb in this package goes out through `ask`. The credential is read
 * here and nowhere else on the way out, nothing about a request is logged, and
 * no failure repeats what was sent — which is what lets a caller hand this
 * client a customer's key and a secret-carrying tool configuration in the same
 * breath.
 */

/** The one thing this client needs from the world, so tests can stand in. */
export type Fetch = typeof fetch;

/** A credential holder. The CLI masked RetellKey satisfies this interface. */
export type RetellCredential = {
  reveal(): string;
};

/** Retell's own address. `RetellReach.url` points somewhere else in a check. */
export const RETELL_API = "https://api.retellai.com";

/** Where Retell is, and what talks to it. */
export type RetellReach = {
  /** Retell's API. Retell's own address when omitted. */
  readonly url?: string | undefined;
  readonly fetchImpl?: Fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

/**
 * A string off the wire with nothing in it a terminal would obey.
 *
 * An agent's name is drawn on a screen, and a terminal reads a control
 * character as an instruction rather than as text. They come out at the one
 * edge that reads the wire, so nothing below here has to remember.
 */
export function plain(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim()
    : "";
}

/** What a developer is told when Retell never answered. */
export class RetellUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Retell at ${url} did not answer. Check this machine's network, then try again.`,
      {
        cause,
      },
    );
    this.name = "RetellUnreachableError";
  }
}

export type Answer = {
  readonly status: number;
  /** The transient body as it arrived. It does not cross this client. */
  readonly body: string;
};

export function base(reach: RetellReach): string {
  return (reach.url ?? RETELL_API).replace(/\/+$/u, "");
}

/** The methods this client writes with. Retell's own verbs, no others. */
export type RetellMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * One request, with the key in the header and nowhere else.
 *
 * The key is read here and only here on the way out to Retell. Nothing about
 * the request is logged, and nothing about a failure repeats what was sent.
 */
export async function ask(
  key: RetellCredential,
  reach: RetellReach,
  request: {
    readonly method: RetellMethod;
    readonly path: string;
    readonly body?: unknown;
  },
): Promise<Answer> {
  const url = `${base(reach)}${request.path}`;
  const fetchImpl = reach.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${key.reveal()}`,
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
      ...(reach.signal === undefined ? {} : { signal: reach.signal }),
    });
    return { status: response.status, body: await response.text() };
  } catch (cause) {
    throw new RetellUnreachableError(base(reach), cause);
  }
}

/** A safe refusal. Retell's raw error body never leaves this client. */
export function refusalIn(answer: Answer): string {
  if (answer.status === 429) return "Retell is busy. Try again shortly.";
  if (answer.status >= 500) return "Retell is unavailable. Try again.";
  return `Retell refused the request (${answer.status}).`;
}

export function parsed(answer: Answer): Record<string, unknown> {
  try {
    const held = JSON.parse(answer.body) as unknown;
    return typeof held === "object" && held !== null
      ? (held as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The three ways a request can fail that every verb answers with in the same
 * words, so a caller writes one refusal branch rather than one per verb.
 */
export type RetellFailure =
  /** Retell would not take the key. */
  | { readonly kind: "invalid-key" }
  /** What was asked about is not there. */
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/**
 * The failure an answer carries, or `undefined` when it carries none.
 *
 * `gone` is only ever answered where a 404 means "the thing you named is not
 * there" — every verb below names one thing, so it always does.
 */
export function failureIn(answer: Answer): RetellFailure | undefined {
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "invalid-key" };
  }
  if (answer.status === 404) return { kind: "gone" };
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "refused", reason: refusalIn(answer) };
  }
  return undefined;
}

/**
 * The unreachable failure, for the one `catch` every verb writes.
 *
 * Rethrows anything that is not Retell being unreachable: a bug in this client
 * is not a provider outage and must not be reported as one.
 */
export function unreachableFrom(cause: unknown): RetellFailure {
  if (cause instanceof RetellUnreachableError) {
    return { kind: "unreachable", reason: cause.message };
  }
  throw cause;
}
