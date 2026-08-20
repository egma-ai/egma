import { safeRetellProviderData } from "@egma/retell";

import {
  retellCallDocumentIsComplete,
  type RetellCall,
} from "./normalise.ts";

/**
 * The provider reads Egma uses for Retell Monitoring.
 *
 * Retell's own names are used for Retell's own objects — its addresses, its
 * field names, its filter shape. Renaming somebody else's API inside a client
 * for it makes the client harder to check against their documentation, which is
 * the one thing this file has to stay true to.
 *
 * Every ending is a value rather than an exception. A key the customer rotated
 * and a Retell that is briefly down are different facts about an import, and
 * neither of them is a fault in Egma.
 */

/** Retell's own address. Overridden only so a test can answer as Retell. */
export const RETELL_API = "https://api.retellai.com";

/** How many conversations one page asks for. */
export const PAGE_SIZE = 100;

/** Where egma is asking, and what does the asking. */
export type RetellReach = {
  readonly url?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
};

export type RetellRefusalReason =
  | "invalid-window"
  | "invalid-response"
  | "invalid-call-id"
  | "provider-contract"
  | "rate-limited"
  | "provider-unavailable"
  | "request-refused";

export type RetellRefused = {
  readonly kind: "refused";
  readonly reason: RetellRefusalReason;
  readonly status?: number | undefined;
  readonly retryAfterMilliseconds?: number | undefined;
};

export type ListedCalls =
  | {
      readonly kind: "calls";
      readonly calls: readonly RetellCall[];
      readonly hasMore: boolean;
      readonly paginationKey: string | null;
    }
  | { readonly kind: "invalid-key" }
  | RetellRefused
  | { readonly kind: "unreachable"; readonly reason: string };

export type RetrievedCall =
  | { readonly kind: "call"; readonly call: RetellCall }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "not-found" }
  | RetellRefused
  | { readonly kind: "unreachable"; readonly reason: string };

export const TERMINAL_CALL_STATUSES = [
  "ended",
  "error",
  "not_connected",
] as const;

/** One fixed v3 page request. The bounds do not change while it is paged. */
export type RetellCallPageRequest = {
  readonly retellAgentId: string;
  readonly from: Date;
  readonly to: Date;
  readonly paginationKey?: string | undefined;
  /** Every cursor already followed in this fixed scan. */
  readonly seenPaginationKeys?: ReadonlySet<string> | undefined;
  readonly limit?: number | undefined;
};

function base(reach: RetellReach): string {
  return (reach.url ?? RETELL_API).replace(/\/+$/u, "");
}

type Answer = {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: string | null;
};

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
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
  },
): Promise<Answer | { readonly unreachable: string }> {
  const url = `${base(reach)}${request.path}`;
  const fetchImpl = reach.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(url, {
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
      ...(reach.signal === undefined ? {} : { signal: reach.signal }),
    });
    return {
      status: response.status,
      body: await response.text(),
      retryAfter: response.headers.get("retry-after"),
    };
  } catch {
    return {
      unreachable: `Retell at ${base(reach)} did not answer`,
    };
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** A bounded scheduler fact. Retell's raw error body never leaves this client. */
function refusalFrom(answer: Answer): RetellRefused {
  const reason: RetellRefusalReason =
    answer.status === 429
      ? "rate-limited"
      : answer.status >= 500
        ? "provider-unavailable"
        : "request-refused";
  const retryAfter = retryAfterMilliseconds(answer.retryAfter);
  return {
    kind: "refused",
    reason,
    status: answer.status,
    ...(retryAfter === undefined
      ? {}
      : { retryAfterMilliseconds: retryAfter }),
  };
}

/**
 * One page of this agent's terminal conversations in one fixed time window.
 *
 * **Ascending, and the lower bound is inclusive.** Both are load-bearing:
 * oldest-first is what lets the poller checkpoint each conversation before it
 * moves on, and an inclusive bound means the last conversation written is
 * offered again after a resume — which the ledger absorbs, and which is what
 * lets the cursor logic stay as simple as it is.
 *
 * Retell v3 owns the cursor. Egma never derives one from a call id. A page that
 * says there is more work but does not give a new non-empty cursor is a broken
 * provider answer, not the end of the scan.
 */
export async function listTerminalCalls(
  apiKey: string,
  request: RetellCallPageRequest,
  reach: RetellReach = {},
): Promise<ListedCalls> {
  const from = request.from.getTime();
  const to = request.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return { kind: "refused", reason: "invalid-window" };
  }

  const answer = await ask(apiKey, reach, {
    method: "POST",
    path: "/v3/list-calls",
    body: {
      filter_criteria: {
        agent: [{ agent_id: request.retellAgentId }],
        call_status: {
          type: "enum",
          op: "in",
          value: TERMINAL_CALL_STATUSES,
        },
        end_timestamp: {
          type: "range",
          op: "bt",
          value: [from, to],
        },
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
    return refusalFrom(answer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { kind: "refused", reason: "invalid-response" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", reason: "invalid-response" };
  }
  const held = parsed as Record<string, unknown>;
  const rows = held["items"];
  const hasMore = held["has_more"];
  if (!Array.isArray(rows) || typeof hasMore !== "boolean") {
    return { kind: "refused", reason: "invalid-response" };
  }
  if (
    rows.some(
      (row) =>
        typeof row !== "object" || row === null || Array.isArray(row),
    )
  ) {
    return { kind: "refused", reason: "invalid-response" };
  }
  if (
    rows.some((row) => {
      const callId = (row as Record<string, unknown>)["call_id"];
      return typeof callId !== "string" || callId.trim() === "";
    })
  ) {
    return { kind: "refused", reason: "invalid-response" };
  }

  const suppliedCursor =
    typeof held["pagination_key"] === "string"
      ? held["pagination_key"].trim()
      : "";
  if (
    hasMore &&
    (suppliedCursor === "" ||
      suppliedCursor === request.paginationKey ||
      request.seenPaginationKeys?.has(suppliedCursor) === true)
  ) {
    return {
      kind: "refused",
      reason: "provider-contract",
    };
  }

  return {
    kind: "calls",
    calls: rows.map((row) => safeRetellProviderData(row as RetellCall)),
    hasMore,
    paginationKey: hasMore ? suppliedCursor : null,
  };
}

/** Read one complete call. V3 list rows do not contain transcript fields. */
export async function getRetellCall(
  apiKey: string,
  callId: string,
  reach: RetellReach = {},
): Promise<RetrievedCall> {
  const wanted = callId.trim();
  if (wanted === "") {
    return { kind: "refused", reason: "invalid-call-id" };
  }

  const answer = await ask(apiKey, reach, {
    method: "GET",
    path: `/v2/get-call/${encodeURIComponent(wanted)}`,
  });

  if ("unreachable" in answer) {
    return { kind: "unreachable", reason: answer.unreachable };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "invalid-key" };
  }
  if (answer.status === 404) return { kind: "not-found" };
  if (answer.status < 200 || answer.status >= 300) {
    return refusalFrom(answer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { kind: "refused", reason: "invalid-response" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "refused", reason: "invalid-response" };
  }

  const call = parsed as RetellCall;
  if (typeof call["call_id"] !== "string" || call["call_id"].trim() !== wanted) {
    return { kind: "refused", reason: "invalid-response" };
  }
  const safeCall = safeRetellProviderData(call);
  if (!retellCallDocumentIsComplete(safeCall)) {
    return { kind: "refused", reason: "invalid-response" };
  }
  return { kind: "call", call: safeCall };
}

/**
 * Replace a light v3 list item with its full Get Call document.
 *
 * The list item is kept underneath fields only it supplied. The full document
 * wins when both supplied the same field because it is the later provider read.
 */
export async function hydrateRetellCall(
  apiKey: string,
  listed: RetellCall,
  reach: RetellReach = {},
): Promise<RetrievedCall> {
  const callId =
    typeof listed["call_id"] === "string" ? listed["call_id"].trim() : "";
  const hydrated = await getRetellCall(apiKey, callId, reach);
  if (hydrated.kind !== "call") return hydrated;
  return {
    kind: "call",
    call: safeRetellProviderData({ ...listed, ...hydrated.call }),
  };
}
