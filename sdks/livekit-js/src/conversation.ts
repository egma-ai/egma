import { voice } from "@livekit/agents";
import { context, trace, type Context, type Tracer } from "@opentelemetry/api";
import {
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";

const RESPONSE_TEXT = "lk.pii.response.text";

/** Adds committed speech that LiveKit does not include in its native turn spans. */
export class ConversationCollector implements SpanProcessor {
  private readonly roots = new Map<string, Context>();
  private readonly nativeTurns = new WeakSet<object>();
  private readonly attached = new WeakSet<voice.AgentSession>();
  private readonly tracer: Tracer;

  constructor(tracer: Tracer) {
    this.tracer = tracer;
  }

  onStart(span: Span, parentContext: Context): void {
    if (span.instrumentationScope.name !== "livekit-agents") return;
    if (span.name === "agent_session") {
      this.roots.set(
        span.spanContext().traceId,
        trace.setSpan(parentContext, span),
      );
    } else if (span.name === "agent_turn") {
      this.nativeTurns.add(span);
    }
  }

  onEnd(span: ReadableSpan): void {
    this.nativeTurns.delete(span);
    if (
      span.name === "agent_session" &&
      span.instrumentationScope.name === "livekit-agents"
    ) {
      this.roots.delete(span.spanContext().traceId);
    }
  }

  async shutdown(): Promise<void> {
    this.roots.clear();
  }

  async forceFlush(): Promise<void> {}

  attach(session: voice.AgentSession): void {
    if (this.attached.has(session)) return;
    this.attached.add(session);
    const seen = new Set<string>();
    const speeches = new Set<voice.SpeechHandle>();
    const speechDone = (speech: voice.SpeechHandle): void => {
      speeches.delete(speech);
    };
    const speechCreated = ({ speechHandle }: voice.SpeechCreatedEvent): void => {
      speeches.add(speechHandle);
      speechHandle.addDoneCallback(speechDone);
    };
    const conversationItemAdded = (
      { item }: voice.ConversationItemAddedEvent,
    ): void => {
      if (
        item.type !== "message" ||
        item.role !== "assistant" ||
        seen.has(item.id)
      ) return;
      seen.add(item.id);
      const text = item.textContent;
      if (text === undefined || text.trim() === "") return;

      const active = trace.getSpan(context.active());
      // Native replies attach their committed item to the speech before this event.
      // say() can inherit a native turn's context, so span ancestry alone is not enough.
      if (
        active !== undefined && this.nativeTurns.has(active) &&
        [...speeches].some((speech) =>
          speech.chatItems.some((one) => one.id === item.id),
        )
      ) return;

      const root = this.roots.get(active?.spanContext().traceId ?? "") ??
        (this.roots.size === 1 ? this.roots.values().next().value : undefined);
      if (root === undefined) return;
      const startedAt = seconds(item.metrics.startedSpeakingAt) ??
        finite(item.createdAt) ?? Date.now();
      const endedAt = Math.max(
        startedAt,
        seconds(item.metrics.stoppedSpeakingAt) ?? startedAt,
      );
      this.tracer.startSpan(
        "conversation_item",
        {
          startTime: startedAt,
          attributes: {
            "egma.conversation_item.id": item.id,
            "egma.conversation_item.role": "assistant",
            "egma.conversation_item.interrupted": item.interrupted,
            [RESPONSE_TEXT]: text,
          },
        },
        root,
      ).end(endedAt);
    };
    session.on(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      conversationItemAdded,
    );
    session.once(voice.AgentSessionEventTypes.Close, () => {
      session.off(voice.AgentSessionEventTypes.SpeechCreated, speechCreated);
      session.off(
        voice.AgentSessionEventTypes.ConversationItemAdded,
        conversationItemAdded,
      );
      for (const speech of speeches) speech.removeDoneCallback(speechDone);
      speeches.clear();
      seen.clear();
    });
  }
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function seconds(value: number | undefined): number | undefined {
  const number = finite(value);
  return number === undefined ? undefined : number * 1_000;
}
