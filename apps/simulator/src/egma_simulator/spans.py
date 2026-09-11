"""Emit simulation observations as OTLP spans using the shared span vocabulary.
One SpanEmitter serves one simulation; the reporter owns durable ordered delivery.

The OpenTelemetry SDK creates span IDs and parents. A parentless simulation
root receives the trace ID derived from its simulation ID. Retries replay serialized
bytes; conducting again creates new span IDs.

Timestamps describe observations, not export time. Chat turns occupy one instant;
voice turns use audio-derived start and end times and can overlap. A measurement
span's duration is its value.

The agent SDK reports LiveKit tool calls. Only platform-reported calls are emitted
here, without invented duration. Display derives mock coverage from the pinned
test version. See packages/simulation-contract/span-vocabulary.md and its fixtures.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from contextvars import Token
from typing import Protocol

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
from .usage import ProviderUsage, as_json

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
"""Non-speech platform notes, stored as an ordered JSON array beside turn text.
Omit when empty; do not add them to the transcript the persona reads.
"""
PROVIDER_USAGE_SPAN = "provider_usage"
"""One provider request Egma made, and what it consumed.

The bill rides the span path because the span path already promises the three
things a bill needs: ordered delivery, arrival ahead of the terminal report,
and byte-identical resends. The span id frozen into those bytes *is* the
record's identity on the platform's side — so a replayed flush collapses onto
one row, while a conversation conducted again receives new span ids and is
correctly charged again.
"""

USAGE_PROVIDER_ATTRIBUTE = "egma.usage.provider"
USAGE_MODEL_ATTRIBUTE = "egma.usage.model"
USAGE_OPERATION_ATTRIBUTE = "egma.usage.operation"
USAGE_MEASUREMENT_ATTRIBUTE = "egma.usage.measurement"
USAGE_PROVIDER_REF_ATTRIBUTE = "egma.usage.provider_ref"
USAGE_QUANTITIES_ATTRIBUTE = "egma.usage.quantities"
USAGE_RAW_ATTRIBUTE = "egma.usage.raw"

TOOL_NAME_ATTRIBUTE = "egma.tool.name"
TOOL_ARGUMENTS_ATTRIBUTE = "egma.tool.arguments"
TOOL_RESULT_ATTRIBUTE = "egma.tool.result"

_NANOSECONDS_PER_MILLISECOND = 1_000_000

Flush = Callable[[bytes], None]
"""What an emitter does with a finished document: hand it to delivery."""

Clock = Callable[[], int]


class _InterruptionEvidence(Protocol):
    event: str
    at_unix_nano: int
    scheduled_for_unix_nano: int | None
    began_unix_nano: int | None
    ended_unix_nano: int | None
    overlap_ended_unix_nano: int | None
    reason: str | None
    generated_text: str | None
    delivered_text: str | None
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
        """Record a chat turn at one instant, with platform notes in a separate
        attribute.
        Use spoken_turn() when audio provides both endpoints.
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
        platform_notes: tuple[str, ...] = (),
    ) -> None:
        """Record a voice turn using its audio-derived start and end times.
        Do not infer either endpoint from when Python received the observation.
        """
        name = TURN_SPAN_OF.get(speaker)
        if name is None:
            raise ValueError(f"a turn was taken by {speaker!r}, who is not a speaker")
        attributes = {TURN_TEXT_ATTRIBUTE: text}
        if platform_notes:
            attributes[TURN_PLATFORM_NOTES_ATTRIBUTE] = json.dumps(
                list(platform_notes), separators=(",", ":"), ensure_ascii=False
            )
        self._author(
            name,
            started_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
            attributes=attributes,
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

    def interruption(self, evidence: _InterruptionEvidence) -> None:
        """Record one deliberate-interruption lifecycle event on the trace."""
        event = evidence.event
        at = evidence.at_unix_nano
        attributes: dict[str, object] = {"egma.interruption.event": event}
        for field_name in (
            "scheduled_for_unix_nano",
            "began_unix_nano",
            "ended_unix_nano",
            "overlap_ended_unix_nano",
            "reason",
            "generated_text",
            "delivered_text",
        ):
            value = getattr(evidence, field_name)
            if value is not None:
                attributes[f"egma.interruption.{field_name}"] = value
        self._author(
            "persona_interruption",
            started_unix_nano=at,
            ended_unix_nano=at,
            attributes=attributes,
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

    def tool_call(
        self,
        name: str,
        *,
        arguments: str | None = None,
        answer: str | None = None,
        at_unix_nano: int,
    ) -> None:
        """Record a platform-reported tool call at one instant without invented
        duration.
        Include an answer only when Egma authored one for that name. Display derives
        mock coverage from the pinned test version; no duplicate flag is stored here.
        """
        attributes: dict[str, str | bool] = {TOOL_NAME_ATTRIBUTE: name}
        if arguments is not None:
            attributes[TOOL_ARGUMENTS_ATTRIBUTE] = arguments
        if answer is not None:
            attributes[TOOL_RESULT_ATTRIBUTE] = answer
        self._author(
            TOOL_CALL_SPAN,
            started_unix_nano=at_unix_nano,
            ended_unix_nano=at_unix_nano,
            attributes=attributes,
        )

    def provider_usage(
        self, usage: ProviderUsage, funding_receipt: str | None = None
    ) -> None:
        """One provider request's bill, as the instant the provider answered.

        Zero duration, deliberately. How long a request took is a timing fact
        and Pipecat's own service spans already carry it; a second interval
        here would be a second answer to one question. What this span is for is
        the *quantity*, and the moment it was incurred — which is what decides
        the price it is rated at.

        A request that consumed nothing is not written: a bill for nothing is
        a row a reader learns nothing from.
        """
        if not usage.measured_anything:
            return
        attributes: dict[str, str | bool] = {
            USAGE_PROVIDER_ATTRIBUTE: usage.provider,
            USAGE_MODEL_ATTRIBUTE: usage.model,
            USAGE_OPERATION_ATTRIBUTE: usage.operation,
            USAGE_MEASUREMENT_ATTRIBUTE: usage.measurement,
            USAGE_QUANTITIES_ATTRIBUTE: as_json(usage.quantities),
        }
        if funding_receipt:
            attributes["egma.usage.funding_receipt"] = funding_receipt
        if usage.provider_ref:
            attributes[USAGE_PROVIDER_REF_ATTRIBUTE] = usage.provider_ref
        if usage.raw:
            # The provider's own object, whole. Absent where the provider
            # returned none, rather than an empty object pretending it did.
            attributes[USAGE_RAW_ATTRIBUTE] = as_json(usage.raw)
        now = self._clock()
        self._author(
            PROVIDER_USAGE_SPAN,
            started_unix_nano=now,
            ended_unix_nano=now,
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
            started_unix_nano=ended - int(milliseconds * _NANOSECONDS_PER_MILLISECOND),
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
