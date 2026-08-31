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
from . import MediaBackendError, RemoteParticipantLeftFrame, VoiceMedia

logger = logging.getLogger(__name__)

RpcMethod = Callable[[str], Awaitable[str]]

ROOM_PREFIX = "egma-sim"
"""The stem of the name every room egma conducts a simulation in.

**The published contract is the hyphenated ``egma-sim-``** — this stem
and the separator that :func:`fresh_room_name` and :func:`room_name_for`
below put after it. That hyphenated form is what a customer's own token
endpoint allowlists, what the hardening recipe names its empty timeout
against, and what the egma SDK inside the customer's worker reads to
answer "am I in a simulation?"
before it connects to anything — the one question that decides whether
mock tools are served and whether the agent's spans go out the
production door. Every room name built below begins with it on all three
ways into a room, which is what makes that answer the same answer
everywhere.

Move the value and every installed SDK goes inert inside a real
simulation: real tools run, and the simulation's spans arrive in
Monitoring as a production conversation. One test in this package holds
the line — ``apps/simulator/tests/test_plug_phone.py`` asserts a
conducted room name begins ``egma-sim-``, written out by hand rather than
built from this constant, so a rename here goes red rather than quiet.
Read that red as the contract refusing to move, not as a fixture to
update.

Nothing links this constant to the far side of the contract, and nothing
can: the SDK holds its own copy in
``sdks/python/src/egma/mockable.py``, pinned again by
``sdks/python/tests/room_stub.py`` and
``fixtures/livekit-dumb-agent/tests/conftest.py``, and a customer runs
whichever release of it they installed. A version already deployed cannot
be edited to follow a rename. That is what makes the value frozen rather
than merely stable.
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

MIX_SAMPLE_RATE = 48000
MIX_CHANNELS = 1
"""The one format every remote audio track is read and mixed at.

LiveKit's own numbers, asked for by name rather than inherited: ``rtc.AudioStream``
already normalises whatever a publisher sent to exactly these, on its
native side, before a frame ever reaches Python. Naming them here is what
makes the mix below arithmetic instead of a guess — every track arrives
at the same rate and channel count, so adding two of them together is
adding two lists of numbers, with no resampler in the path and no
question about which of two rates the sum is in.

They are also a pin. A LiveKit release that moved either default would
otherwise move the mix under it silently; asked for by name, the room
keeps reading what it reads today.
"""

LARGEST_MIX_BACKLOG_SECONDS = 1.0
"""How far behind the room's clock a second track may fall before its
oldest audio is dropped.

The tracks of one participant arrive together in real time, so the
backlog is normally one frame or none. This is the bound on the
pathological case — a track that produces faster than the one the room is
clocked by — and it is a *drop* rather than growth without end, because
audio a second old is no longer part of the conversation the persona is
having.
"""

LOUDEST = 32767
QUIETEST = -32768


def fresh_room_name() -> str:
    return f"{ROOM_PREFIX}-{uuid.uuid4().hex}"


def fresh_chat_room_name() -> str:
    """A chat simulation's room: the modality mark is the room's own name.

    ``egma-sim-chat-`` is part of the published contract exactly as the
    hyphenated ``egma-sim-`` above is, and for the same reason: it is what
    the customer's own worker reads. The chat setup in Egma's LiveKit
    integration instructions keys its one decision off this segment,
    before the worker connects to anything — the room's name is the only
    channel egma owns on every dispatch path, it is readable from the job
    with no network and no parsing, and no key of the customer's can ever
    collide with it. Everything that recognises ``egma-sim-`` — the SDK's
    simulation detection, a token endpoint's allowlist, the hardening
    recipe's empty timeout — still matches, because the prefix is
    unchanged.

    A voice room's name stays bare on purpose. Speech is what a LiveKit
    agent already is; the marked case is the one asking it to be
    something else. A hex suffix cannot begin ``chat-``, so the two forms
    cannot be mistaken for each other.

    Move the segment and every worker carrying the chat setup answers a
    chat simulation aloud — the fail-fast then stops each of those
    simulations at the agent's first utterance. The pin in
    ``apps/simulator/tests/test_plug_livekit_chat.py`` writes the segment
    out by hand so a rename here goes red rather than quiet; read that
    red as the contract refusing to move.
    """
    return f"{ROOM_PREFIX}-chat-{uuid.uuid4().hex}"


def room_name_for(simulation_id: str) -> str:
    return f"{ROOM_PREFIX}-{simulation_id}"


def persona_name_for(simulation_id: str) -> str:
    return f"{PERSONA_IDENTITY}-{simulation_id}"


def answering(handler: RpcMethod) -> Callable[[Any], Awaitable[str]]:
    """Turn an Egma mock-tool refusal into LiveKit's typed RPC refusal."""

    async def answer(invocation: Any) -> str:
        from livekit import rtc

        try:
            return await handler(invocation.payload)
        except MockToolRefusal as refused:
            raise rtc.RpcError(refused.code, refused.message) from refused

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
    """Every remote audio track in the room, as one stream for the persona.

    The agent under test may publish more than one audio track at once —
    its voice and an ambient background sound is the case this exists for,
    and it is what a real caller's ear gets. The persona has one ear, so
    the tracks are **added together**, not chosen between: distinguishing
    them would encode a guess about which track is the voice that no
    document backs, and the customer's production experience includes the
    background.

    **One track clocks the room.** The earliest track still being read is
    the *lead*: its frames are what the persona's pipeline is handed, one
    for one, at their own cadence. Every other track buffers, and each of
    the lead's frames takes as much of each backlog as it is long. That is
    what keeps a room with two tracks worth exactly as much media time as
    a room with one — the conductor reads every position out of the input
    frames it is given, so a second track carried beside the first rather
    than into it would make the whole conversation run at double speed.

    **One track is a pass-through.** With nothing else in the room the
    lead's frame is returned as it arrived — the same object, not copied,
    not re-framed and not inspected. A phone call and an ordinary LiveKit
    agent publish one track, so the lanes that already worked are
    untouched by this, byte for byte.

    A track that turns up mid-call joins as a backing track from its first
    frame. A lead that goes away hands the clock to whichever track was
    registered next, and whatever it had buffered by then goes out with
    its first frame as lead rather than being thrown away.

    One reader task per track calls in here, and nothing in it awaits.
    That is deliberate and it is what makes a lock unnecessary: a call
    runs from start to finish inside one turn of the event loop, so two
    tracks can never be halfway through the same backlog at once. Keep it
    that way — an ``await`` added below is a data race, not a slow path.
    """

    def __init__(self) -> None:
        self._order: list[str] = []
        """Every track being read, in the order it was subscribed. The
        first is the lead, so the room's clock survives a track leaving."""
        self._backlog: dict[str, bytearray] = {}

    def joined(self, key: str) -> None:
        if key in self._backlog:
            return
        self._order.append(key)
        self._backlog[key] = bytearray()

    def left(self, key: str) -> None:
        if key not in self._backlog:
            return
        self._order.remove(key)
        del self._backlog[key]

    def mixed(self, key: str, event: Any) -> Any | None:
        """One track's frame as the persona's next frame, or nothing yet.

        ``None`` means the frame was a backing track's and is waiting for
        the lead's next frame to carry it. A track this mix was never told
        about is carried through untouched, which is what a stream nobody
        registered — a test driving the reader directly — has always done.
        """
        if key not in self._backlog:
            return event
        if self._order[0] != key:
            self._buffered(key, event.frame)
            return None
        waiting = bytes(self._backlog[key])
        self._backlog[key].clear()
        said = waiting + event.frame.data.tobytes()
        under = [
            beneath
            for beneath in (self._taken(other, len(said)) for other in self._order[1:])
            if beneath
        ]
        if not under and not waiting:
            return event
        _mixable(event.frame)
        return _one_frame(_added(said, under), event.frame)

    def _buffered(self, key: str, frame: Any) -> None:
        _mixable(frame)
        backlog = self._backlog[key]
        backlog.extend(frame.data.tobytes())
        spare = len(backlog) - _LARGEST_BACKLOG_BYTES
        if spare > 0:
            del backlog[:spare]

    def _taken(self, key: str, wanted: int) -> bytes:
        backlog = self._backlog[key]
        taken = bytes(backlog[:wanted])
        del backlog[:wanted]
        return taken


_LARGEST_BACKLOG_BYTES = round(
    MIX_SAMPLE_RATE * MIX_CHANNELS * 2 * LARGEST_MIX_BACKLOG_SECONDS
)


def _mixable(frame: Any) -> None:
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
    """Two or more tracks of the room, added sample by sample.

    Clipped rather than scaled, because scaling would quieten the agent's
    voice by however much background it happens to be playing — and the
    persona's transcriber then hears a different agent depending on the
    ambience. Two ordinary speech tracks do not reach the ends of the
    range together often enough to matter; a mix that moved the voice's
    level would matter on every frame.
    """
    mixed = _samples(said)
    for beneath in under:
        for index, value in enumerate(_samples(beneath)):
            total = mixed[index] + value
            mixed[index] = (
                LOUDEST if total > LOUDEST else QUIETEST if total < QUIETEST else total
            )
    return _as_pcm(mixed)


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


def track_key(participant_id: str, track: Any) -> str:
    """One subscribed audio track's name, inside the room.

    The participant and the track, in that order, so the participant can
    be read straight back off it — see :meth:`_Pipecat17InputDrain.
    _tracks_of`. That saves a second registry to keep true, and it makes a
    key say what it is wherever one is read. Participant and track
    identifiers are LiveKit's own ``PA_``/``TR_`` sids, which carry no
    colon, so the split is unambiguous.

    A stream registered under a bare participant — Pipecat's own keying,
    and what a test driving the reader by hand hands over — reads back as
    that participant with no track, which is exactly right.
    """
    return f"{participant_id}:{getattr(track, 'sid', None) or id(track)}"


class _Pipecat17InputDrain:
    """Own Pipecat 1.7.0's inbound room audio: keyed by track, and ordered.

    Two duties, both of them things the pinned release cannot do and
    exposes no public seam for.

    **Every track, mixed.** Pipecat 1.7.0 keys a subscribed audio stream by
    *participant*: a second audio track from the same participant closes
    the first and takes its place. An agent publishing its voice and an
    ambient background therefore reached the persona as whichever track
    was subscribed last, and a whole simulation could be conducted against
    background noise. This shim registers each track under its own key and
    feeds them all through :class:`_RoomAudioMix`, so the persona hears the
    room the way a caller does. One track stays a pass-through, so the
    phone and LiveKit lanes go through the same path unchanged.

    **Departure after audio.** LiveKit 1.1.14's iterator stops as soon as
    its native task ends, before it reads buffered frames that precede the
    queue's explicit end marker. The shim replaces the stream reader and
    close coordinator, makes the existing client iterator joinable, then
    joins BaseInput before one ordinary control frame enters the pipeline.

    Pipecat's conversion and push path remain unchanged in both. What the
    version guard below pins is the whole of what is reached into.
    """

    def __init__(self, input_transport: object, failed: asyncio.Event) -> None:
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
            tracks = client._audio_tracks
            reader = client._process_audio_stream
            client_iterator = client.get_next_audio_frame
            stream_closer = client._close_audio_stream
            subscribed = client._async_on_track_subscribed
            unsubscribed = client._async_on_track_unsubscribed
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
            or not isinstance(tracks, dict)
            or not callable(reader)
            or not callable(client_iterator)
            or not callable(stream_closer)
            or not callable(subscribed)
            or not callable(unsubscribed)
            or not callable(joined_a_track)
            or not callable(left_a_track)
        ):
            raise MediaBackendError(
                "pipecat 1.7 no longer exposes the livekit input seam needed "
                "to mix every track and order departure after audio",
                ending=ERROR,
            )
        self._input = input_transport
        self._failed = failed
        self._stock_close = stream_closer
        self._stock_subscribed = subscribed
        self._stock_unsubscribed = unsubscribed
        self._joined_a_track = joined_a_track
        self._left_a_track = left_a_track
        self._canceling = False
        self._audio_queue = _JoinAfterPipecatConversion()
        client._audio_queue = self._audio_queue
        self._ring_queue_type = RingQueue
        self._audio_event_type = rtc.AudioFrameEvent
        self._audio_kind = rtc.TrackKind.KIND_AUDIO
        self._streams: dict[str, tuple[object, asyncio.Task[Any]]] = streams
        self._tracks: dict[str, object] = tracks
        self._mix = _RoomAudioMix()
        self._finishes: dict[
            str,
            tuple[
                tuple[object, asyncio.Task[Any]],
                asyncio.Task[None],
            ],
        ] = {}
        self._departures: dict[str, asyncio.Task[None]] = {}
        client._process_audio_stream = self._read_audio_stream
        client._close_audio_stream = self.finish_stream
        client._async_on_track_subscribed = self._track_subscribed
        client._async_on_track_unsubscribed = self._track_unsubscribed

    # -- Every track the agent publishes, kept and mixed ---------------------

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
        self._tracks[key] = track
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
        self._tracks.pop(key, None)
        await self._left_a_track(participant.sid)

    def _tracks_of(self, participant_id: str) -> list[str]:
        """Every audio track one participant is being read on."""
        return [
            key
            for key in list(self._streams)
            if key.split(":", 1)[0] == participant_id
        ]

    async def _read_audio_stream(self, stream: object, key: str) -> None:
        """Read LiveKit 1.1.14 through its explicit end marker.

        ``key`` is the track's, and the participant is read back off it,
        so what the pipeline is handed still says which participant spoke
        and never which of their tracks — the mix has already made that
        question meaningless.

        This reader's own exit is what takes the track out of the mix, and
        it is the earliest honest moment for it: the frames are read here,
        so a reader that has stopped is a track with no more audio, and no
        tail can be left to carry past the mix. Waiting for the
        unsubscribe event instead would leave a track that ran out first
        still holding the room's clock — which, for the earliest track, is
        a persona that hears nothing at all while the others buffer.
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
        except Exception:
            self._failed.set()
            raise RuntimeError("the livekit input stream could not be read") from None
        finally:
            self._mix.left(key)

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
                await reader
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
            self._mix.left(key)

    async def participant_left(
        self, participant_id: str, completed: asyncio.Event
    ) -> None:
        departure = self._departures.get(participant_id)
        if departure is None:
            departure = asyncio.create_task(
                self._finish_departure(participant_id, completed),
                name="livekit-participant-departure",
            )
            self._departures[participant_id] = departure
        await asyncio.shield(departure)

    def _require_working_media(self) -> None:
        if self._failed.is_set():
            raise RuntimeError("the livekit input failed before participant departure")

    async def _finish_departure(
        self, participant_id: str, completed: asyncio.Event
    ) -> None:
        # Every track the participant was publishing, because a departure
        # is the participant's and the tracks are only the ways it reached
        # here. One left unfinished would hold audio the marker below then
        # claims came before it.
        held = (self._finish_for(key) for key in self._tracks_of(participant_id))
        finishes = [finish for finish in held if finish is not None]
        try:
            async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                if finishes:
                    await asyncio.shield(asyncio.gather(*finishes))
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
    ) -> None:
        self._url = url
        self._token = token
        self._room_name = room_name
        self._quotable = quotable
        self._transport: object | None = None
        self._input_drain: _Pipecat17InputDrain | None = None
        self._connected = asyncio.Event()
        self.arrivals = asyncio.Event()
        self.carrying_audio = asyncio.Event()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self._leaving = False
        self._offer: Callable[[], None] | None = None

    @property
    def joined(self) -> bool:
        return self._transport is not None

    def answer_when_joined(self, offer: Callable[[], None]) -> None:
        """Run ``offer`` the instant this room is entered, before anything
        else learns the room is up.

        The agent can already be in the room when egma arrives — on two
        of the three ways in nothing egma does puts it there, so it joins
        whenever its own dispatcher says. Whatever offers to answer for
        the agent's tools therefore has to be live at the earliest moment
        it *can* be live, which is the connect itself: a method registered
        one step later is a race against the first thing the agent's
        session says, and losing that race reads on the far side as "no
        egma here" and runs every real tool inside a live simulation.
        """
        self._offer = offer

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
            input_drain = _Pipecat17InputDrain(input_transport, self.failed)
        except Exception:
            self.failed.set()
            raise
        self._input_drain = input_drain

        @transport.event_handler("on_connected")
        async def _connected(_transport: object) -> None:
            offer = self._offer
            if offer is not None:
                offer()
            self._connected.set()

        @transport.event_handler("on_before_disconnect")
        async def _before_disconnect(_transport: object) -> None:
            # Pipecat fires this awaited event before its own stop/cancel path
            # closes streams. Take down an in-flight remote departure first.
            self._leaving = True
            await input_drain.cancel()

        @transport.event_handler("on_disconnected")
        async def _disconnected(_transport: object) -> None:
            if not self._leaving:
                self.failed.set()
                await input_drain.cancel()

        @transport.event_handler("on_participant_connected")
        async def _arrived(_transport: object, _participant: str) -> None:
            self.arrivals.set()

        @transport.event_handler("on_first_participant_joined")
        async def _already_here(_transport: object, _participant: str) -> None:
            # The other half of "somebody is in the room". The transport
            # raises this for the first participant it ever sees, by
            # either of the two routes it can see one: a participant that
            # connects while egma is watching raises the arrival above
            # *and* this one, while a participant already in the room when
            # egma walked in raises only this one. So the two handlers
            # overlap rather than divide, and the overlap is free — both
            # set the same event, which is set once and read as a state.
            # This handler earns its place on the second route alone: an
            # agent that got into the room first would otherwise be waited
            # out and reported as a worker that never came, while it sat
            # there publishing audio.
            self.arrivals.set()

        @transport.event_handler("on_participant_disconnected")
        async def _left(_transport: object, participant: str) -> None:
            if self._leaving:
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
            async def process_frame(
                self, frame: Frame, direction: FrameDirection
            ) -> None:
                await super().process_frame(frame, direction)
                if isinstance(frame, InputAudioRawFrame):
                    room.carrying_audio.set()
                await self.push_frame(frame, direction)

        return VoiceMedia(
            input=(input_transport, _Arrival()),
            output=(transport.output(),),
            ended=self.ended,
            failed=self.failed,
            transport_name=f"livekit server at {self._quotable(self._url)}",
        )

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
        """Count whoever was in the room before egma got into it.

        The events above are the room telling egma who arrives. This is
        egma asking, once, immediately after the join — because the two
        can disagree by exactly one participant: the transport announces
        an already-present participant as the first joiner while the
        connect is still returning, and nothing guarantees that handler
        has run by the time the join is awaited here. Asking costs one
        local read and closes that gap, so an agent that was quicker into
        the room than egma is somebody who came rather than nobody.

        The read is of the room's *remote* participants, so egma cannot
        count itself and turn an empty room into somebody who came.

        It never raises. A transport that stops offering this read leaves
        the wait exactly where the events put it, which is the behaviour
        without it, rather than failing a simulation over a check.
        """
        if self.arrivals.is_set() or self._transport is None:
            return
        try:
            present = self._transport.get_participants()
        except Exception:
            return
        if present:
            self.arrivals.set()

    def register_rpc(self, method: str, handler: RpcMethod) -> None:
        if self._transport is None:
            raise MediaBackendError(
                f"{method} was offered before the room transport existed",
                ending=ERROR,
            )
        # Pipecat 1.7.0 offers no public path from LiveKitTransport to its
        # local participant. This one access is pinned in uv.lock and covered
        # by the room mock-tool tests.
        self._transport._client.room.local_participant.register_rpc_method(
            method, answering(handler)
        )

    async def leave(self) -> None:
        """Release transport event handlers after the pipeline has ended."""
        transport, self._transport = self._transport, None
        input_drain, self._input_drain = self._input_drain, None
        self._leaving = True
        self.ended.set()
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
