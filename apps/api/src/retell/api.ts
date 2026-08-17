import type { RetellCall } from "./normalise.ts";

/**
 * The three things egma asks Retell for while it is watching an agent.
 *
 * Retell's own names are used for Retell's own objects — its addresses, its
 * field names, its filter shape. Renaming somebody else's API inside a client
 * for it makes the client harder to check against their documentation, which is
 * the one thing this file has to stay true to.
 *
 * Every ending is a value rather than an exception. A key the customer rotated
 * and a Retell that is briefly down are different facts about a sweep, and
 * neither of them is a fault in egma.
 */

/** Retell's own address. Overridden only so a test can answer as Retell. */
export const RETELL_API = "https://api.retellai.com";

/** How many conversations one page asks for. */
export const PAGE_SIZE = 100;

/** Where egma is asking, and what does the asking. */
export type RetellReach = {
  readonly url?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
};

export type ListedCalls =
  | { readonly kind: "calls"; readonly calls: readonly RetellCall[] }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

export type Registered =
  | { readonly kind: "registered" }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

function base(reach: RetellReach): string {
  return (reach.url ?? RETELL_API).replace(/\/+$/u, "");
}

type Answer = { readonly status: number; readonly body: string };

/**
 * One request, with the key in the header and nowhere else.
 *
 * Nothing about the request is logged and no failure repeats what was sent: the
 * key is a customer's, and a refusal that quoted the request would put it in
 * whatever read the log next.
 */
async function ask(
  apiKey: string,
  reach: RetellReach,
  request: {
    readonly method: "GET" | "POST" | "PATCH";
    readonly path: string;
    readonly body?: unknown;
  },
): Promise<Answer | { readonly unreachable: string }> {
  const url = `${base(reach)}${request.path}`;
  const fetchImpl = reach.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });
  } catch (cause) {
    return {
      unreachable: `Retell at ${base(reach)} did not answer${
        cause instanceof Error ? `: ${cause.message}` : ""
      }`,
    };
  }

  return { status: response.status, body: await response.text() };
}

/** What Retell said went wrong, in a sentence rather than a status code alone. */
function refusalIn(answer: Answer): string {
  try {
    const held = JSON.parse(answer.body) as Record<string, unknown>;
    for (const field of ["error_message", "message", "error", "detail"]) {
      const said = held[field];
      if (typeof said === "string" && said.trim() !== "") return said.trim();
    }
  } catch {
    // A refusal that is not JSON says nothing useful, and quoting a page of
    // HTML into a log line is worse than saying what the number means.
  }
  return `Retell answered ${answer.status}`;
}

/**
 * One page of conversations this agent finished at or after `since`.
 *
 * **Ascending, and the lower bound is inclusive.** Both are load-bearing:
 * oldest-first is what lets the poller checkpoint each conversation before it
 * moves on, and an inclusive bound means the last conversation written is
 * offered again after a resume — which the ledger absorbs, and which is what
 * lets the cursor logic stay as simple as it is.
 *
 * The answer's shape is read permissively — an array, or an object with the
 * page under `calls` or `items` — because that is the one thing about somebody
 * else's API this cannot check against a live account here. Nothing depends on
 * which shape it was: whatever comes back is a list of call objects, and the
 * normalizer reads each one as verbatim as it stores it.
 */
export async function listEndedCalls(
  apiKey: string,
  request: {
    readonly retellAgentId: string;
    readonly since: Date | null;
    readonly paginationKey?: string | undefined;
    readonly limit?: number | undefined;
  },
  reach: RetellReach = {},
): Promise<ListedCalls> {
  const answer = await ask(apiKey, reach, {
    method: "POST",
    path: "/v2/list-calls",
    body: {
      filter_criteria: {
        agent_id: [request.retellAgentId],
        call_status: ["ended"],
        ...(request.since === null
          ? {}
          : {
              end_timestamp: { lower_threshold: request.since.getTime() },
            }),
      },
      sort_order: "ascending",
      limit: request.limit ?? PAGE_SIZE,
      ...(request.paginationKey === undefined
        ? {}
        : { pagination_key: request.paginationKey }),
    },
  });

  if ("unreachable" in answer) {
    return { kind: "unreachable", reason: answer.unreachable };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "invalid-key" };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "refused", reason: refusalIn(answer) };
  }

  let held: unknown;
  try {
    held = JSON.parse(answer.body);
  } catch {
    return { kind: "refused", reason: "Retell answered something that is not JSON" };
  }

  const rows = Array.isArray(held)
    ? held
    : typeof held === "object" && held !== null
      ? ((held as Record<string, unknown>)["calls"] ??
        (held as Record<string, unknown>)["items"])
      : undefined;

  if (!Array.isArray(rows)) return { kind: "calls", calls: [] };

  return {
    kind: "calls",
    calls: rows.filter(
      (row): row is RetellCall =>
        typeof row === "object" && row !== null && !Array.isArray(row),
    ),
  };
}

/**
 * Point this agent's webhook at egma, or take it away again.
 *
 * `null` is the deregistration a switch-off performs, and it is written as
 * Retell's own way of clearing the field rather than as a second endpoint.
 */
export async function setAgentWebhook(
  apiKey: string,
  retellAgentId: string,
  webhookUrl: string | null,
  reach: RetellReach = {},
): Promise<Registered> {
  const answer = await ask(apiKey, reach, {
    method: "PATCH",
    path: `/update-agent/${encodeURIComponent(retellAgentId)}`,
    body: { webhook_url: webhookUrl },
  });

  if ("unreachable" in answer) {
    return { kind: "unreachable", reason: answer.unreachable };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "invalid-key" };
  }
  if (answer.status < 200 || answer.status >= 300) {
    return { kind: "refused", reason: refusalIn(answer) };
  }
  return { kind: "registered" };
}
