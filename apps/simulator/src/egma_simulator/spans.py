"""The conversation, authored as OpenTelemetry spans.

One ``SpanEmitter`` serves one simulation. Everything the walk observes —
each turn with who said it and what was said, each tool call the platform
reported, each measurement — becomes a span, stamped when it happened and
handed to a flush as an ordinary OTLP export document. On the wire that
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

**Ids are minted here, once, and never re-derived.** A span id is minted
when the span is authored and travels with it; a resend replays the same
bytes, so the store's id-keyed dedup lands nothing twice. The trace id is
derived from the simulation id deterministically, so a conversation's
spans and its verdicts can always find each other without either side
having stored a mapping.

**Timestamps say when the thing happened**, never when it was sent. A
timing span is named for the measure it takes and its own duration *is*
the number, so it is opened one measurement before the moment it was
taken. A turn is opened for as long as it was spoken — one instant on
chat, where a message has no duration, and ear to ear on voice. Two turns
may cross in time: that is how barge-in is represented now that the
persona is a full-duplex caller, and the shape always permitted it rather
than being widened later.

**Where a turn's two ends come from depends on who conducted it.** Chat's
walk observes a turn at one moment and this stamps it there. A voice
conductor knows both ends before it says anything, because it read them
off the audio itself, and hands both over — see :meth:`SpanEmitter.spoken_turn`.
Only the second is exact enough for turns that cross, and only the first
is available where nothing was ever spoken.
"""

from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

SERVICE_NAME = "egma-simulator"
"""What a well-formed OpenTelemetry resource calls itself. It decides
nothing: the ingest recognises this vocabulary by its scope."""

SCOPE_NAME = "egma-simulator"
SCOPE_VERSION = "1"
"""The instrumentation scope every span rides, and the contract version it
speaks. The ingest is gated on the name, so another framework that happens
to call something ``agent_turn`` is never read as this one."""

SIMULATION_ID_ATTRIBUTE = "egma.simulation_id"
"""How a resource names the simulation its spans are evidence of. Echoed
verbatim from the claimed spec — opaque, never rewritten."""

ROOT_SPAN = "simulation"
TOOL_CALL_SPAN = "tool_call"
TURN_SPAN_OF = {"human": "human_turn", "agent": "agent_turn"}
"""The transcript's two labels, exactly. The speaker rides the span name,
so there is no second field free to disagree with it."""

TURN_TEXT_ATTRIBUTE = "egma.turn.text"
TOOL_NAME_ATTRIBUTE = "egma.tool.name"
TOOL_ARGUMENTS_ATTRIBUTE = "egma.tool.arguments"

SPAN_KIND = "SPAN_KIND_INTERNAL"
"""Every span here is work this process did itself. Nothing egma emits is a
client or server span: the conversation is not an RPC."""

_CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_EGMA_SIMULATION_ID = re.compile(r"^sim_([0-9A-HJKMNP-TV-Z]{26})$")

_NANOSECONDS_PER_SECOND = 1_000_000_000
_NANOSECONDS_PER_MILLISECOND = 1_000_000

Flush = Callable[[dict], None]
"""What an emitter does with a finished document: hand it to delivery."""

Clock = Callable[[], int]
"""Wall-clock nanoseconds since the epoch, which is what OTLP timestamps
are. Injected so a test can hold time still."""


def trace_id_for(simulation_id: str) -> str:
    """The trace a simulation's spans belong to, as 32 lowercase hex.

    egma's own ids carry 128 bits of their own — 26 Crockford base32
    characters after ``sim_``, which is a ULID — and those bits *are* the
    trace, so ``sim_01K3XQ7M4E8YB2FVN0H9TZQWER`` is trace
    ``0198fb73d08e479627eea08a75fbf1d8``, always and on both sides.

    The contract calls a simulation id opaque, though — never parsed,
    never minted, never rewritten — so this cannot depend on the id being
    egma's own shape. An id that is not gets a digest of itself instead:
    still 128 bits, still the same answer every time, still different for
    every id. What it is not is reversible, which nothing needs.
    """
    egma_shaped = _EGMA_SIMULATION_ID.match(simulation_id)
    if egma_shaped is not None:
        value = 0
        for character in egma_shaped.group(1):
            value = (value << 5) | _CROCKFORD_ALPHABET.index(character)
        # 26 base32 characters hold 130 bits, so a value can be wider than a
        # trace id is. egma's own ids never are — the top bits of a ULID's
        # millisecond field are zero for the next eight thousand years — and
        # one that somehow were would be silently truncated, which is worse
        # than being digested like any other id this did not recognise.
        if value < 1 << 128:
            return format(value, "032x")
    return hashlib.blake2b(simulation_id.encode(), digest_size=16).hexdigest()


def span_id_for(trace_id: str, sequence: int) -> str:
    """One span's own id: 16 hex characters, unique inside its trace.

    Derived rather than random, so that the bytes a flush carries are a
    function of what happened and nothing else — the same conversation
    replayed mints the same ids, which is what a store deduping on them
    needs, and what makes a document a test can pin.
    """
    digest = hashlib.blake2b(
        f"{trace_id}:{sequence}".encode(), digest_size=8
    )
    return digest.hexdigest()


@dataclass
class _Span:
    """One authored span, held until its flush."""

    span_id: str
    name: str
    started_unix_nano: int
    ended_unix_nano: int
    attributes: dict[str, str] = field(default_factory=dict)

    def as_otlp(self, *, trace_id: str, parent_span_id: str | None) -> dict:
        document: dict = {
            "traceId": trace_id,
            "spanId": self.span_id,
        }
        if parent_span_id is not None:
            document["parentSpanId"] = parent_span_id
        document |= {
            "name": self.name,
            "kind": SPAN_KIND,
            "startTimeUnixNano": str(self.started_unix_nano),
            "endTimeUnixNano": str(self.ended_unix_nano),
        }
        if self.attributes:
            document["attributes"] = [
                {"key": key, "value": {"stringValue": value}}
                for key, value in self.attributes.items()
            ]
        return document


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
        self._sequence = 0
        # Minted first and sent last. Every other span names it, so it has
        # to exist before any of them; it leaves in the final flush, when
        # the conversation is over and everything else is already on the
        # wire.
        self._root = _Span(
            span_id=self._mint(), name=ROOT_SPAN, started_unix_nano=0, ended_unix_nano=0
        )
        self._pending: list[_Span] = []
        self._open_turn: dict[str, _Span] = {}
        """A turn authored before anything measured how long it was spoken
        for — the persona's own words, which are decided a moment before
        they are said. It stays open until the flush that carries it."""
        self._unspoken_for: dict[str, float] = {}
        """The other order: audio measured before its words are known,
        which is every turn the agent takes, since it is heard and then
        read. Spent by the next turn that speaker takes."""
        self._sealed = False

    def _mint(self) -> str:
        self._sequence += 1
        return span_id_for(self.trace_id, self._sequence)

    def _author(
        self,
        name: str,
        *,
        started_unix_nano: int,
        ended_unix_nano: int,
        attributes: dict[str, str] | None = None,
    ) -> _Span:
        span = _Span(
            span_id=self._mint(),
            name=name,
            started_unix_nano=started_unix_nano,
            ended_unix_nano=ended_unix_nano,
            attributes=attributes or {},
        )
        self._pending.append(span)
        return span

    # -- What the walk observes ----------------------------------------------

    def opened(self) -> None:
        """The conversation began. Stamps the root's start and nothing else."""
        self._root.started_unix_nano = self._clock()

    def turn(self, speaker: str, text: str) -> None:
        """One transcript turn, by whichever of the two speakers took it.

        A turn is one instant unless something measured how long it was
        spoken for — which on chat nothing ever does, because a message has
        no duration. On voice the audio says, and it arrives on either side
        of this call: the agent's is heard before it is read, and the
        persona's is said after it is decided. Both are joined by
        :meth:`spoke`, and a turn nobody timed is left the instant it
        honestly was rather than given a made-up length.
        """
        name = TURN_SPAN_OF.get(speaker)
        if name is None:
            raise ValueError(f"a turn was taken by {speaker!r}, who is not a speaker")

        now = self._clock()
        spoken_seconds = self._unspoken_for.pop(speaker, None)
        began = (
            now
            if spoken_seconds is None
            else now - int(spoken_seconds * _NANOSECONDS_PER_SECOND)
        )
        span = self._author(
            name,
            started_unix_nano=began,
            ended_unix_nano=now,
            attributes={TURN_TEXT_ATTRIBUTE: text},
        )
        if spoken_seconds is None:
            self._open_turn[speaker] = span

    def spoken_turn(
        self,
        speaker: str,
        text: str,
        *,
        began_unix_nano: int,
        ended_unix_nano: int,
    ) -> None:
        """One transcript turn whose both ends are already known.

        The turn above is authored from the wall clock, which is exact
        enough only while turns cannot cross: it stamps the end at the
        moment the turn was observed and derives the start by subtracting
        however long the audio ran. Under full duplex that would make
        "did these two turns overlap" a question about when Python
        happened to run.

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

    def spoke(self, speaker: str, seconds: float) -> None:
        """How long one side's audio ran for one turn, ear to ear.

        Voice only, and the one fact a transcript cannot carry. It reaches
        the turn it belongs to whichever way round the two were observed.
        """
        span = self._open_turn.pop(speaker, None)
        if span is None:
            self._unspoken_for[speaker] = seconds
            return
        span.started_unix_nano = span.ended_unix_nano - int(
            seconds * _NANOSECONDS_PER_SECOND
        )

    def tool_call(self, name: str, arguments: str | None) -> None:
        """A tool call, as observed from egma's side of the connection.

        One instant: the platform reports the invocation, not its span, and
        stretching it over a guess would be inventing a fact nobody
        measured. There is no result attribute for the same reason.
        """
        attributes = {TOOL_NAME_ATTRIBUTE: name}
        if arguments is not None:
            attributes[TOOL_ARGUMENTS_ATTRIBUTE] = arguments
        now = self._clock()
        self._author(
            TOOL_CALL_SPAN,
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
            started_unix_nano=ended
            - int(milliseconds * _NANOSECONDS_PER_MILLISECOND),
            ended_unix_nano=ended,
        )

    # -- Handing them over ----------------------------------------------------

    def flush(self) -> None:
        """Send everything authored since the last flush, and nothing else.

        A span is authored once and drained once, so no two flushes ever
        carry the same id — which is what lets a resend be at-least-once
        while the store lands nothing twice.
        """
        self._hand_over(self._pending)
        self._pending = []
        self._forget_unjoined_audio()

    def sealed(self) -> None:
        """Close the conversation: everything left, with the root last.

        Called once, before the terminal lifecycle document is minted, so
        that the one ordered sender puts every span ahead of it.
        """
        if self._sealed:
            return
        self._sealed = True
        self._root.ended_unix_nano = self._clock()
        self._hand_over([*self._pending, self._root])
        self._pending = []
        self._forget_unjoined_audio()

    def _forget_unjoined_audio(self) -> None:
        """End of an exchange: nothing measured in it reaches the next one.

        A turn still waiting on its own length has left — nothing can widen
        a span already on the wire, so it stays the instant it honestly
        was — and a length that never found its turn is dropped rather than
        given to whoever speaks next.
        """
        self._open_turn.clear()
        self._unspoken_for.clear()

    def _hand_over(self, spans: list[_Span]) -> None:
        if not spans:
            return
        self._flush(
            {
                "resourceSpans": [
                    {
                        "resource": {
                            "attributes": [
                                {
                                    "key": "service.name",
                                    "value": {"stringValue": SERVICE_NAME},
                                },
                                {
                                    "key": SIMULATION_ID_ATTRIBUTE,
                                    "value": {"stringValue": self.simulation_id},
                                },
                            ]
                        },
                        "scopeSpans": [
                            {
                                "scope": {
                                    "name": SCOPE_NAME,
                                    "version": SCOPE_VERSION,
                                },
                                "spans": [
                                    span.as_otlp(
                                        trace_id=self.trace_id,
                                        parent_span_id=(
                                            None
                                            if span is self._root
                                            else self._root.span_id
                                        ),
                                    )
                                    for span in spans
                                ],
                            }
                        ],
                    }
                ]
            }
        )
