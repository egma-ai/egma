/**
 * The account's telephone numbers, read for what they are bound to rather than
 * for who answers them.
 *
 * `listNumbers` beside this one answers the setup wizard's question — which
 * numbers reach this agent — and throws the rest of each binding away. That is
 * the right shape for a wizard and the wrong shape for a run: a run has to put
 * a binding back exactly as it found it, and a binding rebuilt from the two
 * fields egma happened to read is a binding egma changed. So this read keeps
 * every number's `inbound_agents` entries **verbatim**, and the restore below
 * writes back the bytes that were recorded rather than a reconstruction.
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
 * `agentVersion` is lifted out because every verdict below reads it, and the
 * whole entry rides beside it because the restore writes the whole entry. The
 * two never disagree: the lifted value is read out of `verbatim` and is never
 * written back into it.
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

export type WroteNumberBindings =
  | { readonly kind: "written" }
  | RetellFailure;

/**
 * What one binding means for a run that is about to mint a new version.
 *
 * The four verdicts are the whole of the safety question, and they are here
 * rather than at the call site so that "safe to branch under" means one thing
 * in the guard, in the sweep, and in whatever asks next.
 *
 * - `numeric` — pinned to a version that exists; a new version cannot move it.
 * - `environment-tag` — pinned through a tag; the tag assignment is the
 *   customer's and is never touched, and a new version does not join a tag.
 * - `latest-published` — safe **because a draft is never published**. That is
 *   the one verdict that depends on a promise kept elsewhere, and the promise
 *   is kept absolutely: nothing in this package publishes anything.
 * - `hijackable` — `latest`, or nothing at all. Branching mints the highest
 *   version, so a real caller would reach the new version the instant it
 *   exists. This is the verdict that needs a pin.
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

/**
 * A number's whole `inbound_agents` array, written as given.
 *
 * The array is what Retell holds and the array is what goes back, so both
 * writes below are one shape: neither ever sends a field egma invented, and a
 * sibling field egma has never heard of survives the round trip untouched.
 */
async function writeInboundAgents(
  key: RetellCredential,
  number: string,
  inboundAgents: readonly Readonly<Record<string, unknown>>[],
  reach: RetellReach,
): Promise<WroteNumberBindings> {
  let answer;
  try {
    answer = await ask(key, reach, {
      method: "PATCH",
      // The `+` in an E.164 number is a space in a path segment unless it is
      // encoded, which is how a number read a moment ago becomes a 404.
      path: `/update-phone-number/${encodeURIComponent(number)}`,
      body: { inbound_agents: inboundAgents },
    });
  } catch (cause) {
    return unreachableFrom(cause);
  }

  const failure = failureIn(answer);
  return failure ?? { kind: "written" };
}

/**
 * Pin one number's binding for this agent to a version that exists.
 *
 * Only the one field moves. Every other field of the entry — weight, and
 * whatever Retell adds next — is carried across from what was read, and every
 * other agent's entry on the number is carried across whole, because a pin is
 * a pause on one deploy habit and never an edit of the customer's routing.
 */
export async function pinNumberBinding(
  key: RetellCredential,
  pin: {
    readonly number: string;
    readonly agentId: string;
    /** The numeric version the binding resolves to right now. */
    readonly version: number;
    /** Every binding the number carries, exactly as it was read. */
    readonly bindings: readonly NumberBinding[];
  },
  reach: RetellReach = {},
): Promise<WroteNumberBindings> {
  const written = pin.bindings.map((binding) =>
    binding.agentId === pin.agentId
      ? { ...binding.verbatim, agent_version: pin.version }
      : binding.verbatim,
  );
  return writeInboundAgents(key, pin.number, written, reach);
}

/**
 * Put a number's bindings back exactly as they were recorded.
 *
 * Restores rather than reconstructs: the caller hands back the entries it
 * recorded before it touched anything, so a field egma never read is still the
 * field the customer wrote.
 */
export async function restoreNumberBindings(
  key: RetellCredential,
  restore: {
    readonly number: string;
    readonly bindings: readonly NumberBinding[];
  },
  reach: RetellReach = {},
): Promise<WroteNumberBindings> {
  return writeInboundAgents(
    key,
    restore.number,
    restore.bindings.map((binding) => binding.verbatim),
    reach,
  );
}
