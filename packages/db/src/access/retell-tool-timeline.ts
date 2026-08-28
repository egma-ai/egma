import { createHash } from "node:crypto";

/**
 * The safe, structural slice selected from one Retell root payload.
 *
 * Each JSON string contains arrays of tuples, never the provider document:
 * woven tuples are `[role, tool_call_id, time_sec]`; summary tuples are
 * `[tool_call_id, start_time_sec, latency_ms]`. Conversation text, tool
 * arguments and tool results never cross the ClickHouse boundary.
 */
export type RetellToolTimelineSlice = {
  readonly root_span_id: string;
  readonly retell_woven: string;
  readonly retell_tool_summaries: string;
};

/** The only stored row fields the compatibility projection may change. */
export type RetellToolTimelineSpanRow = {
  readonly span_id: string;
  readonly parent_span_id: string;
  readonly kind: string;
  readonly started_at_micros: string;
  readonly duration_ns: string;
  readonly provider_tool_id: string;
};

type WovenEvent = {
  readonly role: string;
  readonly toolId: string;
  readonly afterNanoseconds: bigint | undefined;
  readonly turnIndex: number | undefined;
};

type Summary = {
  readonly startedAfterNanoseconds: bigint | undefined;
  readonly durationNanoseconds: bigint | undefined;
};

type Correction = {
  readonly parentTurn: number | undefined;
  readonly startedAfterNanoseconds: bigint | undefined;
  readonly durationNanoseconds: bigint | undefined;
};

const NANOSECONDS_PER_SECOND = 1_000_000_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/** A tuple array from ClickHouse, or an empty one for an old or damaged row. */
function tuples(value: string): readonly (readonly unknown[])[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is readonly unknown[] => Array.isArray(entry))
    : [];
}

/** A JSON scalar selected with JSONExtractRaw, in the unit the caller names. */
function nonNegativeNanoseconds(
  raw: unknown,
  nanosecondsPerUnit: number,
): bigint | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? BigInt(Math.round(parsed * nanosecondsPerUnit))
    : undefined;
}

function wovenEvents(value: string): readonly WovenEvent[] {
  let turnIndex = 0;
  return tuples(value).map((tuple): WovenEvent => {
    const role = typeof tuple[0] === "string" ? tuple[0] : "";
    const spoken = role === "user" || role === "agent";
    const event = {
      role,
      toolId: typeof tuple[1] === "string" ? tuple[1] : "",
      afterNanoseconds: nonNegativeNanoseconds(
        tuple[2],
        NANOSECONDS_PER_SECOND,
      ),
      turnIndex: spoken ? turnIndex : undefined,
    };
    if (spoken) turnIndex += 1;
    return event;
  });
}

function summariesById(value: string): ReadonlyMap<string, Summary> {
  const summaries = new Map<string, Summary>();
  for (const tuple of tuples(value)) {
    const id = typeof tuple[0] === "string" ? tuple[0] : "";
    if (id === "") continue;
    summaries.set(id, {
      startedAfterNanoseconds: nonNegativeNanoseconds(
        tuple[1],
        NANOSECONDS_PER_SECOND,
      ),
      durationNanoseconds: nonNegativeNanoseconds(
        tuple[2],
        NANOSECONDS_PER_MILLISECOND,
      ),
    });
  }
  return summaries;
}

/**
 * Span ids are immutable historical data. This repeats the Retell normalizer's
 * documented identity formula so the compatibility reader can name an already
 * stored turn without importing API code into the data-access package.
 */
function storedRetellSpanId(traceId: string, within: string): string {
  return createHash("sha256")
    .update(`egma:retell:span\n${traceId}\n${within}`)
    .digest("hex")
    .slice(0, 16);
}

function correctionsById(
  events: readonly WovenEvent[],
  summaries: ReadonlyMap<string, Summary>,
): ReadonlyMap<string, Correction> {
  const corrections = new Map<string, Correction>();

  for (const [at, invocation] of events.entries()) {
    if (invocation.role !== "tool_call_invocation" || invocation.toolId === "") {
      continue;
    }
    const previousSpoken = events
      .slice(0, at)
      .findLast((event) => event.turnIndex !== undefined);
    const followingAgent = events
      .slice(at + 1)
      .find((event) => event.role === "agent");
    const result = events
      .slice(at + 1)
      .find(
        (event) =>
          event.role === "tool_call_result" &&
          event.toolId === invocation.toolId,
      );
    const summary = summaries.get(invocation.toolId);
    const measuredInterval =
      invocation.afterNanoseconds !== undefined &&
      result?.afterNanoseconds !== undefined &&
      result.afterNanoseconds >= invocation.afterNanoseconds
        ? result.afterNanoseconds - invocation.afterNanoseconds
        : undefined;

    corrections.set(invocation.toolId, {
      parentTurn:
        previousSpoken?.role === "agent"
          ? previousSpoken.turnIndex
          : followingAgent?.turnIndex,
      startedAfterNanoseconds:
        invocation.afterNanoseconds ?? summary?.startedAfterNanoseconds,
      durationNanoseconds: summary?.durationNanoseconds ?? measuredInterval,
    });
  }

  return corrections;
}

/**
 * Repair the returned view of old Retell rows; never rewrite stored evidence.
 *
 * The generic tree builder receives ordinary rows after this provider-specific
 * adapter has finished. A missing provider id or root leaves a row untouched.
 * A known tool whose intended Agent is unavailable moves under the root instead
 * of retaining the old normalizer's false human ownership, so it stays visible
 * as an honest orphan.
 */
export function withRetellToolTimeline<
  Row extends RetellToolTimelineSpanRow,
>(
  traceId: string,
  rows: readonly Row[],
  slice: RetellToolTimelineSlice | undefined,
): readonly Row[] {
  if (slice === undefined) return rows;
  const root = rows.find((row) => row.span_id === slice.root_span_id);
  if (root === undefined) return rows;

  const present = new Set(rows.map((row) => row.span_id));
  const corrections = correctionsById(
    wovenEvents(slice.retell_woven),
    summariesById(slice.retell_tool_summaries),
  );

  let changed = false;
  const projected = rows.map((row) => {
    if (row.kind !== "tool" || row.provider_tool_id === "") return row;
    const correction = corrections.get(row.provider_tool_id);
    if (correction === undefined) return row;

    const targetParent =
      correction.parentTurn === undefined
        ? undefined
        : storedRetellSpanId(traceId, `turn/${correction.parentTurn}`);
    const parentSpanId =
      targetParent !== undefined && present.has(targetParent)
        ? targetParent
        : root.span_id;
    const startedAtMicroseconds =
      correction.startedAfterNanoseconds === undefined
        ? row.started_at_micros
        : (
            BigInt(root.started_at_micros) +
            correction.startedAfterNanoseconds / 1000n
          ).toString();
    const durationNanoseconds =
      correction.durationNanoseconds?.toString() ?? row.duration_ns;

    if (
      parentSpanId === row.parent_span_id &&
      startedAtMicroseconds === row.started_at_micros &&
      durationNanoseconds === row.duration_ns
    ) {
      return row;
    }
    changed = true;

    return {
      ...row,
      parent_span_id: parentSpanId,
      started_at_micros: startedAtMicroseconds,
      duration_ns: durationNanoseconds,
    };
  });

  if (!changed) return rows;
  // The query ordered the stored instants. A corrected instant must restore
  // that same contract before the provider-neutral tree groups siblings.
  return projected.toSorted((left, right) => {
    const leftStarted = BigInt(left.started_at_micros);
    const rightStarted = BigInt(right.started_at_micros);
    if (leftStarted < rightStarted) return -1;
    if (leftStarted > rightStarted) return 1;
    return left.span_id.localeCompare(right.span_id);
  });
}
