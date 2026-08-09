import type { Conversation } from "../conversation.ts";

/**
 * What a judge is shown, declared.
 *
 * **It is a declared set rather than "the conversation".** A judge reads the
 * transcript, how the conversation ended, the tools the agent called and what
 * was measured — four things, named here, assembled here, and nowhere else. The
 * point of writing them down is that adding a fifth is an edit to this file and
 * a line in the text below, rather than a new argument threaded through every
 * caller: the recording is the fifth, it is designed for and not built, and the
 * day it arrives it joins the type and the rendering and nothing else moves.
 *
 * **It carries no criterion, and that is structural.** The evidence is
 * assembled once per conversation and shared by every judge call made about it;
 * what each call is deciding travels beside it. So one behavior's text cannot
 * reach another behavior's judge — not because the fan-out is careful, but
 * because there is nowhere in this type for it to be.
 *
 * Text-only in v1. Nothing fixes the shape of what arrives here — telemetry is
 * written by whoever emitted it, and the columns a conversation falls back to
 * had no write door behind them — so everything here reads defensively and says
 * honestly when what it wanted is not there. An absent transcript is an empty
 * list, not a crash, and a judge shown an empty transcript answers that it
 * cannot determine anything, which is exactly right.
 */
export type JudgeInput = {
  /** In the order they were spoken, numbered from one. */
  readonly transcript: readonly Turn[];
  /** How the conversation ended, in the simulator's own words. */
  readonly outcome: Outcome;
  readonly toolCalls: readonly ToolCall[];
  /** What was measured. A metric measures; a grader judges. */
  readonly measures: readonly Measure[];
};

/**
 * One thing somebody said, and its number.
 *
 * The number is what a judgment cites, and it is the turn's position in the
 * transcript rather than anything the simulator minted: a position is a thing a
 * person reading the record can count to, and it is the same number in the text
 * the judge read and in the row the judgment lands in.
 */
export type Turn = {
  /** One-based, matching the transcript as it is shown. */
  readonly at: number;
  /** `agent`, `persona`, or whatever the simulator wrote. */
  readonly speaker: string;
  readonly text: string;
};

export type Outcome = {
  /**
   * Whether there was a conversation at all. False never reaches a judge — the
   * engine writes `errored` without asking anybody — and it is here because the
   * outcome is one fact and splitting it would let the two halves disagree.
   */
  readonly happened: boolean;
  /** The simulator's own word for why it ended, or null. */
  readonly endingReason: string | null;
  readonly turns: number;
};

export type ToolCall = {
  readonly tool: string;
  /** As the agent sent them, verbatim, or null when it sent none. */
  readonly arguments: string | null;
};

export type Measure = {
  readonly measure: string;
  /** One sample, or the whole series when the measure was taken per turn. */
  readonly samples: readonly number[];
};

/**
 * How a judgment points at a turn.
 *
 * The verdict row's column is `cited_span_ids`, and what a judgment cites is a
 * turn's **position** rather than the id of the span it came on. That is
 * deliberate on both sources: a judge is shown a numbered transcript and
 * answers with the numbers it read, so a position is the one reference that is
 * the same thing in the text the judge saw and in the row the judgment lands
 * in — and it is still readable for a conversation whose spans have aged out of
 * the store. The prefix is what lets a reader tell the two kinds apart without
 * knowing when the row was written.
 */
export const TURN_REFERENCE_PREFIX = "turn:";

export function turnReference(at: number): string {
  return `${TURN_REFERENCE_PREFIX}${at}`;
}

/**
 * The conversation, as the declared set. Everything defensive, because the
 * three columns are jsonb and a simulator that wrote something else must make a
 * judge say "I could not tell" rather than make the service fall over.
 */
export function judgeInputOf(conversation: Conversation): JudgeInput {
  const transcript = turnsOf(conversation.transcript);

  return {
    transcript,
    outcome: {
      // Always true by the time a judge is asked anything: a conversation with
      // nothing to judge is `errored` for every grader without a model being
      // called, so the one place this could be false never reaches here.
      happened: conversation.nothingToJudgeBecause === null,
      endingReason: conversation.endingReason,
      turns: transcript.length,
    },
    toolCalls: toolCallsOf(conversation.events),
    measures: measuresOf(conversation.metrics),
  };
}

function objectsOf(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/**
 * One field of a jsonb column as something somebody wrote, or `undefined` when
 * there is nothing there to read.
 *
 * **Blank is absent**, deliberately: a transcript entry holding an empty string
 * is a turn with nothing said in it, and a tool call event naming `""` names no
 * tool.
 *
 * Exported because the `tool_calls` grader reads the same column and has to see
 * the same tool calls a judge is shown. Two readings of one shapeless column
 * would be two answers to one question, and the way to stop that is one reading
 * rather than two careful ones.
 */
export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * The turns, numbered as they are shown.
 *
 * An entry with nothing said in it is dropped rather than numbered: a judge
 * citing turn 4 must be citing something a person can read, and a blank line in
 * the middle would shift every number after it away from what the judge saw.
 */
function turnsOf(transcript: unknown): readonly Turn[] {
  const said: Turn[] = [];
  for (const entry of objectsOf(transcript)) {
    // `kind` is present when the transcript was written as the event stream;
    // anything that is not a turn is not part of what was said.
    if (entry["kind"] !== undefined && entry["kind"] !== "turn") continue;
    const text = textOf(entry["text"]);
    if (text === undefined) continue;
    said.push({
      at: said.length + 1,
      speaker: textOf(entry["speaker"]) ?? "unknown",
      text,
    });
  }
  return said;
}

/** The tools the agent called, in the order the simulator recorded them. */
function toolCallsOf(events: unknown): readonly ToolCall[] {
  const called: ToolCall[] = [];
  for (const event of objectsOf(events)) {
    if (event["kind"] !== "tool_call") continue;
    const tool = textOf(event["name"]) ?? textOf(event["tool"]);
    if (tool === undefined) continue;
    const written = event["arguments"];
    called.push({
      tool,
      arguments:
        typeof written === "string"
          ? written
          : written === undefined || written === null
            ? null
            : JSON.stringify(written),
    });
  }
  return called;
}

/**
 * What was measured, read the way the threshold grader reads it: a value is one
 * number or a series of them, and anything else is a measure this conversation
 * does not have.
 */
function measuresOf(metrics: unknown): readonly Measure[] {
  if (
    typeof metrics !== "object" ||
    metrics === null ||
    Array.isArray(metrics)
  ) {
    return [];
  }

  const measured: Measure[] = [];
  for (const [measure, value] of Object.entries(metrics)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      measured.push({ measure, samples: [value] });
      continue;
    }
    if (!Array.isArray(value)) continue;
    const samples = value.filter(
      (sample): sample is number =>
        typeof sample === "number" && Number.isFinite(sample),
    );
    if (samples.length === value.length && samples.length > 0) {
      measured.push({ measure, samples });
    }
  }
  return measured;
}

/**
 * The declared set as the words a judge actually reads.
 *
 * One rendering, here, so that every provider is handed the same evidence and a
 * difference between two judges is a difference between two models rather than
 * between two prompt builders. Sections are labelled and a section with nothing
 * in it says so out loud — "no tool calls were recorded" is evidence, and an
 * absent heading would let a judge assume the tools were simply not shown.
 */
export function asJudgeReads(input: JudgeInput): string {
  const lines: string[] = ["## Transcript"];

  if (input.transcript.length === 0) {
    lines.push("(no transcript was recorded for this conversation)");
  } else {
    for (const turn of input.transcript) {
      lines.push(`[${turn.at}] ${turn.speaker}: ${turn.text}`);
    }
  }

  lines.push("", "## Outcome");
  lines.push(
    `the conversation ended ${input.outcome.endingReason ?? "for no recorded reason"}, after ${input.outcome.turns} turn${input.outcome.turns === 1 ? "" : "s"}`,
  );

  lines.push("", "## Tool calls");
  if (input.toolCalls.length === 0) {
    lines.push("(no tool calls were recorded)");
  } else {
    for (const call of input.toolCalls) {
      lines.push(`${call.tool}(${call.arguments ?? ""})`);
    }
  }

  lines.push("", "## Measures");
  if (input.measures.length === 0) {
    lines.push("(nothing was measured)");
  } else {
    for (const measure of input.measures) {
      lines.push(`${measure.measure}: ${measure.samples.join(", ")}`);
    }
  }

  return lines.join("\n");
}
