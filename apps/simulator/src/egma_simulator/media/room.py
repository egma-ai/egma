"""A LiveKit room exposed directly to the simulator's Pipecat pipeline."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sys
import uuid
from array import array
from collections.abc import Awaitable, Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from ..contract import ERROR
from ..mock_tools import MockToolRefusal
from ..platform_logging import log_event
from . import (
    MediaBackendError,
    PlayoutStamp,
    RemoteParticipantLeftFrame,
    VoiceMedia,
    arrived_now,
)

logger = logging.getLogger(__name__)

RpcMethod = Callable[[str], Awaitable[str]]
RpcNotice = Callable[[Any], None]
RpcRefusalNotice = Callable[[Any, MockToolRefusal], None]


def disconnect_reason_name(reason: object) -> str:
    """Keep the documented RTC reason, never arbitrary provider payloads."""
    from livekit import rtc

    try:
        return (
            rtc.DisconnectReason.Name(reason) if isinstance(reason, int) else "UNKNOWN"
        )
    except ValueError:
        return "UNKNOWN"


def room_was_deleted(reason: object) -> bool:
    from livekit import rtc

    return reason == rtc.DisconnectReason.ROOM_DELETED


ROOM_PREFIX = "egma-sim"
"""Frozen room-name stem; builders append the hyphen in the published egma-sim- prefix.
Installed SDKs use it for simulation detection, and token endpoints can allowlist it.
Renaming it breaks deployed integrations. Tests pin the literal independently
of this constant so a change cannot silently update both implementation and check.
"""

PERSONA_IDENTITY = "egma-persona"
"""Who egma is in the room, as the far side addresses it.

Published with the prefix above and frozen for the same reason: it is the
destination the agent's side sends a mock-tool call to, and room
membership under this identity is the whole of the authorisation. It
appears in two forms — exactly this string where egma mints its own
token, and :func:`persona_name_for` where a customer's endpoint mints
one — so both begin here.
"""

CONNECT_SECONDS = 30.0
AUDIO_STREAM_CLOSE_SECONDS = 2.0
PIPECAT_VERSION = "1.7.0"
LIVEKIT_VERSION = "1.1.14"
QUOTED_REFUSAL_CHARS = 200

# ``MIX_SAMPLE_RATE`` and ``MIX_CHANNELS`` are one fact in two names: the
# single format every remote audio track is read and mixed at. The
# docstring under them describes both.
MIX_SAMPLE_RATE = 48000
MIX_CHANNELS = 1
"""Explicit sample rate and channel count for every remote AudioStream.
Normalize before mixing so all tracks use one format regardless of SDK defaults.
"""

LARGEST_MIX_BACKLOG_SECONDS = 1.0
"""Maximum backing-track backlog before dropping its oldest audio.
Bound delayed audio so memory cannot grow without limit behind the lead track.
"""

INT16_CEILING = 32767
INT16_FLOOR = -32768
"""The two numbers a signed 16-bit sample cannot go past.

Not a loudness policy — the representable ends of the format the room
carries. A sum that goes outside them is held at the end it went past,
because the alternative is wrapping a loud moment round to the opposite
sign, which is a click where the loud moment was.
"""


def fresh_room_name() -> str:
    return f"{ROOM_PREFIX}-{uuid.uuid4().hex}"


def fresh_chat_room_name() -> str:
    """Build an egma-sim-chat- room name. The published prefix tells integrated workers
    to disable speech and still matches general egma-sim- detection.
    Keep it stable for deployed workers; the voice hex suffix cannot collide with chat-.
    """
    return f"{ROOM_PREFIX}-chat-{uuid.uuid4().hex}"


def room_name_for(simulation_id: str) -> str:
    return f"{ROOM_PREFIX}-{simulation_id}"


def chat_room_name_for(simulation_id: str) -> str:
    """The marked form of :func:`room_name_for`: the room a customer's
    endpoint is asked for a token into, on a chat simulation.

    The same mark as :func:`fresh_chat_room_name`, for the same reader —
    the worker keys its chat setup off ``egma-sim-chat-`` however the token
    was minted. The bare prefix survives inside it, so the endpoint's own
    ``egma-sim-`` allowlist matches without change.
    """
    return f"{ROOM_PREFIX}-chat-{simulation_id}"


def persona_name_for(simulation_id: str) -> str:
    return f"{PERSONA_IDENTITY}-{simulation_id}"


def answering(
    handler: RpcMethod,
    *,
    on_attempt: RpcNotice | None = None,
    on_accepted: RpcNotice | None = None,
    on_refused: RpcRefusalNotice | None = None,
) -> Callable[[Any], Awaitable[str]]:
    """Turn an Egma mock-tool refusal into LiveKit's typed RPC refusal."""

    async def answer(invocation: Any) -> str:
        from livekit import rtc

        if on_attempt is not None:
            on_attempt(invocation)
        try:
            response = await handler(invocation.payload)
        except MockToolRefusal as refused:
            if on_refused is not None:
                on_refused(invocation, refused)
            raise rtc.RpcError(refused.code, refused.message) from refused
        if on_accepted is not None:
            on_accepted(invocation)
        return response

    return answer


async def first_of(*events: asyncio.Event, within: float) -> bool:
    """Wait until one event occurs, or return false at the deadline."""
    waiting = [asyncio.ensure_future(event.wait()) for event in events]
    try:
        done, _pending = await asyncio.wait(
            waiting, return_when=asyncio.FIRST_COMPLETED, timeout=within
        )
    finally:
        for unfinished in waiting:
            if not unfinished.done():
                unfinished.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await unfinished
    return bool(done)


class _JoinAfterPipecatConversion(asyncio.Queue[Any]):
    """Make Pipecat's stock client iterator joinable without replacing it."""

    def __init__(self) -> None:
        super().__init__()
        self._borrowed = False

    async def get(self) -> Any:
        # Pipecat asks for the next item only after it converted and put the
        # prior one into BaseInput. That point is the missing queue ack in
        # 1.7.0, so a join covers the unchanged conversion/push path.
        if self._borrowed:
            self.task_done()
            self._borrowed = False
        item = await super().get()
        self._borrowed = True
        return item


class _RoomAudioMix:
    """Mix remote audio tracks into one stream at the lead track's cadence.
    The earliest active, unmuted track leads; others buffer for its frames.
    A single track returns its original frame without copying.

    Transfer the clock when the lead ends or mutes. Preserve buffered tails for
    the next lead to consume. Mixed output carries the lead participant's label,
    even when other participants contribute audio.

    Calls must stay synchronous: reader tasks share these buffers, and adding
    an await would permit concurrent partial updates.
    """

    def __init__(self) -> None:
        self._known: set[str] = set()
        """Every track the mix has been told about and not been told is
        over. A muted track is still known — that is what makes its own
        frames droppable rather than mistaken for a track nobody
        registered."""
        self._order: list[str] = []
        """Every *live* track, in the order it joined — known, and not
        muted. The first leads, so the room's clock survives a track
        going quiet or going away."""
        self._backlog: dict[str, bytearray] = {}
        """Audio waiting to be carried, per track. A track keeps its entry
        after it stops leading until the last of it has been carried, so
        no buffered audio is lost to a mute or a departure."""

    def joined(self, key: str) -> None:
        """One track is live: being read, and not muted."""
        self._known.add(key)
        if key not in self._order:
            self._order.append(key)
        self._backlog.setdefault(key, bytearray())

    def quiet(self, key: str) -> None:
        """One track stopped sending, and may start again — a mute.

        It stops leading and takes no more audio in, and it stays known,
        so what it sends while muted is dropped rather than carried. What
        it already buffered stays until the lead has carried it out.
        """
        if key in self._order:
            self._order.remove(key)
        self._forget_an_empty(key)

    def gone(self, key: str) -> None:
        """One track is over: its reader has stopped, for good.

        What it buffered still goes out under the lead's next frames; only
        the track itself is forgotten.
        """
        self._known.discard(key)
        if key in self._order:
            self._order.remove(key)
        self._forget_an_empty(key)

    def _forget_an_empty(self, key: str) -> None:
        if key in self._backlog and not self._backlog[key]:
            del self._backlog[key]

    def leading(self) -> str | None:
        """Which track clocks the room, if any is live."""
        return self._order[0] if self._order else None

    def mixed(self, key: str, event: Any) -> Any | None:
        """One track's frame as the persona's next frame, or nothing yet.

        ``None`` for a backing track's frame, which waits for the lead's
        next frame to carry it, and for a frame from a known track that is
        not live — a publisher that muted a track meant it not to be
        heard, so what it sends after that is dropped rather than mixed.
        """
        if key not in self._known:
            # A stream nobody registered. Only the drain suites reach the
            # reader that way; every track a room subscribes is announced
            # here first. Carried through untouched rather than dropped,
            # because dropping would make those tests pass on silence.
            return event
        if self.leading() != key:
            if key in self._order:
                self._buffered(key, event.frame)
            return None
        waiting = self._backlog[key]
        under = [
            other for other in self._backlog if other != key and self._backlog[other]
        ]
        if not under and not waiting:
            # Read before anything is copied: the single-track lanes must
            # not pay a whole frame of PCM per frame to find that out.
            return event
        said = bytes(waiting) + event.frame.data.tobytes()
        waiting.clear()
        _require_the_mix_format(event.frame)
        taken = (self._taken(other, len(said)) for other in under)
        return _one_frame(
            _added(said, [beneath for beneath in taken if beneath]), event.frame
        )

    def _buffered(self, key: str, frame: Any) -> None:
        _require_the_mix_format(frame)
        backlog = self._backlog[key]
        backlog.extend(frame.data.tobytes())
        spare = len(backlog) - _LARGEST_BACKLOG_BYTES
        if spare > 0:
            del backlog[:spare]

    def _taken(self, key: str, wanted: int) -> bytes:
        backlog = self._backlog[key]
        taken = bytes(backlog[:wanted])
        del backlog[:wanted]
        # A track that stopped leading is kept only for what it still owes
        # the room. Once that is carried, it is gone.
        if not backlog and key not in self._order:
            del self._backlog[key]
        return taken


_LARGEST_BACKLOG_BYTES = round(
    MIX_SAMPLE_RATE * MIX_CHANNELS * 2 * LARGEST_MIX_BACKLOG_SECONDS
)


def _require_the_mix_format(frame: Any) -> None:
    """Refuse to add together audio that is not in the room's one format.

    Unreachable through a room egma joined: it asks every stream for
    :data:`MIX_SAMPLE_RATE` and :data:`MIX_CHANNELS` by name, and LiveKit
    converts on its own side. Kept because the alternative to refusing is
    producing a sum of two different rates, which is noise that no test
    would fail and every listener would.
    """
    if frame.sample_rate != MIX_SAMPLE_RATE or frame.num_channels != MIX_CHANNELS:
        raise MediaBackendError(
            "a room audio track arrived at "
            f"{frame.sample_rate} Hz in {frame.num_channels} channels, which "
            "is not what the room mixes at",
            ending=ERROR,
        )


def _added(said: bytes, under: list[bytes]) -> bytes:
    """Sum tracks before clipping once to the sample range.
    Scaling would change voice volume with background tracks; clipping each addition
    would make the result depend on track order.
    """
    totals = list(_samples(said))
    for beneath in under:
        for index, value in enumerate(_samples(beneath)):
            totals[index] += value
    return _as_pcm(array("h", [_within_int16(total) for total in totals]))


def _within_int16(total: int) -> int:
    """One summed sample, held to the ends of the format that carries it."""
    if total > INT16_CEILING:
        return INT16_CEILING
    return INT16_FLOOR if total < INT16_FLOOR else total


def _samples(pcm: bytes) -> array:
    """PCM read as signed 16-bit samples.

    ``array`` holds samples in this machine's byte order while PCM is
    always little-endian, so the two agree only on a little-endian machine
    and a swap is what makes them agree anywhere else.
    """
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _as_pcm(samples: array) -> bytes:
    """Signed 16-bit samples written back out as little-endian PCM."""
    if sys.byteorder == "little":
        return samples.tobytes()
    little_endian = array("h", samples)
    little_endian.byteswap()
    return little_endian.tobytes()


def _one_frame(said: bytes, like: Any) -> Any:
    """The mixed audio, in the shape the frames it was made of arrived in."""
    from livekit import rtc

    return rtc.AudioFrameEvent(
        rtc.AudioFrame(
            data=said,
            sample_rate=like.sample_rate,
            num_channels=like.num_channels,
            samples_per_channel=len(said) // (2 * like.num_channels),
        )
    )


def track_key(participant_id: str, published: Any) -> str:
    """Key a track as participant SID:track SID. LiveKit SIDs contain no colon,
    so _stream_keys_of() can recover the participant without another registry.
    A track and its publication expose the same SID on different events.
    """
    return f"{participant_id}:{getattr(published, 'sid', None) or id(published)}"


class _Pipecat17InputDrain:
    """Pipecat 1.7.0 inbound audio shim, covered by the version guard.
    Key readers by track so voice and background audio from one participant mix.
    Handle mute events so a silent lead transfers the clock without losing its reader.
    Drain LiveKit 1.1.14 through its explicit end marker, then join BaseInput before
    sending the terminal control frame. Keep Pipecat conversion and push behavior.
    """

    def __init__(
        self,
        input_transport: object,
        failed: asyncio.Event,
        *,
        on_disconnected: Callable[[object], None] | None = None,
        on_audio_track_subscribed: Callable[[str, str], None] | None = None,
        on_audio_track_unsubscribed: Callable[[str, str], None] | None = None,
    ) -> None:
        try:
            from livekit import rtc
            from livekit.rtc._utils import RingQueue

            installed_pipecat = version("pipecat-ai")
            installed_livekit = version("livekit")
        except (ImportError, PackageNotFoundError) as changed:
            raise MediaBackendError(
                "the installed voice transport no longer matches its pinned "
                "media drain",
                ending=ERROR,
            ) from changed
        if (
            installed_pipecat != PIPECAT_VERSION
            or installed_livekit != LIVEKIT_VERSION
            or not callable(RingQueue.get)
            or not callable(rtc.AudioStream.aclose)
        ):
            raise MediaBackendError(
                "the installed voice transport no longer matches its pinned "
                "media drain",
                ending=ERROR,
            )
        try:
            client = input_transport._client
            audio_queue = client._audio_queue
            streams = client._audio_streams
            reader = client._process_audio_stream
            client_iterator = client.get_next_audio_frame
            stream_closer = client._close_audio_stream
            subscribed = client._async_on_track_subscribed
            unsubscribed = client._async_on_track_unsubscribed
            room_setup = client.setup
            callbacks = client._callbacks
            joined_a_track = callbacks.on_audio_track_subscribed
            left_a_track = callbacks.on_audio_track_unsubscribed
        except AttributeError as changed:
            raise MediaBackendError(
                "pipecat 1.7 no longer exposes the livekit input seam needed "
                "to mix every track and order departure after audio",
                ending=ERROR,
            ) from changed
        if (
            type(audio_queue) is not asyncio.Queue
            or not audio_queue.empty()
            or not isinstance(streams, dict)
            or not callable(reader)
            or not callable(client_iterator)
            or not callable(stream_closer)
            or not callable(subscribed)
            or not callable(unsubscribed)
            or not callable(room_setup)
            or not callable(joined_a_track)
            or not callable(left_a_track)
        ):
            raise MediaBackendError(
                "pipecat 1.7 no longer exposes the livekit input seam needed "
                "to mix every track and order departure after audio",
                ending=ERROR,
            )
        self._input = input_transport
        self._client = client
        self._failed = failed
        self._stock_close = stream_closer
        self._stock_subscribed = subscribed
        self._stock_unsubscribed = unsubscribed
        self._stock_setup = room_setup
        self._joined_a_track = joined_a_track
        self._left_a_track = left_a_track
        self._canceling = False
        self._on_disconnected = on_disconnected
        self._on_audio_track_subscribed = on_audio_track_subscribed
        self._on_audio_track_unsubscribed = on_audio_track_unsubscribed
        self._audio_queue = _JoinAfterPipecatConversion()
        client._audio_queue = self._audio_queue
        self._ring_queue_type = RingQueue
        self._audio_event_type = rtc.AudioFrameEvent
        self._audio_kind = rtc.TrackKind.KIND_AUDIO
        self._streams: dict[str, tuple[object, asyncio.Task[Any]]] = streams
        self._mix = _RoomAudioMix()
        self._finishes: dict[
            str,
            tuple[
                tuple[object, asyncio.Task[Any]],
                asyncio.Task[None],
            ],
        ] = {}
        self._departures: dict[str | None, asyncio.Task[None]] = {}
        self._watching = False
        client._process_audio_stream = self._read_audio_stream
        client._close_audio_stream = self.finish_stream
        client._async_on_track_subscribed = self._track_subscribed
        client._async_on_track_unsubscribed = self._track_unsubscribed
        client.setup = self._setup

    # -- Every track the agent publishes, kept and mixed ---------------------

    async def _setup(self, setup: Any) -> None:
        """Let Pipecat build its room, then watch what it does not watch.

        Pipecat makes the ``rtc.Room`` here and registers its own handlers
        on it. The two mute events are not among them, and this is the
        first moment there is a room to put them on — earlier than the
        connect, so no publisher can mute a track before egma is listening
        for it.
        """
        await self._stock_setup(setup)
        self.watch_mutes()

    def watch_mutes(self) -> None:
        """Take LiveKit's mute events, which Pipecat 1.7.0 ignores.

        Once, however many times it is asked. Pipecat's own ``setup`` is
        called by the input transport *and* the output transport and
        guards itself with an early return; this hangs off that same
        call, so without a guard of its own the second call would put a
        second pair of handlers on the same room.
        """
        if self._watching:
            return
        room = getattr(self._client, "_room", None)
        if room is None:
            return
        room.on("track_muted")(self._track_muted)
        room.on("track_unmuted")(self._track_unmuted)
        if self._on_disconnected is not None:
            # Pipecat schedules its async callback but drops this reason.
            # RTC runs this listener before that scheduled callback executes.
            room.on("disconnected")(self._on_disconnected)
        self._watching = True

    def _track_muted(self, participant: Any, publication: Any) -> None:
        """Transfer the clock on mute but keep the reader for a later unmute.
        These events pass participant first; subscribe events pass it last.
        """
        key = track_key(participant.sid, publication)
        if key in self._streams:
            self._mix.quiet(key)

    def _track_unmuted(self, participant: Any, publication: Any) -> None:
        """The publisher is sending again, so the track is live again.

        It rejoins at the back, which makes it a backing track rather than
        the lead. That is deliberate: whatever took the clock while it was
        muted is producing audio now, and moving the clock a second time
        would cost a frame for nothing.
        """
        key = track_key(participant.sid, publication)
        if key in self._streams:
            self._mix.joined(key)

    async def _track_subscribed(
        self, track: Any, publication: Any, participant: Any
    ) -> None:
        """Take one more audio track without letting go of the ones held.

        The stock handler closes whatever stream that participant already
        had before registering the new one, because its registry has one
        slot per participant. This one gives every track its own slot and
        its own reader, and tells the mix the track is there. Video is
        left entirely to the stock handler.
        """
        from livekit import rtc

        if track.kind != self._audio_kind:
            await self._stock_subscribed(track, publication, participant)
            return
        key = track_key(participant.sid, track)
        # Idempotent, and never a sibling: the same track subscribed twice
        # replaces itself, which is the mute/unmute cycle the stock
        # handler's close was written for.
        await self.finish_stream(key)
        stream = rtc.AudioStream(
            track, sample_rate=MIX_SAMPLE_RATE, num_channels=MIX_CHANNELS
        )
        self._mix.joined(key)
        task = asyncio.create_task(
            self._read_audio_stream(stream, key),
            name="livekit-audio-track-reader",
        )
        self._streams[key] = (stream, task)
        if self._on_audio_track_subscribed is not None:
            self._on_audio_track_subscribed(participant.sid, key)
        await self._joined_a_track(participant.sid)

    async def _track_unsubscribed(
        self, track: Any, publication: Any, participant: Any
    ) -> None:
        """Let one track go, and leave the participant's others alone."""
        if track.kind != self._audio_kind:
            await self._stock_unsubscribed(track, publication, participant)
            return
        key = track_key(participant.sid, track)
        await self.finish_stream(key)
        if self._on_audio_track_unsubscribed is not None:
            self._on_audio_track_unsubscribed(participant.sid, key)
        await self._left_a_track(participant.sid)

    def _stream_keys_of(self, participant_id: str | None) -> list[str]:
        """The keys of every audio stream one participant reached here on.

        Both the streams still registered and the ones already being
        finished. A stream is taken out of :attr:`_streams` before its
        close is awaited, so a departure that read only the registry would
        miss a track whose unsubscribe was still in flight — and then
        announce the departure over audio still on its way in.
        """
        keys = [
            key
            for key in self._streams
            if participant_id is None or key.split(":", 1)[0] == participant_id
        ]
        keys.extend(
            key
            for key in self._finishes
            if key not in keys
            and (participant_id is None or key.split(":", 1)[0] == participant_id)
        )
        return keys

    async def _read_audio_stream(self, stream: object, key: str) -> None:
        """Read through LiveKit's explicit end marker, preserving buffered tail audio.
        Output keeps the participant label recovered from the track key.
        Only subscribe and mute handlers add tracks; adding here could undo a mute.
        Remove the track when its reader finishes, after its audio has drained.
        """
        participant_id = key.split(":", 1)[0]
        try:
            queue = stream._queue
            if not isinstance(queue, self._ring_queue_type):
                raise RuntimeError
            while True:
                event = await queue.get()
                if event is None:
                    return
                if not isinstance(event, self._audio_event_type):
                    raise RuntimeError
                carried = self._mix.mixed(key, event)
                if carried is None:
                    continue
                await self._audio_queue.put((carried, participant_id))
        except asyncio.CancelledError:
            raise
        except MediaBackendError:
            # Egma's own named refusal, already saying exactly what was
            # wrong with the audio. Carried up as itself so the sentence
            # reaches the log instead of dying inside a generic one.
            self._failed.set()
            raise
        except Exception as unreadable:
            self._failed.set()
            raise RuntimeError(
                "the livekit input stream could not be read"
            ) from unreadable
        finally:
            self._mix.gone(key)

    def _finish_for(self, key: str) -> asyncio.Task[None] | None:
        entry = self._streams.get(key)
        owned = self._finishes.get(key)
        if owned is not None:
            owned_entry, finish = owned
            if entry is None or entry is owned_entry:
                return finish
        if entry is None:
            return None
        finish = asyncio.create_task(
            self._finish_stream(key, entry),
            name="livekit-audio-stream-finish",
        )
        self._finishes[key] = (entry, finish)
        return finish

    async def finish_stream(self, key: str) -> None:
        """Drain one unsubscribed track without declaring a departure."""
        if self._canceling:
            await self._stock_close(key)
            return
        finish = self._finish_for(key)
        if finish is not None:
            await asyncio.shield(finish)

    async def _finish_stream(
        self,
        key: str,
        entry: tuple[object, asyncio.Task[Any]],
    ) -> None:
        stream, reader = entry
        try:
            async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                if self._streams.get(key) is entry:
                    self._streams.pop(key)
                await stream.aclose()
                try:
                    await reader
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A reader that broke is still a reader that is over,
                    # and this close is what the bookkeeping after it hangs
                    # off — the unsubscribe event, and Pipecat's own
                    # registry. The reader already set ``failed``, so the
                    # simulation still fails; what must not happen is a
                    # teardown that stops halfway because of it. (Pipecat's
                    # own task manager swallowed these; the reader tasks
                    # here are plain, so the swallowing is explicit.)
                    pass
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            self._failed.set()
            raise RuntimeError("the livekit input stream could not be closed") from None
        except Exception:
            self._failed.set()
            raise RuntimeError("the livekit input stream could not be closed") from None
        finally:
            if not reader.done():
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader
            # The backstop for a track whose reader never ran at all. A
            # reader that did run has already taken itself out of the mix
            # on its way past its own last frame, and this is a no-op.
            self._mix.gone(key)

    async def participant_left(
        self, participant_id: str | None, completed: asyncio.Event
    ) -> None:
        # None is a confirmed whole-room ending and drains every publisher.
        # A later participant event joins it instead of emitting another marker.
        departure = self._departures.get(None) or self._departures.get(participant_id)
        if departure is None:
            departure = asyncio.create_task(
                self._finish_departure(participant_id, completed),
                name="livekit-participant-departure",
            )
            self._departures[participant_id] = departure
        await asyncio.shield(departure)

    @property
    def departure_started(self) -> bool:
        return bool(self._departures)

    async def finish_departures(self) -> None:
        """A room closing must not cancel a departure already draining audio."""
        await asyncio.shield(asyncio.gather(*self._departures.values()))

    def _require_working_media(self) -> None:
        if self._failed.is_set():
            raise RuntimeError("the livekit input failed before participant departure")

    async def _finish_departure(
        self, participant_id: str | None, completed: asyncio.Event
    ) -> None:
        # Every track the participant was publishing, because a departure
        # is the participant's and the tracks are only the ways it reached
        # here. One left unfinished would hold audio the marker below then
        # claims came before it.
        held = (self._finish_for(key) for key in self._stream_keys_of(participant_id))
        finishes = [finish for finish in held if finish is not None]
        try:
            async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                if finishes:
                    # Waited out, never judged: whether one of them failed
                    # is already recorded in ``failed``, and the check
                    # below is what reads it. What matters here is only
                    # that none is still running when the marker goes.
                    await asyncio.shield(
                        asyncio.gather(*finishes, return_exceptions=True)
                    )
                self._require_working_media()
                await self._audio_queue.join()
                self._require_working_media()
                try:
                    input_queue = self._input._audio_in_queue
                except AttributeError as changed:
                    raise RuntimeError(
                        "pipecat no longer exposes its audio input queue"
                    ) from changed
                if not isinstance(input_queue, asyncio.Queue):
                    raise RuntimeError(
                        "pipecat no longer exposes its audio input queue"
                    )
                await input_queue.join()
                self._require_working_media()
                acknowledged = asyncio.Event()
                marker = RemoteParticipantLeftFrame(completed=acknowledged)
                await self._input.push_frame(marker)
                await acknowledged.wait()
                completed.set()
        except TimeoutError:
            unfinished = [finish for finish in finishes if not finish.done()]
            for finish in unfinished:
                finish.cancel()
            if unfinished:
                await asyncio.gather(*unfinished, return_exceptions=True)
            raise

    async def cancel(self) -> None:
        """Cancel and reap owned media work before local transport cleanup."""
        self._canceling = True
        owned = [*self._departures.values()]
        owned.extend(finish for _entry, finish in self._finishes.values())
        pending = list({task for task in owned if not task.done()})
        for task in pending:
            task.cancel()
        if pending:
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                    await asyncio.gather(*pending, return_exceptions=True)


class JoinedRoom:
    """One LiveKit transport, owned by the conductor's only pipeline."""

    def __init__(
        self,
        *,
        url: str,
        token: str,
        room_name: str,
        quotable: Callable[[str], str] = lambda told: told,
        confirm_remote_end: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        self._url = url
        self._token = token
        self._room_name = room_name
        self._quotable = quotable
        self._confirm_remote_end = confirm_remote_end
        self._disconnect_reason: object = None
        self._remote_close: asyncio.Task[None] | None = None
        self._transport: object | None = None
        self._input_drain: _Pipecat17InputDrain | None = None
        self._connected = asyncio.Event()
        self.arrivals = asyncio.Event()
        self.carrying_audio = asyncio.Event()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self._leaving = False
        self._offer: Callable[[], None] | None = None
        self._startup: Any = None
        self._startup_room: Any = None
        self._startup_handlers: list[tuple[str, Callable[..., None]]] = []
        self._startup_identities: dict[str, str] = {}
        self._subscribed_audio_tracks: dict[str, set[str]] = {}

    @property
    def joined(self) -> bool:
        return self._transport is not None

    def answer_when_joined(self, offer: Callable[[], None]) -> None:
        """Offer mock-tool RPC immediately on connect, before announcing room readiness.
        An agent already in the room may send hello as soon as Egma joins.
        """
        self._offer = offer

    def watch_startup(self, startup: Any) -> None:
        """Attach the startup latch before the transport connects."""
        self._startup = startup
        for participant_sid in self._subscribed_audio_tracks:
            self._note_startup_audio_track(participant_sid)

    def create_transport(self) -> VoiceMedia:
        """Create stock LiveKit input and output processors without rates."""
        from pipecat.frames.frames import Frame, InputAudioRawFrame
        from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
        from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport

        transport = LiveKitTransport(
            url=self._url,
            token=self._token,
            room_name=self._room_name,
            params=LiveKitParams(audio_in_enabled=True, audio_out_enabled=True),
        )
        self._transport = transport
        input_transport = transport.input()
        try:
            input_drain = _Pipecat17InputDrain(
                input_transport,
                self.failed,
                on_disconnected=self._room_disconnected,
                on_audio_track_subscribed=self._audio_track_subscribed,
                on_audio_track_unsubscribed=self._audio_track_unsubscribed,
            )
        except Exception:
            self.failed.set()
            raise
        self._input_drain = input_drain

        @transport.event_handler("on_connected")
        async def _connected(_transport: object) -> None:
            offer = self._offer
            if offer is not None:
                offer()
            startup = self._startup
            raw_room = self._raw_room()
            if startup is not None and raw_room is not None:
                self._watch_startup_states(raw_room)
            self._connected.set()

        @transport.event_handler("on_before_disconnect")
        async def _before_disconnect(_transport: object) -> None:
            # Pipecat fires this awaited event before its own stop/cancel path
            # closes streams. Take down an in-flight remote departure first.
            self._leaving = True
            await self._cancel_remote_close()
            await input_drain.cancel()

        @transport.event_handler("on_disconnected")
        async def _disconnected(_transport: object) -> None:
            if not self._leaving:
                if self._remote_close is None:
                    self._remote_close = asyncio.create_task(
                        self._finish_remote_close(input_drain),
                        name="livekit-room-completion",
                    )
                with contextlib.suppress(asyncio.CancelledError):
                    await asyncio.shield(self._remote_close)

        @transport.event_handler("on_participant_connected")
        async def _arrived(_transport: object, participant: str) -> None:
            self.arrivals.set()

        @transport.event_handler("on_first_participant_joined")
        async def _already_here(_transport: object, participant: str) -> None:
            # Also handle participants already present when Egma joins. This event can
            # overlap
            # the arrival callback; both set the same event safely.
            self.arrivals.set()

        @transport.event_handler("on_participant_disconnected")
        async def _left(_transport: object, participant: str) -> None:
            if self._leaving:
                return
            startup = self._startup
            if startup is not None:
                identity = self._startup_identities.get(participant)
                if identity is not None and not startup.is_relevant(identity):
                    return
            try:
                await input_drain.participant_left(participant, self.ended)
            except Exception:
                logger.warning(
                    "the livekit input drain failed before participant departure"
                )
                self.failed.set()

        room = self

        class _Arrival(FrameProcessor):
            """When the agent's audio reached egma, on egma's own clock.

            The first thing in the pipeline that sees inbound audio, so
            the stamp it writes is as close to arrival as this side can
            honestly get. The recording is built on these stamps, which
            is what makes a wait measured on the file the wait the caller
            lived through instead of a count of what was buffered.
            """

            async def process_frame(
                self, frame: Frame, direction: FrameDirection
            ) -> None:
                await super().process_frame(frame, direction)
                if isinstance(frame, InputAudioRawFrame):
                    arrived_now(frame)
                    room.carrying_audio.set()
                await self.push_frame(frame, direction)

        return VoiceMedia(
            input=(input_transport, _Arrival()),
            output=(transport.output(), PlayoutStamp()),
            ended=self.ended,
            failed=self.failed,
            transport_name=f"livekit server at {self._quotable(self._url)}",
        )

    def _raw_room(self) -> Any:
        transport = self._transport
        if transport is None:
            return None
        try:
            return transport._client.room
        except Exception:
            return None

    def _watch_startup_states(self, raw_room: Any) -> None:
        if self._startup_room is raw_room:
            return
        self._startup_room = raw_room

        def _remember(participant: Any) -> None:
            identity = getattr(participant, "identity", "")
            sid = getattr(participant, "sid", "")
            if isinstance(sid, str) and isinstance(identity, str) and identity:
                self._startup_identities[sid] = identity
                self._note_startup_audio_track(sid)
            startup = self._startup
            if startup is not None:
                startup.participant_seen(
                    identity,
                    getattr(participant, "attributes", None),
                )

        def _forget(participant: Any) -> None:
            sid = getattr(participant, "sid", "")
            identity = getattr(participant, "identity", "")
            if isinstance(sid, str):
                self._subscribed_audio_tracks.pop(sid, None)
                self._startup_identities.pop(sid, None)
            startup = self._startup
            if startup is not None:
                startup.participant_audio_track_left(identity)
                startup.participant_left(identity)

        def _startup_state(changed: dict[str, str], participant: Any) -> None:
            startup = self._startup
            if startup is not None:
                startup.participant_state(
                    getattr(participant, "identity", ""),
                    changed.get("lk.agent.state"),
                )

        handlers = [
            ("participant_connected", _remember),
            ("participant_disconnected", _forget),
            ("participant_attributes_changed", _startup_state),
        ]
        for event, handler in handlers:
            raw_room.on(event)(handler)
        self._startup_handlers = handlers
        for participant in raw_room.remote_participants.values():
            _remember(participant)

    def _audio_track_subscribed(self, participant_sid: str, key: str) -> None:
        self._subscribed_audio_tracks.setdefault(participant_sid, set()).add(key)
        self._note_startup_audio_track(participant_sid)

    def _audio_track_unsubscribed(self, participant_sid: str, key: str) -> None:
        tracks = self._subscribed_audio_tracks.get(participant_sid)
        if tracks is None:
            return
        tracks.discard(key)
        if tracks:
            return
        self._subscribed_audio_tracks.pop(participant_sid, None)
        startup = self._startup
        identity = self._startup_identities.get(participant_sid)
        if startup is not None and identity is not None:
            startup.participant_audio_track_left(identity)

    def _note_startup_audio_track(self, participant_sid: str) -> None:
        if not self._subscribed_audio_tracks.get(participant_sid):
            return
        startup = self._startup
        identity = self._startup_identities.get(participant_sid)
        if startup is not None and identity is not None:
            startup.participant_audio_track(identity)

    def _detach_startup_states(self) -> None:
        room, self._startup_room = self._startup_room, None
        if room is not None:
            for event, handler in self._startup_handlers:
                room.off(event, handler)
        self._startup_handlers.clear()
        self._startup_identities.clear()

    def _room_disconnected(self, reason: object = None) -> None:
        self._disconnect_reason = reason
        log_event(
            logger,
            logging.INFO,
            "egma.media.disconnected",
            "livekit room disconnected",
            attributes={"livekit.disconnect_reason": disconnect_reason_name(reason)},
        )

    async def _finish_remote_close(self, drain: _Pipecat17InputDrain) -> None:
        try:
            if self.failed.is_set():
                return
            if self.ended.is_set():
                return
            if drain.departure_started:
                await drain.finish_departures()
                return
            established = self._connected.is_set() and self.carrying_audio.is_set()
            confirmed = False
            if established:
                if self._confirm_remote_end is not None:
                    confirmed = await self._confirm_remote_end()
                else:
                    confirmed = room_was_deleted(self._disconnect_reason)
            if self._leaving:
                return
            # Participant events can arrive while the provider request is in
            # flight. Keep their completed/pending drain instead of starting a
            # second marker or replacing that ending with an unconfirmed drop.
            if self.failed.is_set() or self.ended.is_set():
                return
            if drain.departure_started:
                await drain.finish_departures()
                return
            if confirmed:
                # This check and every drain check preserve independent media
                # failures. A provider ending never clears a failure event.
                drain._require_working_media()
                await drain.participant_left(None, self.ended)
            else:
                self.failed.set()
        except Exception:
            if not self._leaving:
                self.failed.set()
                logger.warning("the livekit input drain failed before room completion")
        finally:
            if self.failed.is_set():
                await drain.cancel()

    async def _cancel_remote_close(self) -> None:
        task = self._remote_close
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def wait_connected(self) -> None:
        """Wait for the running Pipecat transport to enter the room."""
        if not await first_of(
            self._connected, self.ended, self.failed, within=CONNECT_SECONDS
        ):
            raise MediaBackendError(
                f"the livekit server at {self._url} did not let the simulator "
                f"into a room within {CONNECT_SECONDS:.0f}s",
                ending=ERROR,
            )
        if self.failed.is_set() or not self._connected.is_set():
            raise MediaBackendError(
                f"the livekit server at {self._url} closed the room while the "
                "simulator was joining",
                ending=ERROR,
            )

    def note_anybody_already_here(self) -> None:
        """Read existing remote participants after join to cover delayed arrival
        callbacks.
        Do not count Egma itself. If the transport cannot expose the table, retain
        the state supplied by events without raising.
        """
        if self.arrivals.is_set() or self._transport is None:
            return
        try:
            present = self._transport.get_participants()
        except Exception:
            return
        if present:
            self.arrivals.set()

    def register_rpc(
        self,
        method: str,
        handler: RpcMethod,
        *,
        on_attempt: RpcNotice | None = None,
        on_accepted: RpcNotice | None = None,
        on_refused: RpcRefusalNotice | None = None,
    ) -> None:
        if self._transport is None:
            raise MediaBackendError(
                f"{method} was offered before the room transport existed",
                ending=ERROR,
            )
        # Pipecat 1.7.0 offers no public path from LiveKitTransport to its
        # local participant. This one access is pinned in uv.lock and covered
        # by the room mock-tool tests.
        self._transport._client.room.local_participant.register_rpc_method(
            method,
            answering(
                handler,
                on_attempt=on_attempt,
                on_accepted=on_accepted,
                on_refused=on_refused,
            ),
        )

    async def leave(self) -> None:
        """Release transport event handlers after the pipeline has ended."""
        transport, self._transport = self._transport, None
        input_drain, self._input_drain = self._input_drain, None
        self._leaving = True
        self.ended.set()
        await self._cancel_remote_close()
        self._detach_startup_states()
        if input_drain is not None:
            await input_drain.cancel()
        if transport is not None:
            try:
                await transport.cleanup()
            except Exception as unfinished:
                logger.warning(
                    "the exchange's transport did not clean up: %s",
                    self._quotable(repr(unfinished)),
                )


def room_token(api_key: str, api_secret: str, room_name: str) -> str:
    """Mint the persona's way into one room."""
    from livekit import api

    return (
        api.AccessToken(api_key, api_secret)
        .with_identity(PERSONA_IDENTITY)
        .with_name(PERSONA_IDENTITY)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )


async def delete_room(
    *,
    url: str,
    api_key: str,
    api_secret: str,
    room_name: str,
    quotable: Callable[[str], str] = lambda told: told,
) -> None:
    """Delete a room, logging teardown failure instead of replacing the run."""
    from livekit import api

    lkapi = None
    try:
        lkapi = api.LiveKitAPI(url, api_key, api_secret)
        await lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name))
    except Exception as unfinished:
        logger.info(
            "the room %s was not deleted: %s", room_name, quotable(repr(unfinished))
        )
    finally:
        if lkapi is not None:
            with contextlib.suppress(Exception):
                await lkapi.aclose()
