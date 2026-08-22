import { createHash } from "node:crypto";

import {
  REPORTED_MEASUREMENTS_PAYLOAD_KEY,
  reportedMeasurementsPayload,
  type NewSpan,
  type ReportedMeasurement,
} from "@egma/db";
import { safeRetellProviderData } from "@egma/retell";
import { catalogedMeasure, isSpanDerivedMeasure } from "@egma/simulation-contract";

/**
 * One Retell call object, as spans. The single place that reading happens.
 *
 * The v3 list selects terminal calls. Get Call then supplies the complete
 * document. This file is the one place that document becomes Egma spans, so a
 * live polling pass and a historical import cannot disagree about what a
 * conversation is.
 *
 * **Nothing here is synthesised.** Spoken turns use Retell's reported word
 * bounds when they exist. A turn with no usable word bounds stays at the call
 * start with zero duration rather than receiving invented timing. Every
 * latency figure Retell reports rides the root span as an attribute of the
 * whole conversation.
 *
 * **The safe payload is kept whole on the root.** Every span is built from the
 * same copy after access tokens and authentication header values are removed.
 * What is not captured cannot be recovered by a later migration, while a
 * credential that was captured would already be a leak.
 *
 * **A payload this cannot fully read is still written.** `degraded` says so,
 * the root span still lands, whatever parsed is on it, and the safe provider
 * document is intact — so a conversation Retell shaped in a way egma has not
 * met yet costs a flag rather than a hole in somebody's monitoring, and the
 * poller's cursor moves past it instead of grinding on it forever.
 */

/** What Retell's own document is called where egma names it. */
export type RetellCall = Readonly<Record<string, unknown>>;

export type NormalisedTrace = {
  readonly traceId: string;
  readonly providerCallId: string;
  /**
   * When this conversation ended, as the one place that question is answered.
   * Where the provider reported no end at all this is a stand-in, and
   * `endReported` is what says which of the two it is.
   */
  readonly endedAt: Date;
  /**
   * Whether `endedAt` is the provider's own answer or egma's stand-in for one.
   *
   * **The poller's cursor moves only on a reported end.** A cursor is the claim
   * *everything at or before this is stored*, and a stand-in is a wall-clock
   * reading rather than a fact about the conversation — so honouring it would
   * jump the cursor to now and silently drop everything between the old cursor
   * and that moment if the sweep then stopped. The conversation is still
   * stored, flagged degraded; only the cursor declines to believe it.
   */
  readonly endReported: boolean;
  /** True when something in the payload could not be read. Never fatal. */
  readonly degraded: boolean;
  readonly spans: readonly NewSpan[];
};

/** What the normalizer is told about where a conversation is being filed. */
export type NormaliseInto = {
  readonly projectId: string;
  readonly environment: string | null;
  readonly platformAgentId: string;
  readonly platformAgentName: string;
  readonly platformAgentVersion: string;
};

/**
 * The trace identity, minted deterministically from the provider's call id and
 * the project.
 *
 * **Deterministic is the whole point**: a retry, a historical import, and a
 * recreated Monitoring setup must agree on identity without stored connection
 * state. So the id is a function of the project and the provider's call id,
 * and the ledger's unique constraint does the rest.
 *
 * **The project is in it because of fan-out.** The same Retell call can be
 * monitored in two Egma projects, and each project owns its own visible trace.
 * Recreating a Monitoring setup or rotating its key inside one project must not
 * create a second trace for that same provider call.
 *
 * Thirty-two hex characters, which is the shape a trace id has in this store —
 * the same 128 bits OpenTelemetry writes, so every trace reader sees one shared
 * identity shape.
 */
export function traceIdFor(projectId: string, callId: string): string {
  return createHash("sha256")
    .update(`egma:retell:trace\n${projectId}\n${callId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * A span id inside one trace: sixteen hex characters, derived from the trace
 * and the span's own place in it.
 *
 * Derived rather than random so a replay after a crash produces the same
 * byte-identical block. ClickHouse can suppress that recent retry. This is not
 * a global or permanent duplicate guarantee.
 */
function spanIdFor(traceId: string, within: string): string {
  return createHash("sha256")
    .update(`egma:retell:span\n${traceId}\n${within}`)
    .digest("hex")
    .slice(0, 16);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A number Retell reports, or `undefined` for one it did not. */
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Retell counts milliseconds since the epoch; this store counts microseconds. */
function microseconds(milliseconds: number): bigint {
  return BigInt(Math.trunc(milliseconds)) * 1000n;
}

/**
 * Where a conversation sits in time, as far as the provider is willing to say —
 * **and the only place that question is answered.**
 *
 * Everything that needs to know when a conversation ended reads this: the
 * spans' own instants, the ledger's `ended_at`, the cursor, and the order the
 * poller writes a page in. It used to be answered in two places that disagreed
 * — the normalizer stood in the wall clock for a payload with no timestamps
 * while the poller's own reader answered zero for the same call — and two
 * answers to when something happened is one answer too many for anything that
 * keeps a cursor.
 *
 * `reported` is the load-bearing half. It says whether this instant came from
 * the provider or from egma standing in for one, which is what lets a cursor
 * decline to move on a guess.
 */
export function endInstantOf(call: RetellCall): {
  readonly at: number | undefined;
  readonly reported: boolean;
} {
  const ended = number(call["end_timestamp"]);
  if (ended !== undefined) return { at: ended, reported: true };
  // A call with a start and no end is one egma can still file, at the only
  // instant it was told about — but not one whose end anybody reported.
  return { at: number(call["start_timestamp"]), reported: false };
}

/**
 * The two ends of the conversation, in milliseconds, and never in the wrong
 * order.
 *
 * **The span's duration is `endedAt - startedAt` and the column it lands in is
 * unsigned**, so a payload whose end precedes its start cannot be allowed to
 * produce one: the store refuses the whole batch, the claim stays unwritten,
 * and the sweep that replays it hits the same refusal on every tick for ever.
 * One clock-skewed conversation would stop all later Monitoring imports.
 *
 * So a contradictory pair is a degraded payload like any other: it is filed at
 * the instant the provider called the end, with no duration, flagged, and with
 * both original timestamps intact in the safe provider payload. The same is
 * true of a call reporting only one of the two.
 *
 * A call reporting neither is filed at the moment egma read it — honest (egma
 * heard about this now) and findable in a window somebody would actually ask
 * for — and it is exactly the case `reported` exists to keep away from the
 * cursor.
 */
function extent(call: RetellCall, now: number): {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly whole: boolean;
  readonly reported: boolean;
} {
  const started = number(call["start_timestamp"]);
  const end = endInstantOf(call);
  const at = end.at ?? now;

  if (started === undefined || end.at === undefined || end.at < started) {
    // One instant, used for both ends: no duration is claimed, because none was
    // honestly reported, and the arithmetic can never come out negative.
    return { startedAt: at, endedAt: at, whole: false, reported: end.reported };
  }

  return {
    startedAt: started,
    endedAt: end.at,
    whole: true,
    reported: end.reported,
  };
}

/** One spoken entry in Retell's current woven transcript. */
type Turn = {
  readonly kind: "turn:human" | "turn:agent";
  readonly text: string;
  readonly startedAfterNanoseconds: bigint | undefined;
  readonly durationNanoseconds: bigint | undefined;
};

type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
  readonly successful: boolean | undefined;
  readonly parentTurn: number | null;
};

type Transcript = {
  readonly turns: readonly Turn[];
  readonly toolCalls: readonly ToolCall[];
  readonly whole: boolean;
};

const NANOSECONDS_PER_SECOND = 10 ** 9;

/** Retell word bounds, measured from the start of the call. */
function reportedTimingIn(row: Readonly<Record<string, unknown>>): {
  readonly startedAfterNanoseconds: bigint;
  readonly durationNanoseconds: bigint;
} | undefined {
  const words = row["words"];
  if (!Array.isArray(words) || words.length === 0) return undefined;

  const bounds = words.flatMap((word) => {
    if (typeof word !== "object" || word === null || Array.isArray(word)) return [];
    const held = word as Record<string, unknown>;
    const start = number(held["start"]);
    const end = number(held["end"]);
    return start === undefined || end === undefined || start < 0 || end < start
      ? []
      : [{ start, end }];
  });
  const first = bounds[0];
  const last = bounds.at(-1);
  if (first === undefined || last === undefined || last.end < first.start) {
    return undefined;
  }

  const startedAfterNanoseconds = BigInt(
    Math.round(first.start * NANOSECONDS_PER_SECOND),
  );
  const endedAfterNanoseconds = BigInt(
    Math.round(last.end * NANOSECONDS_PER_SECOND),
  );
  return {
    startedAfterNanoseconds,
    durationNanoseconds: endedAfterNanoseconds - startedAfterNanoseconds,
  };
}

function spokenTurnIn(
  row: Readonly<Record<string, unknown>>,
  role: "user" | "agent",
): Turn {
  const timing = reportedTimingIn(row);
  return {
    kind: role === "user" ? "turn:human" : "turn:agent",
    text: text(row["content"]),
    startedAfterNanoseconds: timing?.startedAfterNanoseconds,
    durationNanoseconds: timing?.durationNanoseconds,
  };
}

function spokenTurnsIn(value: unknown): {
  readonly turns: readonly Turn[];
  readonly whole: boolean;
} {
  if (value === undefined || value === null) return { turns: [], whole: true };
  if (!Array.isArray(value)) return { turns: [], whole: false };

  const turns: Turn[] = [];
  let whole = true;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      whole = false;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const role = text(row["role"]);
    if (role !== "user" && role !== "agent") {
      // Retell also reports transfers, node transitions, DTMF, SMS, injected
      // context, and new event kinds. They remain in the safe provider data.
      // None of them gives Egma permission to invent a speaker turn.
      continue;
    }
    turns.push(spokenTurnIn(row, role));
  }
  return { turns, whole };
}

function toolSuccessIn(call: RetellCall): ReadonlyMap<string, boolean> {
  const summaries = call["tool_calls"];
  if (!Array.isArray(summaries)) return new Map();

  const successes = new Map<string, boolean>();
  for (const summary of summaries) {
    if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
      continue;
    }
    const row = summary as Record<string, unknown>;
    const id = text(row["tool_call_id"]);
    if (id !== "" && typeof row["success"] === "boolean") {
      successes.set(id, row["success"]);
    }
  }
  return successes;
}

/**
 * Spoken turns and tools from Retell's current woven transcript.
 *
 * Tool invocation and result entries are separate and can have other provider
 * events between them. Their `tool_call_id` is the relationship Retell states,
 * so it is the only relationship used here. Position gives the preceding
 * spoken turn, when one exists; a tool before all speech stays under the root.
 *
 * A provider that does not supply the woven form can still supply spoken turns
 * through `transcript_object`. Egma does not read the retired nested tool-call
 * assumption from that fallback.
 */
function turnsIn(call: RetellCall): Transcript {
  const woven = call["transcript_with_tool_calls"];
  if (woven === undefined || woven === null) {
    const fallback = spokenTurnsIn(call["transcript_object"]);
    return { ...fallback, toolCalls: [] };
  }
  if (!Array.isArray(woven)) {
    return { turns: [], toolCalls: [], whole: false };
  }

  type Pair = {
    id: string;
    name: string;
    arguments: string;
    result: string;
    successful: boolean | undefined;
    firstAt: number;
    invocationAt: number | undefined;
    parentTurn: number | null;
  };

  const turns: Turn[] = [];
  const pairs = new Map<string, Pair>();
  let whole = true;

  for (const [at, entry] of woven.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      whole = false;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const role = text(row["role"]);
    if (role === "user" || role === "agent") {
      turns.push(spokenTurnIn(row, role));
      continue;
    }

    if (role === "tool_call_invocation" || role === "tool_call_result") {
      const id = text(row["tool_call_id"]);
      if (id === "") {
        whole = false;
        continue;
      }
      const pair = pairs.get(id) ?? {
        id,
        name: "",
        arguments: "",
        result: "",
        successful: undefined,
        firstAt: at,
        invocationAt: undefined,
        parentTurn: turns.length === 0 ? null : turns.length - 1,
      };
      if (role === "tool_call_invocation") {
        if (pair.invocationAt !== undefined) whole = false;
        pair.invocationAt = at;
        pair.name = text(row["name"]);
        pair.arguments = text(row["arguments"]);
        pair.parentTurn = turns.length === 0 ? null : turns.length - 1;
      } else {
        pair.result = text(row["content"]);
        const success = row["successful"] ?? row["success"];
        if (typeof success === "boolean") {
          pair.successful = success;
        }
      }
      pairs.set(id, pair);
      continue;
    }

    // A known non-spoken event or a role Retell adds later remains in the root
    // payload. It is not malformed merely because Egma has no typed span for it.
  }

  const reportedSuccess = toolSuccessIn(call);
  const toolCalls = [...pairs.values()]
    .sort(
      (left, right) =>
        (left.invocationAt ?? left.firstAt) -
        (right.invocationAt ?? right.firstAt),
    )
    .map(
      (pair): ToolCall => ({
        id: pair.id,
        name: pair.name,
        arguments: pair.arguments,
        result: pair.result,
        successful: pair.successful ?? reportedSuccess.get(pair.id),
        parentTurn: pair.parentTurn,
      }),
    );

  return { turns, toolCalls, whole };
}

/** Whether a full Get Call document can be normalized without inventing facts. */
export function retellCallDocumentIsComplete(call: RetellCall): boolean {
  return (
    text(call["call_id"]) !== "" &&
    extent(call, 0).whole &&
    turnsIn(call).whole
  );
}

/**
 * What Retell measured about the whole conversation, gathered onto the root.
 *
 * Retell reports one object per stage — `e2e`, `llm`, `tts` and the rest — each
 * holding its own summary (`p50`, `p90`, `p95`, `p99`, `min`, `max`, `num`)
 * beside `values`, the individual measurements the summary was worked out from.
 * They describe the call rather than any moment in it, so the root span is the
 * only honest place for them. This keeps the whole object under the vendor's
 * own names, unchanged, which is where a reader who knows Retell will look; the
 * translation into egma's vocabulary is `reportedLatencyOf` below, and it reads
 * `values` alone.
 */
function latencyOf(call: RetellCall): Record<string, unknown> {
  const held = call["latency"];
  return typeof held === "object" && held !== null && !Array.isArray(held)
    ? (held as Record<string, unknown>)
    : {};
}

/**
 * What this agent platform is called wherever egma names it: the span fact on
 * every row it files, the prefix on a measure only Retell has a word for, and
 * the reporter's name on the block. One spelling, in one place.
 */
const RETELL = "retell";

/**
 * What a stage egma has no catalog name for is counted in.
 *
 * The fallback only. A measure the catalog names takes the catalog's own unit,
 * below, because a unit stated twice is a unit that comes to disagree — and a
 * bound is read in whichever one the reader believed.
 */
const MILLISECONDS = "milliseconds";

/**
 * A catalog name, refused if the catalog has stopped saying it.
 *
 * The measure catalog owns the names egma computes and graders can use, and this
 * table is the one place a vendor's word is bound to one of them. A rename in
 * the catalog with no rename here would leave Retell's numbers stored under a
 * measure nothing reads — green, silent, and wrong, which is the exact failure
 * the catalog exists to prevent. The sibling OTLP normalizer takes the same
 * rule the other way round, by reading its span names out of the catalog rather
 * than listing them again; a mapping cannot do that, so it says so instead, at
 * the moment the table is built and loudly enough to stop a build.
 */
function catalogNamed(measure: string): string {
  if (!isSpanDerivedMeasure(measure)) {
    throw new Error(
      `the measure catalog no longer names \`${measure}\`, so Retell's own ` +
        `measurements would be reported under a measure nothing computes or ` +
        `grades — rename it here in the same breath as the catalog`,
    );
  }
  return measure;
}

/**
 * Which of Retell's latency stages is which measure, and the only place that
 * mapping is written down.
 *
 * **Same meaning, same name.** Retell's `e2e` is what the measure catalog calls
 * `turn_response_latency` — how long the agent took to answer — so it is
 * reported under the catalog's own name, so every reader sees the same metric
 * for Retell and for traces Egma measures itself. A stage the catalog has no
 * counterpart for keeps a
 * platform-prefixed name rather than a forced fit: the numbers are captured
 * now, surfaced when a display asks for them, and promoted to a catalog name
 * the day a second platform proves the general shape.
 *
 * Ordered, because the block's bytes are: the order here is the order the
 * measurements are written in, and a replay has to produce the identical batch.
 */
const REPORTED_LATENCY_MEASURES: readonly (readonly [
  stage: string,
  measure: string,
])[] = [
  ["e2e", catalogNamed("turn_response_latency")],
  ["llm", `${RETELL}/llm_latency`],
  ["tts", `${RETELL}/tts_latency`],
  ["asr", `${RETELL}/asr_latency`],
  ["knowledge_base", `${RETELL}/knowledge_base_latency`],
];

/**
 * Retell's own measurements as the neutral reported-measurements block, or
 * `undefined` where Retell reported none worth carrying.
 *
 * **This is the only code that knows Retell's shape.** The block it builds is
 * one contract for every platform, so the shared measure module — on the day it
 * reads this block — reads a single shape for all of them, and the next
 * platform is one more mapping table in its own normalizer rather than a second
 * parser under the shared metric arithmetic.
 *
 * **The individual measurements, never the summary.** Each stage's `values` are
 * the measurements themselves, so "every measurement holds the bound, the worst
 * turn decides" stays truthful and percentile math stays egma's own. A p50
 * carried as a measurement would let one summarised turn pass a bound a real
 * turn failed.
 *
 * Read defensively, because this is a vendor document: a stage that is missing,
 * a `values` that is not a list, and an entry inside one that is not a finite
 * number are each simply not there. A stage left with nothing is dropped, and a
 * call whose every stage is dropped writes no block at all — absence being the
 * honest shape for a conversation nobody measured.
 *
 * **A measurement that is not a number is dropped silently, and that is the
 * deliberate line.** `degraded` is raised for a payload egma could not read as
 * a conversation — no id, contradictory instants, a transcript that is not one
 * — because that is a trace somebody has to look at. One unreadable entry in a
 * stage's list is not: the rest of the list is still true, the vendor's whole
 * document is still on the row after credential removal, and flagging the
 * trace would spend somebody's attention on a number egma never needed.
 */
function reportedLatencyOf(
  call: RetellCall,
): Record<string, unknown> | undefined {
  const stages = latencyOf(call);
  const measurements: ReportedMeasurement[] = [];

  for (const [stage, measure] of REPORTED_LATENCY_MEASURES) {
    const held = stages[stage];
    if (typeof held !== "object" || held === null || Array.isArray(held)) continue;
    const values = (held as Record<string, unknown>)["values"];
    if (!Array.isArray(values)) continue;
    // In the order Retell reported them, which is the order they happened in.
    const kept = values.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
    // Never an empty list: the contract says a measurement holds at least one
    // number, and a stage that reported none is a stage nobody reported.
    if (kept.length === 0) continue;
    measurements.push({
      measure,
      // The catalog's own unit for a measure it names, so a bound and a
      // measurement are read in one unit; the platform's honest word for a
      // stage it does not name.
      unit: catalogedMeasure(measure)?.unit ?? MILLISECONDS,
      values: kept,
    });
  }

  return reportedMeasurementsPayload(RETELL, measurements);
}

/** One span with every field stated, including the empty ones. */
function span(
  fields: Partial<NewSpan> &
    Pick<
      NewSpan,
      | "traceId"
      | "spanId"
      | "name"
      | "kind"
      | "startedAtMicroseconds"
      | "payload"
    >,
): NewSpan {
  return {
    parentSpanId: "",
    source: "production",
    emitter: "agent",
    environment: "default",
    durationNanoseconds: 0n,
    status: "ok",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    connectionKind: "",
    runId: "",
    agentId: "",
    agentPlatform: "",
    platformAgentId: "",
    platformAgentName: "",
    platformAgentVersion: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    // Only the root span of a call Retell reported an end for says otherwise,
    // and it says so in so many words. Every turn and every tool call inside a
    // conversation is mid-conversation by construction.
    endsTrace: false,
    ...fields,
  };
}

/**
 * One Retell call object as the spans that will be filed for it.
 *
 * `now` is injected so a payload with no timestamps normalises to the same
 * spans twice. A deterministic replay keeps the block byte-identical. Nothing
 * else in here reads a clock.
 */
export function normaliseRetellCall(
  call: RetellCall,
  into: NormaliseInto,
  now: number,
): NormalisedTrace {
  const safeCall = safeRetellProviderData(call);
  const providerCallId = text(safeCall["call_id"]);
  const traceId = traceIdFor(into.projectId, providerCallId);

  const times = extent(safeCall, now);
  const transcript = turnsIn(safeCall);
  // A conversation with no id of its own is the one thing that cannot be
  // repaired — the identity would be the project's alone, and every such
  // call would collide with the last one. It still lands, because the store's
  // rule is that nothing is dropped, and it lands flagged.
  const degraded =
    providerCallId === "" || !times.whole || !transcript.whole;

  const startedAt = microseconds(times.startedAt);
  const endedAt = microseconds(times.endedAt);
  const environment = into.environment ?? "default";
  const reported = reportedLatencyOf(safeCall);
  const callStatus = text(safeCall["call_status"]);
  const providerFailed =
    callStatus === "error" || callStatus === "not_connected";

  const shared = {
    traceId,
    source: "production" as const,
    emitter: "agent" as const,
    environment,
    providerCallId,
    connectionKind: "",
    agentId: "",
    agentPlatform: RETELL,
    platformAgentId: into.platformAgentId,
    platformAgentName: into.platformAgentName,
    platformAgentVersion: into.platformAgentVersion,
  };

  const rootId = spanIdFor(traceId, "root");
  const spans: NewSpan[] = [
    span({
      ...shared,
      spanId: rootId,
      // Empty, which is how a root is recognised everywhere in this store.
      // Recognising a root is not the same fact as knowing a conversation
      // ended, and this span carries the second one separately.
      parentSpanId: "",
      name: "retell_call",
      kind: "conversation",
      /*
       * Retell's own answer, and only Retell's.
       *
       * `endReported` is the same fact the poller's cursor already refuses to
       * move without: `true` means the provider named an end timestamp for this
       * call, and `false` means Egma stood in a plausible instant because the
       * payload carried none. The two must not be confused — a call still in
       * progress reads back with a start and no end, and treating that as an
       * ending would close a conversation while the caller is still talking.
       *
       * It was already computed here and already surfaced on the normalised
       * trace; carrying it onto the span is what lets everything downstream of
       * storage read the platform's statement instead of inferring one from
       * this span having no parent.
       */
      endsTrace: times.reported,
      startedAtMicroseconds: startedAt,
      durationNanoseconds: (endedAt - startedAt) * 1000n,
      status: degraded || providerFailed ? "error" : "ok",
      // Retell's own word for why the conversation ended, and its own
      // aggregates, on the one span they describe.
      text: text(safeCall["disconnection_reason"]),
      // egma copies no audio: the reference is the provider's link, and it
      // renders as the listen affordance.
      audioUrl: text(safeCall["recording_url"]),
      payload: JSON.stringify({
        ...safeCall,
        egma_normalised: {
          degraded,
          disconnection_reason: text(safeCall["disconnection_reason"]),
          latency: latencyOf(safeCall),
          // Under the contract's own key, never a spelling of egma's own: the
          // read side looks the block up by the same constant. Absent rather
          // than empty where Retell measured nothing, so a reader meets the
          // same shape a payload nobody wrote has.
          ...(reported === undefined
            ? {}
            : { [REPORTED_MEASUREMENTS_PAYLOAD_KEY]: reported }),
        },
      }),
    }),
  ];

  const turnIds: string[] = [];
  for (const [index, turn] of transcript.turns.entries()) {
    const turnId = spanIdFor(traceId, `turn/${index}`);
    turnIds.push(turnId);
    spans.push(
      span({
        ...shared,
        spanId: turnId,
        parentSpanId: rootId,
        name: turn.kind === "turn:human" ? "human_turn" : "agent_turn",
        kind: turn.kind,
        // Retell reports word bounds relative to the call start. Where it does
        // not, keep the prior honest fallback: call start and zero duration.
        startedAtMicroseconds:
          startedAt + (turn.startedAfterNanoseconds ?? 0n) / 1000n,
        durationNanoseconds: turn.durationNanoseconds ?? 0n,
        text: turn.text,
        // BigInt timing belongs in typed span fields and cannot be JSON encoded.
        payload: JSON.stringify({ kind: turn.kind, text: turn.text }),
      }),
    );
  }

  for (const [index, invocation] of transcript.toolCalls.entries()) {
    spans.push(
      span({
        ...shared,
        spanId: spanIdFor(traceId, `tool/${index}`),
        parentSpanId:
          invocation.parentTurn === null
            ? rootId
            : (turnIds[invocation.parentTurn] ?? rootId),
        name: invocation.name === "" ? "tool" : invocation.name,
        kind: "tool",
        startedAtMicroseconds: startedAt,
        status: invocation.successful === false ? "error" : "ok",
        toolName: invocation.name,
        toolArguments: invocation.arguments,
        toolResult: invocation.result,
        payload: JSON.stringify(invocation),
      }),
    );
  }

  return {
    traceId,
    providerCallId,
    endedAt: new Date(times.endedAt),
    endReported: times.reported,
    degraded,
    spans,
  };
}
