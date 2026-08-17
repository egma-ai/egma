import { createHash } from "node:crypto";

import type { NewSpan } from "@egma/db";

/**
 * One Retell call object, as spans. The single place that reading happens.
 *
 * Both transports carry the same document — a webhook delivers it the moment a
 * conversation ends, the poller fetches it from the list API — so the transport
 * is delivery and nothing else, and this is what makes them agree. Two
 * transports that each read the payload for themselves would be two opinions
 * about what a conversation is, disagreeing the first day either changed.
 *
 * **Nothing here is synthesised.** Retell publishes no per-turn timing, so
 * there is no per-turn span: the turns come from the transcript, and every
 * latency figure Retell reports rides the root span as an attribute of the
 * whole conversation. The trace store's rule is verbatim — never write a span
 * egma did not observe — and a per-turn duration invented by dividing a total
 * would be exactly that, wearing a number that looks measured.
 *
 * **The payload is kept whole.** Every span carries the vendor's own document
 * verbatim, per the store's irreversible rule: what is not captured cannot be
 * recovered by any later migration, and a field egma has no place for today is
 * still there tomorrow.
 *
 * **A payload this cannot fully read is still written.** `degraded` says so,
 * the root span still lands, whatever parsed is on it, and the verbatim
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
  readonly connectionId: string;
  readonly connectionType: string;
  readonly agentId: string;
  readonly environment: string | null;
};

/**
 * The trace identity, minted deterministically from the provider's call id and
 * the connection.
 *
 * **Deterministic is the whole point**: two transports have to agree on
 * identity without talking to each other, and the only thing they share is the
 * document. So the id is a function of the document's own call id, and the
 * ledger's unique constraint does the rest.
 *
 * **The connection is in it because of fan-out.** The same Retell agent
 * registered in two projects is two connections, each filing its own copy into
 * its own project; without the connection in the identity the two copies would
 * collide on one trace id and one project would silently lose its conversation
 * to the other's ledger claim.
 *
 * Thirty-two hex characters, which is the shape a trace id has in this store —
 * the same 128 bits OpenTelemetry writes, so the ids the two ingest paths
 * produce are indistinguishable to every reader downstream.
 */
export function traceIdFor(connectionId: string, callId: string): string {
  return createHash("sha256")
    .update(`egma:retell:trace\n${connectionId}\n${callId}`)
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
 * One clock-skewed conversation would stop the deployment watching anything.
 *
 * So a contradictory pair is a degraded payload like any other: it is filed at
 * the instant the provider called the end, with no duration, flagged, and with
 * both original timestamps intact in the verbatim payload. The same is true of
 * a call reporting only one of the two.
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

/** One entry of Retell's `transcript_object`, as much as egma reads of it. */
type Turn = {
  readonly kind: "turn:human" | "turn:agent";
  readonly text: string;
  readonly toolCalls: readonly {
    readonly name: string;
    readonly arguments: string;
    readonly result: string;
  }[];
};

/**
 * The turns, from Retell's structured transcript.
 *
 * `transcript_object` rather than the flat `transcript` string, because the
 * structured one says who spoke and carries the tool invocations; splitting the
 * flat one on speaker labels would be egma guessing at a format Retell never
 * promised.
 *
 * A tool call rides the turn it happened in as a child span, which is where the
 * transcript surface already looks for one. Nothing about a tool call is
 * invented: the name, the arguments and the result are Retell's own, and a call
 * Retell reported without a result comes through with an empty one rather than
 * with a guess.
 */
function turnsIn(call: RetellCall): {
  readonly turns: readonly Turn[];
  readonly whole: boolean;
} {
  const held = call["transcript_object"];
  if (held === undefined || held === null) {
    // No structured transcript at all is not a malformed payload — a
    // conversation with nothing said in it is a real thing, and so is a Retell
    // account that has the field switched off.
    return { turns: [], whole: true };
  }
  if (!Array.isArray(held)) return { turns: [], whole: false };

  const turns: Turn[] = [];
  let whole = true;

  for (const entry of held) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      whole = false;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const role = text(row["role"]);
    if (role !== "user" && role !== "agent") {
      whole = false;
      continue;
    }

    const invocations = Array.isArray(row["tool_calls"])
      ? (row["tool_calls"] as unknown[])
      : [];
    const toolCalls: Turn["toolCalls"] = invocations.flatMap((invocation) => {
      if (
        typeof invocation !== "object" ||
        invocation === null ||
        Array.isArray(invocation)
      ) {
        whole = false;
        return [];
      }
      const held = invocation as Record<string, unknown>;
      // Retell nests the name and the arguments under `function`, as the
      // OpenAI tool-call shape does, and reports the answer beside it.
      const fn =
        typeof held["function"] === "object" && held["function"] !== null
          ? (held["function"] as Record<string, unknown>)
          : {};
      return [
        {
          name: text(fn["name"]) || text(held["name"]),
          arguments: text(fn["arguments"]) || text(held["arguments"]),
          result: text(held["result"]) || text(held["content"]),
        },
      ];
    });

    turns.push({
      kind: role === "user" ? "turn:human" : "turn:agent",
      text: text(row["content"]),
      toolCalls,
    });
  }

  return { turns, whole };
}

/**
 * What Retell measured about the whole conversation, gathered onto the root.
 *
 * These are aggregates — a p50, a p90, a maximum — and they describe the call
 * rather than any moment in it, so the root span is the only honest place for
 * them. Kept as the vendor's own names inside the root's payload, which is
 * where a reader who knows Retell will look; egma reads no meaning into them
 * here, because a measure egma computes is computed from spans by the one
 * shared measure module and never copied off a vendor's summary.
 */
function latencyOf(call: RetellCall): Record<string, unknown> {
  const held = call["latency"];
  return typeof held === "object" && held !== null && !Array.isArray(held)
    ? (held as Record<string, unknown>)
    : {};
}

/** One span with every field stated, including the empty ones. */
function span(fields: Partial<NewSpan> & Pick<NewSpan, "traceId" | "spanId" | "name" | "kind" | "startedAtMicroseconds" | "payload">): NewSpan {
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
    connectionType: "",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
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
  const providerCallId = text(call["call_id"]);
  const traceId = traceIdFor(into.connectionId, providerCallId);
  const payload = JSON.stringify(call);

  const times = extent(call, now);
  const transcript = turnsIn(call);
  // A conversation with no id of its own is the one thing that cannot be
  // repaired — the identity would be the connection's alone, and every such
  // call would collide with the last one. It still lands, because the store's
  // rule is that nothing is dropped, and it lands flagged.
  const degraded =
    providerCallId === "" || !times.whole || !transcript.whole;

  const startedAt = microseconds(times.startedAt);
  const endedAt = microseconds(times.endedAt);
  const environment = into.environment ?? "default";

  const shared = {
    traceId,
    source: "production" as const,
    emitter: "agent" as const,
    environment,
    providerCallId,
    connectionType: into.connectionType,
    agentId: into.agentId,
  };

  const rootId = spanIdFor(traceId, "root");
  const spans: NewSpan[] = [
    span({
      ...shared,
      spanId: rootId,
      // Empty, which is how a root is recognised everywhere in this store —
      // and how the grading bookkeeping learns the conversation is over.
      parentSpanId: "",
      name: "retell_call",
      kind: "conversation",
      startedAtMicroseconds: startedAt,
      durationNanoseconds: (endedAt - startedAt) * 1000n,
      status: degraded ? "error" : "ok",
      // Retell's own word for why the conversation ended, and its own
      // aggregates, on the one span they describe.
      text: text(call["disconnection_reason"]),
      // egma copies no audio: the reference is the provider's link, and it
      // renders as the listen affordance.
      audioUrl: text(call["recording_url"]),
      payload: JSON.stringify({
        ...call,
        egma_normalised: {
          degraded,
          disconnection_reason: text(call["disconnection_reason"]),
          latency: latencyOf(call),
        },
      }),
    }),
  ];

  for (const [index, turn] of transcript.turns.entries()) {
    const turnId = spanIdFor(traceId, `turn/${index}`);
    spans.push(
      span({
        ...shared,
        spanId: turnId,
        parentSpanId: rootId,
        name: turn.kind === "turn:human" ? "human_turn" : "agent_turn",
        kind: turn.kind,
        // Retell publishes no per-turn timing, so every turn opens at the
        // conversation's own start and lasts nothing. **That is the honest
        // answer**: a duration divided out of a total would look measured and
        // would not be, and the transcript surface was built to render a trace
        // whose child spans are sparse.
        startedAtMicroseconds: startedAt,
        text: turn.text,
        payload: JSON.stringify(turn),
      }),
    );

    for (const [at, invocation] of turn.toolCalls.entries()) {
      spans.push(
        span({
          ...shared,
          spanId: spanIdFor(traceId, `turn/${index}/tool/${at}`),
          parentSpanId: turnId,
          name: invocation.name === "" ? "tool" : invocation.name,
          kind: "tool",
          startedAtMicroseconds: startedAt,
          toolName: invocation.name,
          toolArguments: invocation.arguments,
          toolResult: invocation.result,
          payload: JSON.stringify(invocation),
        }),
      );
    }
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
