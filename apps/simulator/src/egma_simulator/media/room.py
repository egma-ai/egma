"""A LiveKit room, joined outbound: what every room driver shares.

Two drivers in this package reach an agent through a LiveKit room, and
they reach it the same way — a room created by egma, a token minted for
the persona alone, a websocket the simulator opens and ICE it negotiates,
audio in and out through Pipecat's stock transport, and the room deleted
when it is over. What differs between them is only *how the agent gets
into the room*: over a SIP trunk for a phone call, by dispatching a worker
for a room connection. That difference is each driver's own; everything
above is here, written once.

Nothing in this file reads the environment and nothing decides policy. It
is handed a URL, a key pair and a band, and it opens and closes one room.

(``from livekit import api`` inside it reaches the installed LiveKit
package, not the module beside it: Python resolves imports absolutely.
Every such import sits inside a function, so a simulator that joins no
room never loads the library at all — see the quarantine suite.)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Callable

from ..contract import ERROR
from ..speech import duration_seconds
from . import MediaBackendError

logger = logging.getLogger(__name__)

ROOM_PREFIX = "egma-sim"
"""What a simulation's room is called. One room per simulation, never
reused — a room that outlived its exchange would put two simulations on
one line."""

PERSONA_IDENTITY = "egma-persona"
"""Who the simulator is in the room. The *agent* under test is whoever
else turns up; this name is only ever the caller's."""

CONNECT_SECONDS = 30.0
"""How long joining the room may take before it counts as a server that
cannot be reached."""

TEARDOWN_SECONDS = 10.0
"""How long a torn-down exchange may take to finish before it is cancelled."""

QUOTED_REFUSAL_CHARS = 200
"""How much of somebody else's refusal is quoted into a reason: enough to
carry their own words about what was wrong, short of pasting a page."""


def fresh_room_name() -> str:
    """A room name nothing else will ever have."""
    return f"{ROOM_PREFIX}-{uuid.uuid4().hex}"


async def first_of(*events: asyncio.Event, within: float) -> bool:
    """Wait until one of these happens, or say that none did."""
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


class RoomSession:
    """The audio of one exchange, once the room is joined.

    Frames of the far end's audio arrive from the transport's input and
    wait in a queue; the persona's audio goes out through the transport's
    output, which paces it onto the wire the way a voice really travels.
    """

    def __init__(self, transport: object, *, band_hz: int) -> None:
        self._transport = transport
        self._band_hz = band_hz
        self._heard: asyncio.Queue[bytes] = asyncio.Queue()
        self._left = asyncio.Event()
        self._carrying = asyncio.Event()

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def far_end_left(self) -> bool:
        return self._left.is_set()

    @property
    def carrying_audio(self) -> asyncio.Event:
        """Set once the far end's audio has flowed at all.

        A latch rather than a level: a driver waits on it to learn that
        the other side is really on the line, and what happens to the
        audio afterwards is the turn reader's business.
        """
        return self._carrying

    def note_arrival(self, pcm: bytes) -> None:
        self._heard.put_nowait(pcm)
        self._carrying.set()

    def note_departure(self) -> None:
        """The far end is off the line — its participant left the room.

        There is no other signal and no better one: the agent leaving the
        room *is* the agent ending the exchange.
        """
        self._left.set()

    async def send(self, pcm: bytes) -> None:
        """The persona's turn, said down the line, and waited out.

        A voice takes as long to say a sentence as the sentence lasts, and
        the transport writes the audio onto the wire at exactly that rate.
        Returning before it is all said would start the far end's turn
        while the persona was still talking — and every measurement of the
        answer would carry the persona's own speaking time inside it.

        What the line carried during all that is then dropped, because it
        is the far end listening rather than the far end answering. An
        agent that talks over the persona is lost with it: this seam
        exchanges whole turns, so speech that overlaps two of them has
        nowhere to go. What the record then shows is a conversation
        without interruptions, which is true of what was measured and not
        of what a real caller would have heard — worth knowing before
        reading a transcript for barge-in behavior.
        """
        from pipecat.frames.frames import OutputAudioRawFrame

        await self._transport.send_audio(
            OutputAudioRawFrame(
                audio=pcm, sample_rate=self._band_hz, num_channels=1
            )
        )
        await asyncio.sleep(duration_seconds(pcm, self._band_hz))
        while not self._heard.empty():
            self._heard.get_nowait()

    async def receive(self, seconds: float) -> bytes | None:
        try:
            return await asyncio.wait_for(self._heard.get(), timeout=seconds)
        except TimeoutError:
            return None


class JoinedRoom:
    """One room, from the way in to the way out.

    Built with everything it needs and nothing it could look up: the
    server, a token already minted, the room's name, and the band the
    pipeline above was assembled at. ``join`` opens it or refuses in the
    server's own words; ``leave`` ends the transport from any state.
    """

    def __init__(
        self,
        *,
        url: str,
        token: str,
        room_name: str,
        band_hz: int,
        quotable: Callable[[str], str] = lambda told: told,
    ) -> None:
        self._url = url
        self._token = token
        self._room_name = room_name
        self._band_hz = band_hz
        self._quotable = quotable
        self._session: RoomSession | None = None
        self._transport: object | None = None
        self._worker: object | None = None
        self._running: asyncio.Task | None = None
        self.arrivals: asyncio.Event = asyncio.Event()
        """Set once somebody other than the persona is in the room."""
        self.who_arrived: list[str] = []
        """Every participant that joined after the persona did, in order."""

    @property
    def session(self) -> RoomSession | None:
        """The exchange's audio, once the room is joined."""
        return self._session

    @property
    def joined(self) -> bool:
        """Whether a room was ever really opened. Nothing to delete if not."""
        return self._transport is not None

    async def join(self) -> RoomSession:
        """Join the room, outbound, and answer with the exchange's audio."""
        from pipecat.frames.frames import Frame, InputAudioRawFrame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineParams, PipelineWorker
        from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
        from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
        from pipecat.workers.runner import WorkerRunner

        transport = LiveKitTransport(
            url=self._url,
            token=self._token,
            room_name=self._room_name,
            params=LiveKitParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                audio_in_sample_rate=self._band_hz,
                audio_out_sample_rate=self._band_hz,
            ),
        )
        self._transport = transport
        session = RoomSession(transport, band_hz=self._band_hz)
        joined = asyncio.Event()
        refused = asyncio.Event()
        told: list[str] = []

        @transport.event_handler("on_connected")
        async def _in_the_room(_transport: object) -> None:
            joined.set()

        @transport.event_handler("on_participant_connected")
        async def _somebody_arrived(_transport: object, participant: str) -> None:
            self.who_arrived.append(str(participant))
            self.arrivals.set()

        @transport.event_handler("on_participant_disconnected")
        async def _far_end_left(_transport: object, _participant: str) -> None:
            session.note_departure()

        class _Ear(FrameProcessor):
            """Where the far end's audio leaves the transport and becomes
            this exchange's audio."""

            async def process_frame(
                self, frame: Frame, direction: FrameDirection
            ) -> None:
                await super().process_frame(frame, direction)
                if isinstance(frame, InputAudioRawFrame):
                    session.note_arrival(frame.audio)
                await self.push_frame(frame, direction)

        worker = PipelineWorker(
            Pipeline([transport.input(), _Ear(), transport.output()]),
            params=PipelineParams(
                audio_in_sample_rate=self._band_hz,
                audio_out_sample_rate=self._band_hz,
            ),
            # The walk owns the clock and the limits; a transport that
            # cancelled itself for being quiet would be a second, hidden
            # limit with no record of having tripped.
            idle_timeout_secs=None,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )

        @worker.event_handler("on_pipeline_error")
        async def _went_wrong(_worker: object, error: object) -> None:
            # A transport that cannot reach the server says so *here* and
            # nowhere else: the failure travels back up the pipeline as an
            # error frame the library itself calls non-fatal, and the
            # start frame reaches the end of the pipeline regardless. Read
            # any other way, a room that was never joined would look like
            # a room that was, and the exchange would be conducted into it.
            told.append(str(getattr(error, "error", error)))
            refused.set()

        self._worker = worker
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        self._running = asyncio.create_task(
            runner.run(), name=f"room-transport:{self._room_name}"
        )

        if not await first_of(joined, refused, within=CONNECT_SECONDS):
            raise MediaBackendError(
                f"the livekit server at {self._url} did not let the simulator "
                f"into a room within {CONNECT_SECONDS:.0f}s",
                ending=ERROR,
            )
        if refused.is_set():
            raise MediaBackendError(
                f"the livekit server at {self._url} would not let the "
                f"simulator into a room: {self._quotable('; '.join(told))}",
                ending=ERROR,
            )

        self._session = session
        return session

    async def leave(self) -> None:
        """End the transport and let go of it, from any state."""
        if self._running is None:
            return
        from pipecat.frames.frames import EndFrame

        try:
            await self._worker.queue_frame(EndFrame())
            await asyncio.wait_for(
                asyncio.shield(self._running), timeout=TEARDOWN_SECONDS
            )
        except Exception as unfinished:
            logger.warning(
                "the exchange's transport did not end cleanly: %r", unfinished
            )
        finally:
            if not self._running.done():
                self._running.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._running
            self._running = None
            self._session = None


def room_token(api_key: str, api_secret: str, room_name: str) -> str:
    """The persona's own way into its room, and nothing else's."""
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
    """Delete the room, and never raise about it.

    Deleting is what ends everything the room held — a SIP leg, a
    dispatched worker, the persona's own connection — so it is done on
    every path out. A room that was never created, or a server that
    cannot be reached to be told, has nothing left to be told; that is
    logged rather than raised, because a refusal here would eat the walk's
    own answer.
    """
    from livekit import api

    lkapi = api.LiveKitAPI(url, api_key, api_secret)
    try:
        await lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name))
    except Exception as unfinished:
        logger.info(
            "the room %s was not deleted: %s", room_name, quotable(repr(unfinished))
        )
    finally:
        with contextlib.suppress(Exception):
            await lkapi.aclose()
