"""Phone backends create a Pipecat transport, dial, wait for an answer, and clean up.
The transport owns audio frames, conversion, buffering, and pacing.
Keep credentials out of output. Only declined or unanswered calls are
not_answered; connection and carrier faults are error.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import import_module
from typing import Protocol

from pipecat.frames.frames import (
    AudioRawFrame,
    ControlFrame,
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    UninterruptibleFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from ..contract import ERROR, NOT_ANSWERED

BACKENDS = {
    "livekit": ("livekit", "LiveKitBackend"),
    "scripted": ("scripted", "ScriptedBackend"),
}
"""Every media backend, by name: the module in this package that holds
it, and the class inside it. One entry per driver and nothing else — the
registry below reads this, so adding a bridge really is one line.

The entries are names rather than classes because a deployment that never
dials a phone must not pay for a bridge's client library, and a library
that is never imported is one that cannot reach the network on its own.
The quarantine suite holds both halves of that.
"""


class MediaBackendError(Exception):
    """A media backend cannot do what was asked, and says what happened.

    ``ending`` is which of the contract's failed endings the refusal
    deserves — :data:`NOT_ANSWERED` when the far end did not come on the
    line, :data:`ERROR` for everything else. The plug carries both up,
    and the record ends up with the honest one of the two.
    """

    def __init__(self, reason: str, *, ending: str = ERROR) -> None:
        super().__init__(reason)
        self.ending = ending


NOT_ANSWERED_STATUSES = frozenset({408, 410, 480, 486, 487, 600, 603, 604})
"""SIP statuses classified as an unanswered or declined call.
Other statuses are connection or carrier faults.
"""


def sip_refusal(
    status_code: int | None, status: str | None = None, *, told: str = ""
) -> MediaBackendError:
    """One carrier refusal, in the carrier's own words, with its ending.

    ``told`` is whatever else the bridge said about it — already scrubbed
    of this driver's secrets by its caller, because words quoted from
    somebody else are not the quoter's to trust.
    """
    if status_code in NOT_ANSWERED_STATUSES:
        ending, what = NOT_ANSWERED, "the call was not answered"
    else:
        ending, what = ERROR, "the call could not be placed"
    said = " ".join(
        part for part in (str(status_code) if status_code else "", status) if part
    )
    named = f"{what}: the carrier answered {said}" if said else what
    return MediaBackendError(f"{named}{f'; {told}' if told else ''}", ending=ending)


@dataclass
class RemoteParticipantLeftFrame(ControlFrame, UninterruptibleFrame):
    """An ordered marker placed after a remote participant's final audio."""

    completed: asyncio.Event


TRANSPORT_ARRIVAL = "egma.transport_arrival"
"""When one inbound frame's first sample reached the transport.

Seconds on the transport's own clock. A real transport reads its clock
off the wall; a scripted one carries a media clock of its own. Either
way the two directions are stamped from the same clock, so the recording
they make is one timeline.
"""

TRANSPORT_PLAYOUT = "egma.transport_playout"
"""When one outbound frame's first sample is heard at the far end.

The transport paces what it is handed: audio written while earlier audio
is still playing waits its turn. This is where the frame lands after
that wait, not when the speech leg made it.
"""


def arrived_at(frame: object, seconds: float) -> None:
    """Say when this inbound frame's first sample reached the transport."""
    _stamp(frame, TRANSPORT_ARRIVAL, seconds)


def arrived_now(frame: AudioRawFrame) -> None:
    """Say that this inbound frame has just finished arriving.

    A real-time transport reads its clock once the frame is whole, so
    the instant it reads is the frame's *last* sample. The stamp names
    the first, which is that instant less the frame's own length. Getting
    this backwards charges the recording one frame per frame, and the
    charge lands on every latency read off it.
    """
    arrived_at(frame, time.monotonic() - frame.num_frames / frame.sample_rate)


def played_out_at(frame: object, seconds: float) -> None:
    """Say when this outbound frame's first sample is heard at the far end."""
    _stamp(frame, TRANSPORT_PLAYOUT, seconds)


def _stamp(frame: object, named: str, seconds: float) -> None:
    metadata = getattr(frame, "metadata", None)
    if not isinstance(metadata, dict):
        raise MediaBackendError(
            f"a {type(frame).__name__} reached the recording with nowhere to "
            "carry its transport time"
        )
    metadata[named] = float(seconds)


def transport_time(frame: object, named: str) -> float | None:
    """One of the two transport times, or ``None`` if nobody stamped it."""
    metadata = getattr(frame, "metadata", None)
    if not isinstance(metadata, dict):
        return None
    stamped = metadata.get(named)
    return float(stamped) if isinstance(stamped, (int, float)) else None


class PlayoutClock:
    """Track playout time after already-queued audio.
    cleared resets the queue after interruption so the next frame starts immediately.
    """

    def __init__(self) -> None:
        self._playing_through: float | None = None

    def place(self, now: float, seconds: float) -> float:
        """Where the next ``seconds`` of audio start, and take that room."""
        waiting = self._playing_through
        start = now if waiting is None or waiting < now else waiting
        self._playing_through = start + seconds
        return start

    def cleared(self) -> None:
        """The transport dropped whatever it had not played yet."""
        self._playing_through = None


class PlayoutStamp(FrameProcessor):
    """Observe audio after the transport output processor and calculate queued playout
    time.
    Report interruptions so the recording discards audio removed before playback.
    """

    def __init__(self) -> None:
        super().__init__()
        self._playout = PlayoutClock()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame):
            played_out_at(
                frame,
                self._playout.place(
                    time.monotonic(), frame.num_frames / frame.sample_rate
                ),
            )
        elif isinstance(frame, InterruptionFrame):
            played_out_at(frame, time.monotonic())
            self._playout.cleared()
        await self.push_frame(frame, direction)


@dataclass(frozen=True)
class VoiceMedia:
    """The Pipecat processors and lifecycle signals for one voice connection.

    The transport owns frames, conversion, buffering, and pacing.  A plug
    gives these processors to the voice conductor once; it never exchanges
    PCM bytes with the conductor itself. ``ended`` means the remote agent
    left normally. ``failed`` means the media path itself was lost.
    """

    input: tuple[object, ...]
    output: tuple[object, ...]
    ended: asyncio.Event
    failed: asyncio.Event = field(default_factory=asyncio.Event)
    transport_name: str = "voice transport"
    input_recorded: Callable[[object], None] = lambda _frame: None
    real_time: bool = True
    """Whether the times this transport stamps are the wall clock's.

    A transport that carries a call runs on the clock everybody else
    reads, so the recording it makes can say what time its first sample
    was. A scripted far end keeps a media clock of its own, which counts
    the audio it has written rather than the seconds that have passed,
    and a wall-clock instant read off it would be a made-up one.
    """


class MediaBackend(Protocol):
    """One outbound call, from opening the way in to hanging up."""

    async def create_transport(self) -> VoiceMedia: ...

    async def dial(self, number: str) -> None: ...

    async def wait_answered(self, seconds: float) -> str: ...

    async def teardown(self) -> None: ...


BackendFactory = Callable[..., MediaBackend]
"""A backend class called with settings, config, and caller id."""


def backend_for(name: str) -> BackendFactory | None:
    """The driver registered under one backend name, or ``None``.

    Only the named driver's module is imported, which is what keeps a
    simulator that dials no phone from loading a bridge's library at all.
    """
    entry = BACKENDS.get(name)
    if entry is None:
        return None
    module, driver = entry
    return getattr(import_module(f".{module}", __package__), driver)
