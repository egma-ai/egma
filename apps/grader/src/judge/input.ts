import type { Conversation } from "../conversation.ts";

/**
 * Text evidence for an LLM judge: transcript, tool calls, and metrics. Grading
 * instructions and expected behaviors travel separately in the question.
 * Validate untyped evidence and represent missing lists as empty arrays.
 */
export type JudgeInput = {
  /** In the order they were spoken, numbered from one. */
  readonly transcript: readonly Turn[];
  readonly toolCalls: readonly ToolCall[];
  /** What was measured. A metric measures; a grader judges. */
  readonly measures: readonly Measure[];
};

/** A transcript turn with a one-based position used in assertion citations. */
export type Turn = {
  /** One-based, matching the transcript as it is shown. */
  readonly at: number;
  /** The real evidence span, when the incoming transcript names it. */
  readonly spanId?: string;
  /** `agent`, `persona`, or whatever the simulator wrote. */
  readonly speaker: string;
  readonly text: string;
};

export type ToolCall = {
  readonly tool: string;
  /** As the agent sent them, verbatim, or null when it sent none. */
  readonly arguments: string | null;
};

/** Metric samples already computed by the shared measure module. */
export type Measure = {
  readonly measure: string;
  /** One sample, or the whole series when the measure was taken per turn. */
  readonly samples: readonly number[];
};

/** Build judge evidence defensively from untyped transcript and tool entries. */
export function judgeInputOf(conversation: Conversation): JudgeInput {
  const transcript = turnsOf(conversation.transcript);

  return {
    transcript,
    toolCalls: toolCallsOf(conversation.events),

    measures: conversation.measures.map(({ measure, samples }) => ({
      measure,
      // The judge receives values; the original metrics retain their evidence span IDs.
      samples: samples.map((sample) => sample.value),
    })),
  };
}

function objectsOf(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

/** Return a nonblank string unchanged, or undefined for absent or non-string input. */
export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Drop empty entries before numbering turns so citations match the rendered input. */
function turnsOf(transcript: unknown): readonly Turn[] {
  const said: Turn[] = [];
  for (const entry of objectsOf(transcript)) {
    // `kind` is present when the transcript was written as the event stream;
    // anything that is not a turn is not part of what was said.
    if (entry["kind"] !== undefined && entry["kind"] !== "turn") continue;
    const text = textOf(entry["text"]);
    if (text === undefined) continue;
    const spanId = textOf(entry["span_id"]);
    said.push({
      at: said.length + 1,
      ...(spanId === undefined ? {} : { spanId }),
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
 * Render the same evidence for every judge. Keep empty-section labels so
 * the model can distinguish missing evidence from omitted input.
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
