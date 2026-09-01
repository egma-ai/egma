/**
 * The account's telephone numbers, read for what they are bound to rather than
 * for who answers them.
 *
 * **Everything here reads, and nothing writes.** Egma never edits a customer's
 * number bindings — not for a moment, not to put one back afterwards (developer
 * ruling, 2026-08-31). Retell's own picker offers Latest Created and Latest
 * Published beside real tags, tags are movable, and an unassigned tag resolves
 * to latest without saying so: too many edges for egma to touch somebody's
 * inbound routing safely. What a mocked run once pinned and restored is now
 * something a developer is told about instead, on the screens where they turn
 * mocking on.
 *
 * `listNumbers` beside this one answers the setup wizard's question — which
 * numbers reach this agent — and throws the rest of each binding away. This
 * read keeps every number's `inbound_agents` entries **verbatim**, because what
 * a binding names is what decides the version a run is conducted against.
 */

import {
  ask,
  failureIn,
  parsed,
  plain,
  unreachableFrom,
  type RetellCredential,
  type RetellFailure,
  type RetellReach,
} from "./transport.ts";

/** How many numbers one listing request asks for. */
const PAGE_SIZE = 1000;

/** A provider must finish a listing before it can hold this process forever. */
const MAX_PAGES = 100;

/**
 * One inbound binding on a number, kept whole.
 *
 * `agentVersion` is lifted out because the verdict below reads it, and the whole
 * entry rides beside it so a reader can see what egma read it from. The two
 * never disagree: the lifted value is read out of `verbatim`.
 */
export type NumberBinding = {
  readonly agentId: string;
  /**
   * What the number is pinned to: a version number, `latest`,
   * `latest_published`, an environment tag's name, or `null` where Retell
   * holds none at all.
   */
  readonly agentVersion: string | number | null;
  /** The binding entry exactly as Retell answered it. */
  readonly verbatim: Readonly<Record<string, unknown>>;
};

/** One number on the account, with every binding it carries kept whole. */
export type RoutedNumber = {
  /** E.164, exactly as Retell holds it. */
  readonly number: string;
  /** What the customer calls it, or `""` when they have never named it. */
  readonly label: string;
  readonly bindings: readonly NumberBinding[];
};

export type ListedRoutedNumbers =
  | { readonly kind: "numbers"; readonly numbers: readonly RoutedNumber[] }
  | RetellFailure;

/**
 * What one binding names, in the four shapes Retell lets it take.
 *
 * **Read to decide which version a run is conducted against**, and for nothing
 * else — egma acts on none of them. `numeric` and `environment-tag` each name a
 * version, so a run follows them; the other two name only a moving pointer, so
 * a run falls through to the newest published version. That selection is
 * `versionReferenceIn`, and it is the one caller these verdicts have.
 *
 * - `numeric` — bound to a version that exists.
 * - `environment-tag` — bound through a tag. The assignment is the customer's,
 *   and an unassigned tag resolves to latest without saying so — which is one
 *   of the reasons egma writes to none of this.
 * - `latest-published` — follows the published pointer. A draft is never
 *   published, and nothing in this package publishes anything.
 * - `hijackable` — `latest`, or nothing at all. Retell's picker calls it Latest
 *   Created, and a temporary draft **is** the latest created — so a real caller
 *   on such a number reaches egma's copy while a mocked run is in flight. Egma
 *   used to pin the number and put it back; it no longer touches it, and says
 *   so on the screens where mocking is turned on. The name is kept because that
 *   is still exactly what the binding is.
 */
export const BINDING_VERDICTS = [
  "numeric",
  "environment-tag",
  "latest-published",
  "hijackable",
] as const;
export type BindingVerdict = (typeof BINDING_VERDICTS)[number];

export function bindingVerdictOf(binding: NumberBinding): BindingVerdict {
  const version = binding.agentVersion;
  if (typeof version === "number") return "numeric";
  if (version === null) return "hijackable";
  const named = version.trim();
  if (named === "" || named === "latest") return "hijackable";
  if (named === "latest_published") return "latest-published";
  // Anything else Retell accepts here is an environment tag's own name. Tags
  // have no API at all, so egma can neither list them nor check one — and a
  // name it cannot check is still not `latest`, which is the only thing this
  // verdict has to decide.
  return "environment-tag";
}

/** A binding entry, or `null` for a row that is not one. */
function bindingFrom(row: unknown): NumberBinding | null {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const held = row as Record<string, unknown>;
  const agentId = plain(held["agent_id"]);
  if (agentId === "") return null;
  const version = held["agent_version"];
  return {
    agentId,
    agentVersion:
      typeof version === "number" || typeof version === "string"
        ? version
        : null,
    verbatim: held,
  };
}

/** A listed number, or `null` for a row that is not one. */
function routedNumberFrom(row: unknown): RoutedNumber | null {
  if (typeof row !== "object" || row === null) return null;
  const held = row as Record<string, unknown>;
  const number = plain(held["phone_number"]);
  if (number === "") return null;

  const routed = Array.isArray(held["inbound_agents"])
    ? (held["inbound_agents"] as unknown[])
    : [];
  const bindings: NumberBinding[] = [];
  for (const entry of routed) {
    const binding = bindingFrom(entry);
    if (binding !== null) bindings.push(binding);
  }

  return { number, label: plain(held["nickname"]), bindings };
}

/**
 * Every telephone number on the account, paged to the end.
 *
 * Paged to the end and never to the first page: a customer with a second page
 * of numbers has one on it that rides `latest`, and a guard that stopped early
 * would call the account safe while a real caller was one branch away from the
 * mocked world.
 */
export async function listRoutedNumbers(
  key: RetellCredential,
  reach: RetellReach = {},
): Promise<ListedRoutedNumbers> {
  const numbers: RoutedNumber[] = [];
  let paginationKey: string | undefined;
  const seenPaginationKeys = new Set<string>();

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        limit: String(PAGE_SIZE),
        sort_order: "ascending",
        ...(paginationKey === undefined
          ? {}
          : { pagination_key: paginationKey }),
      });
      const answer = await ask(key, reach, {
        method: "GET",
        path: `/v2/list-phone-numbers?${query.toString()}`,
      });

      const failure = failureIn(answer);
      // A listing names no one thing, so a 404 here is the endpoint and not a
      // missing number: it is reported as the refusal it is.
      if (failure !== undefined) {
        return failure.kind === "gone"
          ? { kind: "refused", reason: "Retell refused the request (404)." }
          : failure;
      }

      const held = parsed(answer);
      const rows = held["items"];
      const hasMore = held["has_more"];
      if (!Array.isArray(rows) || typeof hasMore !== "boolean") {
        return {
          kind: "refused",
          reason: "Retell answered a malformed phone-number page.",
        };
      }
      for (const row of rows) {
        const number = routedNumberFrom(row);
        if (number !== null) numbers.push(number);
      }

      const next = plain(held["pagination_key"]);
      if (!hasMore) return { kind: "numbers", numbers };
      if (next === "" || seenPaginationKeys.has(next)) {
        return {
          kind: "refused",
          reason: "Retell answered a phone-number page without a new cursor.",
        };
      }
      seenPaginationKeys.add(next);
      paginationKey = next;
    }
  } catch (cause) {
    return unreachableFrom(cause);
  }

  return {
    kind: "refused",
    reason: "Retell answered too many phone-number pages.",
  };
}

/**
 * The numbers that route to one agent, each keeping **every** binding it has.
 *
 * The filter is on numbers and never on the entries inside one, and that is
 * load-bearing rather than tidy: a number two agents share is put back as a
 * whole array, so a read that dropped the other agent's entry would restore a
 * number with that agent's routing deleted. Which entries are this agent's is
 * `bindingsFor` below, asked where the verdicts are decided.
 */
export function numbersRouting(
  numbers: readonly RoutedNumber[],
  agentId: string,
): readonly RoutedNumber[] {
  const wanted = agentId.trim();
  return numbers.filter((number) =>
    number.bindings.some((binding) => binding.agentId === wanted),
  );
}

/** The entries on one number that route to a given agent. */
export function bindingsFor(
  number: RoutedNumber,
  agentId: string,
): readonly NumberBinding[] {
  const wanted = agentId.trim();
  return number.bindings.filter((binding) => binding.agentId === wanted);
}
