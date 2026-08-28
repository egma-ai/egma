"""The conversation, authored as OpenTelemetry spans.

One ``SpanEmitter`` serves one simulation. Everything a conductor
observes — each turn with who said it and what was said, each tool call
the platform reported, each measurement — becomes a span, stamped when it
happened and handed to a flush as an ordinary OTLP export document. On the wire that
document is what any exporter would send, which is the whole point of
speaking OTLP: a simulation arrives at the same ingest door a customer's
agent posts to, and is the same shape at rest.

What the platform and this emitter agree on is written down once, in
``packages/simulation-contract/span-vocabulary.md``, and pinned as golden
fixtures beside it: the scope, the span names, the attribute keys, and how
a batch names the simulation it is evidence of. Nothing here may drift
from that document without the fixtures failing on both sides.

**Delivery is not this module's business.** A flush hands the document to
whoever built the emitter, and the reporter puts it through the same
write-ahead log and the same single ordered sender the lifecycle documents
ride — which is what makes a resend byte-identical and puts every span on
the wire before the terminal document leaves. That ordering is the whole
design: when the control plane records a terminal transition, the evidence
is already stored.

Two things follow from that and shape everything below.

**OpenTelemetry authors the record.** The process-wide SDK mints every span id,
tracks parents, and serializes the export. Its one identity adapter gives a
parentless simulation root the trace id already derived from the simulation id,
so the simulation, conversation, and grades can find each other without a
mapping. A retry replays the already-serialized bytes; conducting the same
conversation again creates new span ids and therefore new evidence.

**Timestamps say when the thing happened**, never when it was sent. A
timing span is named for the measure it takes and its own duration *is*
the number, so it is opened one measurement before the moment it was
taken. A turn is opened for as long as it was spoken — one instant on
chat, where a message has no duration, and ear to ear on voice. Two turns
may cross in time: that is how barge-in is represented now that the
persona is full-duplex, and the shape always permitted it rather
than being widened later.

**Where a turn's two ends come from depends on who conducted it.** Chat's
walk observes a turn at one moment and this stamps it there, which is the
whole truth about a message that was never spoken. A voice conductor knows
both ends before it says anything, because it read them off the audio
itself, and hands both over — see :meth:`SpanEmitter.spoken_turn`. Only
the second is exact enough for turns that cross, and every voice
simulation goes through it.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from contextvars import Token

from opentelemetry import context as context_api
from opentelemetry.context import Context
from opentelemetry.trace import Span, set_span_in_context

from . import telemetry
from .telemetry import (
    ActiveSimulation,
    activate,
    activate_root_trace_id,
    deactivate,
    deactivate_root_trace_id,
    trace_id_for,
    tracer,
)
from .telemetry import flush as flush_provider

SERVICE_NAME = telemetry.SERVICE_NAME
SIMULATION_ID_ATTRIBUTE = telemetry.SIMULATION_ID_ATTRIBUTE

SCOPE_NAME = "egma-simulator"
SCOPE_VERSION = "1"
"""The instrumentation scope every Egma-authored span rides, and the contract
version it speaks. The ingest is gated on the name, so another framework that
happens to call something ``agent_turn`` is never read as this one."""

ROOT_SPAN = "simulation"
RECORDING_SPAN = "recording"
TOOL_CALL_SPAN = "tool_call"
TURN_SPAN_OF = {"human": "human_turn", "agent": "agent_turn"}
"""The transcript's two labels, exactly. The speaker rides the span name,
so there is no second field free to disagree with it."""

TURN_TEXT_ATTRIBUTE = "egma.turn.text"
TURN_PLATFORM_NOTES_ATTRIBUTE = "egma.turn.platform_notes"
"""What the platform said about one turn that nobody said in it.

A node transition announced mid-answer, a message in a role egma has never
seen. It is agent-side content and it is not speech, so it rides beside
the words instead of inside them: the persona is handed the words back,
and one scenario's chat and voice transcripts are only comparable while
neither carries something nobody spoke.

Carried as a JSON array of strings, in the order the platform said them.
Absent for every turn that has none, which is nearly all of them.
"""
TOOL_NAME_ATTRIBUTE = "egma.tool.name"
TOOL_ARGUMENTS_ATTRIBUTE = "egma.tool.arguments"
TOOL_RESULT_ATTRIBUTE = "egma.tool.result"
TOOL_PROVENANCE_ATTRIBUTE = "egma.tool.provenance"
MOCK_TOOL_ATTRIBUTE = "egma.tool.mock_tool"
TOOL_LATE_ATTACHED_ATTRIBUTE = "egma.tool.late_attached"

MOCKED_PROVENANCE = "mocked"
"""How the call was answered: a mock tool answered, and egma served it.

A result never rides without this, because a result with nothing to say
where it came from would read as a return value egma observed rather than
one it authored.
"""

REFUSED_PROVENANCE = "refused"
"""How the call was answered: egma was asked and said no.

The agent called a tool egma had told it egma answers for nothing of —
a protocol error, refused on the wire and never waved through. It carries
no result, because there was none, and no mock tool, because none
answered.

**It is a provenance and not an absence, and that is the whole reason it
exists.** An absent stamp means the call was observed and not answered —
a connection egma stands outside the tool path of, where the real tool
ran. A refusal is the opposite fact: egma *was* in the path, and the tool
did not run. Written the same way, a reader could not tell a refused call
from a real backend quietly doing the work.
"""

_NANOSECONDS_PER_MILLISECOND = 1_000_000

Flush = Callable[[bytes], None]
"""What an emitter does with a finished document: hand it to delivery."""

Clock = Callable[[], int]
"""Wall-clock nanoseconds since the epoch, which is what OTLP timestamps
are. Injected so a test can hold time still."""


class SpanEmitter:
    """Authors one simulation's spans and hands them over in flushes."""

    def __init__(
        self,
        simulation_id: str,
        *,
        flush: Flush,
        clock: Clock = time.time_ns,
    ) -> None:
        self.simulation_id = simulation_id
        self.trace_id = trace_id_for(simulation_id)
        self._flush = flush
        self._clock = clock
        self._tracer = tracer(SCOPE_NAME, SCOPE_VERSION)
        self._active: ActiveSimulation | None = None
        self._active_token: Token[ActiveSimulation | None] | None = None
        self._span_token: Token[Context] | None = None
        self._root: Span | None = None
        self._root_context: Context | None = None
        self._root_ended = False
        self._sealed = False

    def _author(
        self,
        name: str,
        *,
        started_unix_nano: int,
        ended_unix_nano: int,
        attributes: dict[str, str | bool] | None = None,
    ) -> Span:
        if self._root_context is None:
            raise RuntimeError("a span cannot be authored before the simulation opens")
        span = self._tracer.start_span(
            name,
            context=self._root_context,
            start_time=started_unix_nano,
            attributes=attributes,
        )
        span.end(end_time=ended_unix_nano)
        return span

    # -- What a conductor observes ---------------------------------------------

    def opened(self) -> None:
        """Start and attach the SDK root inherited by Pipecat pipeline tasks."""
        if self._active is not None:
            raise RuntimeError("a simulation span emitter can only be opened once")

        active, active_token = activate(self.simulation_id, self._flush)
        self._active = active
        self._active_token = active_token
        try:
            # An explicit empty context makes this the parentless root. The
            # provider's IdGenerator supplies its simulation-derived trace id.
            root_id_token = activate_root_trace_id(active)
            try:
                root = self._tracer.start_span(
                    ROOT_SPAN,
                    context=Context(),
                    start_time=self._clock(),
                )
            finally:
                deactivate_root_trace_id(root_id_token)
            root_context = set_span_in_context(root, Context())
            self._root = root
            self._root_context = root_context
            self._span_token = context_api.attach(root_context)
        except Exception:
            deactivate(active, active_token, discard=True)
            self._active = None
            self._active_token = None
            raise

    def turn(
        self, speaker: str, text: str, platform_notes: tuple[str, ...] = ()
    ) -> None:
        """One transcript turn, by whichever of the two speakers took it.

        One instant, which is the whole truth about a message: chat is
        where this is used and a message has no duration. A turn that was
        *spoken* has two ends read off the audio, and it comes through
        :meth:`spoken_turn` instead.

        ``platform_notes`` is what the platform said about the turn that
        nobody said in it, and it rides its own attribute rather than the
        words for the reason :data:`TURN_PLATFORM_NOTES_ATTRIBUTE` gives.
        """
        name = TURN_SPAN_OF.get(speaker)
        if name is None:
            raise ValueError(f"a turn was taken by {speaker!r}, who is not a speaker")

        attributes: dict[str, str | bool] = {TURN_TEXT_ATTRIBUTE: text}
        if platform_notes:
            # Only ever when there is something to say. An empty list on
            # every other turn would be a field a reader learns nothing
            # from finding.
            attributes[TURN_PLATFORM_NOTES_ATTRIBUTE] = json.dumps(
                list(platform_notes), separators=(",", ":"), ensure_ascii=False
            )
        now = self._clock()
        self._author(
            name,
            started_unix_nano=now,
            ended_unix_nano=now,
            attributes=attributes,
        )

    def spoken_turn(
        self,
        speaker: str,
        text: str,
        *,
        began_unix_nano: int,
        ended_unix_nano: int,
    ) -> None:
        """One transcript turn whose both ends are already known.

        The turn above is one instant on the wall clock, which is exact
        enough only for a message nobody spoke. Giving a spoken turn its
        length by subtracting the audio's duration from the moment the
        turn was observed would make "did these two turns overlap" a
        question about when Python happened to run.

        So a conductor that knows both ends says both, and says them from
        the audio itself. What arrives here is already the answer — two
        instants on the conversation's own clock, converted once from
        sample positions — and this authors the span and nothing else.
        """
        name = TURN_SPAN_OF.get(speaker)
        if name is None:
            raise ValueError(f"a turn was taken by {speaker!r}, who is not a speaker")
        self._author(
            name,
            started_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
            attributes={TURN_TEXT_ATTRIBUTE: text},
        )

    def recording(self, *, started_unix_nano: int) -> None:
        """Place audio sample zero on the same trace clock as spoken turns.

        The WAV is stored separately, but its origin is trace evidence: every
        spoken turn already uses this instant plus its media position. One
        zero-duration span carries that shared origin without copying it onto
        the simulation lifecycle row.
        """
        self._author(
            RECORDING_SPAN,
            started_unix_nano=started_unix_nano,
            ended_unix_nano=started_unix_nano,
        )

    def measured(
        self, measure: str, *, began_unix_nano: int, ended_unix_nano: int
    ) -> None:
        """One measurement whose interval is already known, both ends.

        :meth:`measure` takes a number and brackets it against the wall
        clock. This takes the interval instead, for the same reason
        :meth:`spoken_turn` exists: a voice measure is read off the
        conversation's audio, and the two instants that bracket it are
        the measurement rather than a rendering of it.
        """
        self._author(
            measure,
            started_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
        )

    def tool_call(self, name: str, arguments: str | None) -> None:
        """A tool call, as observed from egma's side of the connection.

        One instant: the platform reports the invocation, not its span, and
        stretching it over a guess would be inventing a fact nobody
        measured. Nothing of the answer is recorded for the same reason —
        egma did not see it. A call egma *answered* is a different story
        and goes through :meth:`tool_exchange`.
        """
        now = self._clock()
        self.tool_exchange(
            name,
            arguments=arguments,
            began_unix_nano=now,
            ended_unix_nano=now,
        )

    def tool_exchange(
        self,
        name: str,
        *,
        arguments: str | None = None,
        answer: str | None = None,
        mock_tool: str | None = None,
        late_attached: bool = False,
        refused: bool = False,
        began_unix_nano: int,
        ended_unix_nano: int,
    ) -> None:
        """One tool call, bracketed by the exchange egma conducted.

        Where egma *answered* the call, the two ends are the moment the
        call arrived and the moment the answer went back — the round trip
        plus whatever delay the mock tool declared — so a declared delay
        is readable as the time it really took and no attribute repeats
        the number for the two to disagree about.

        **A result never rides without its provenance.** The rule that
        looks like an exception — never record half an exchange nobody
        observed — is about the *agent's* return values, which egma does
        not see. An answer egma itself served is not observed, it is
        authored, and recording it invents nothing. So the two travel
        together or not at all, and this refuses to write one without the
        other rather than leaving the record to be read two ways.

        **A refused call is stamped too, and for the mirror reason.** No
        result, no mock tool — nothing answered it — but egma was in the
        path and said no, and an unstamped span says the opposite: that
        the call went past egma to a real backend. Two facts that far
        apart may not share one shape.
        """
        if (answer is None) != (mock_tool is None):
            raise ValueError(
                "a tool call's result and the mock tool that served it are "
                "one fact: an answer with nothing to say where it came from "
                "would read as a result Egma observed rather than authored"
            )
        if refused and answer is not None:
            raise ValueError(
                "a refused call is one Egma would not answer, so it cannot "
                "carry an answer: the two stamps describe opposite halves of "
                "the same moment and only one of them happened"
            )
        if late_attached and answer is None:
            # The flag says a tool the census never named was *served*
            # anyway. On a call nothing served, it would be a caveat about
            # arguments nobody was answered about — a stamp with no fact
            # under it.
            raise ValueError(
                "late-attached is a caveat about a call Egma served for a "
                "tool the census never named, so it has nothing to qualify "
                "on a call Egma did not answer"
            )
        attributes: dict[str, str | bool] = {TOOL_NAME_ATTRIBUTE: name}
        if arguments is not None:
            attributes[TOOL_ARGUMENTS_ATTRIBUTE] = arguments
        if answer is not None and mock_tool is not None:
            attributes[TOOL_RESULT_ATTRIBUTE] = answer
            attributes[TOOL_PROVENANCE_ATTRIBUTE] = MOCKED_PROVENANCE
            attributes[MOCK_TOOL_ATTRIBUTE] = mock_tool
        elif refused:
            attributes[TOOL_PROVENANCE_ATTRIBUTE] = REFUSED_PROVENANCE
        if late_attached:
            # Only ever true. A stamp for the ordinary case would ride
            # every span, and a reader would learn nothing from finding it.
            attributes[TOOL_LATE_ATTACHED_ATTRIBUTE] = True
        self._author(
            TOOL_CALL_SPAN,
            started_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
            attributes=attributes,
        )

    def measure(self, measure: str, milliseconds: float) -> None:
        """One measurement, as the span whose duration *is* the number.

        The span is named for the measure and closed at the moment the
        measurement was taken, opening one measurement earlier — so its
        start and end bracket the interval that was measured, in
        nanoseconds, with nothing to disagree with.
        """
        ended = self._clock()
        self._author(
            measure,
            started_unix_nano=ended
            - int(milliseconds * _NANOSECONDS_PER_MILLISECOND),
            ended_unix_nano=ended,
        )

    # -- Handing them over ----------------------------------------------------

    def flush(self) -> None:
        """Ask the process-wide provider to export this task's ended spans."""
        if self._active is None:
            raise RuntimeError("a simulation cannot flush before it opens")
        flush_provider()

    def sealed(self) -> None:
        """Close the conversation: everything left, with the root last.

        Called once, before the terminal lifecycle document is minted, so
        that the one ordered sender puts every span ahead of it.
        """
        if self._sealed:
            return
        if self._root is None:
            raise RuntimeError("a simulation cannot seal before it opens")
        if not self._root_ended:
            self._root.end(end_time=self._clock())
            self._root_ended = True
        # Cleanup happens only after the SDK has handed every ended span to
        # the reporter WAL. If that handoff fails, terminal delivery is
        # blocked and this route must still be released before another claim.
        try:
            flush_provider()
        except Exception:
            self.abort()
            raise
        self._sealed = True
        self._release(discard=False)

    def abort(self) -> None:
        """Release task-local tracing and discard anything not sealed."""
        if self._sealed or self._active is None:
            return
        self._release(discard=True)

    def _release(self, *, discard: bool) -> None:
        active = self._active
        active_token = self._active_token
        span_token = self._span_token
        if active is None or active_token is None:
            return
        try:
            if span_token is not None:
                context_api.detach(span_token)
        finally:
            deactivate(active, active_token, discard=discard)
            self._active = None
            self._active_token = None
            self._span_token = None
