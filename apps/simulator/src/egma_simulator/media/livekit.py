"""The LiveKit driver: a room joined outbound, and a call placed into it.

Two halves, both LiveKit's own:

- **The room.** The simulator joins it through Pipecat's stock LiveKit
  transport, purely outbound — signalling over a websocket it opens,
  media over ICE it negotiates — so the simulator needs no inbound
  network surface to conduct a phone call. Nothing dials the simulator;
  the simulator dials.
- **The call.** LiveKit's SIP service places it, over a SIP trunk the
  deployment brings, and the answering phone appears in the room as an
  ordinary participant. Pipecat ships no example of this half, so the
  ``create_sip_participant`` call below is written here — it is about
  twenty lines, and it is what turns a room into a phone call.

The same driver serves a self-hosted LiveKit and LiveKit Cloud, which
are the same API behind the same URL: a deployment moves between them by
changing one variable, and nothing in this file knows the difference.

The trunk is the deployment's, not the spec's: a customer brings one from
any carrier, either as a reference to a trunk already stored in LiveKit
or as the inline fields LiveKit documents for outbound credential auth.
Both are checked at startup (see
:class:`egma_simulator.config.MediaSettings`) and arrive here already
good, so nothing in this file reads an environment variable and nothing
in it can be the first to discover a deployment cannot dial.

What can only be known at dial time stays at dial time: a trunk whose
credentials the *carrier* rejects is a SIP refusal like any other, and it
is reported as one.

(This module is named for the product it drives. ``from livekit import
api`` inside it reaches the installed LiveKit package, not this file:
Python resolves imports absolutely.)
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid

from ..config import MediaSettings
from ..redaction import SecretRegistry
from ..speech import duration_seconds
from . import ERROR, NOT_ANSWERED, MediaBackendError, sip_refusal

logger = logging.getLogger(__name__)

ROOM_PREFIX = "egma-sim"
"""What a simulation's room is called. One room per call, never reused —
a room that outlived its call would put two simulations on one line."""

PERSONA_IDENTITY = "egma-persona"
"""Who the simulator is in the room. The *agent* under test is whoever
answers the phone; this name is only ever the caller's."""

CONNECT_SECONDS = 30.0
"""How long joining the room may take before it counts as a bridge that
cannot be reached."""

TEARDOWN_SECONDS = 10.0
"""How long a torn-down call may take to finish before it is cancelled."""

QUOTED_REFUSAL_CHARS = 200
"""How much of somebody else's refusal is quoted into a reason: enough to
carry their own words about what was wrong, short of pasting a page."""


async def _first_of(*events: asyncio.Event, within: float) -> bool:
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
    """The audio of one call, once the room is joined.

    Frames of the far end's audio arrive from the transport's input and
    wait in a queue; the persona's audio goes out through the transport's
    output, which paces it onto the wire the way a voice really travels.
    """

    def __init__(self, transport: object, *, band_hz: int) -> None:
        self._transport = transport
        self._band_hz = band_hz
        self._heard: asyncio.Queue[bytes] = asyncio.Queue()
        self._left = asyncio.Event()

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def far_end_left(self) -> bool:
        return self._left.is_set()

    def note_arrival(self, pcm: bytes) -> None:
        self._heard.put_nowait(pcm)

    def note_departure(self) -> None:
        """The far end is off the line — the SIP participant left the room.

        On a phone call there is no other signal and no better one: the
        agent hanging up *is* the participant leaving.
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


class LiveKitBackend:
    """One outbound call over LiveKit, per instance."""

    def __init__(
        self,
        *,
        settings: MediaSettings,
        config: dict,
        band_hz: int,
        caller_id: str | None,
    ) -> None:
        if config:
            raise MediaBackendError(
                "the livekit media backend reads no connection config: its "
                f"trunk belongs to the deployment, so {sorted(config)} was "
                "handed over by mistake"
            )
        if settings.livekit_url is None:
            # Unreachable through a started simulator, which checks this at
            # startup and names the variable. Kept because a driver that
            # trusted its settings silently would fail somewhere far away
            # from the thing that was wrong.
            raise MediaBackendError(
                "the livekit media backend was built without a livekit to "
                "place calls through"
            )
        self._settings = settings
        self._band_hz = band_hz
        self._caller_id = caller_id or settings.trunk_number
        # One registry, built from the same secrets the process-wide log
        # filter was given at startup, so what a driver quotes goes through
        # the same scrubbing every log line does rather than through a
        # second implementation of it.
        self._secrets = SecretRegistry()
        self._secrets.register(list(settings.secrets))
        self._room_name = f"{ROOM_PREFIX}-{uuid.uuid4().hex}"
        self._session: RoomSession | None = None
        self._transport: object | None = None
        self._running: asyncio.Task | None = None
        self._worker: object | None = None
        self._dialling: asyncio.Task | None = None

    @property
    def room_name(self) -> str:
        """The room this call is conducted in — one room, one call."""
        return self._room_name

    async def create_session(self) -> RoomSession:
        """Join the room, outbound, and answer with the call's audio."""
        from pipecat.frames.frames import Frame, InputAudioRawFrame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.worker import PipelineParams, PipelineWorker
        from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
        from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
        from pipecat.workers.runner import WorkerRunner

        transport = LiveKitTransport(
            url=self._settings.livekit_url,
            token=self._room_token(),
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

        @transport.event_handler("on_participant_disconnected")
        async def _far_end_left(_transport: object, _participant: str) -> None:
            session.note_departure()

        class _Ear(FrameProcessor):
            """Where the far end's audio leaves the transport and becomes
            this call's audio."""

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
            # a room that was, and the call would be dialled into it.
            told.append(str(getattr(error, "error", error)))
            refused.set()

        self._worker = worker
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        self._running = asyncio.create_task(runner.run(), name="phone-transport")

        if not await _first_of(joined, refused, within=CONNECT_SECONDS):
            raise MediaBackendError(
                f"the livekit server at {self._settings.livekit_url} did not let the "
                f"simulator into a room within {CONNECT_SECONDS:.0f}s",
                ending=ERROR,
            )
        if refused.is_set():
            raise MediaBackendError(
                f"the livekit server at {self._settings.livekit_url} would not let "
                f"the simulator into a room: {self._quotable('; '.join(told))}",
                ending=ERROR,
            )

        self._session = session
        return session

    async def dial(self, number: str) -> None:
        """Ask LiveKit to place the call. Returns as soon as it is away."""
        self._dialling = asyncio.create_task(
            self._place(number), name=f"dial:{self._room_name}"
        )

    async def wait_answered(self, seconds: float) -> str:
        """Block until somebody is on the line, or say why nobody is."""
        if self._dialling is None:
            raise MediaBackendError("an answer was waited for before a dial")
        try:
            return await asyncio.wait_for(self._dialling, timeout=seconds)
        except TimeoutError as rang_out:
            raise MediaBackendError(
                f"the call was not answered: it rang for {seconds:.0f}s and "
                "nothing picked up",
                ending=NOT_ANSWERED,
            ) from rang_out

    async def teardown(self) -> None:
        """End the call and let go of everything, from any state.

        Deleting the room is what ends the call: LiveKit tears the SIP leg
        down with the room it was in, which is safe whether the call was
        answered, refused, or never placed.
        """
        dialling, self._dialling = self._dialling, None
        if dialling is not None:
            # Awaited whether it finished or not: a dial that failed with
            # nobody waiting on it would otherwise be an unretrieved
            # exception logged from the event loop, out of context and out
            # of order with the record.
            if not dialling.done():
                dialling.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await dialling
        try:
            await self._end_transport()
        finally:
            await self._delete_room()

    # -- The parts that speak to LiveKit -------------------------------------

    def _room_token(self) -> str:
        """The persona's own way into its room, and nothing else's."""
        from livekit import api

        return (
            api.AccessToken(
                self._settings.livekit_api_key, self._settings.livekit_api_secret
            )
            .with_identity(PERSONA_IDENTITY)
            .with_name(PERSONA_IDENTITY)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=self._room_name,
                    can_publish=True,
                    can_subscribe=True,
                )
            )
            .to_jwt()
        )

    async def _place(self, number: str) -> str:
        """One `CreateSIPParticipant`, waited out, or the carrier's refusal.

        ``wait_until_answered`` is what makes this one call rather than a
        request and a poll: LiveKit holds it open until the phone is
        picked up, and raises with the carrier's own SIP status when it
        is not. That status is the whole diagnosis, so it is carried up
        rather than summarised away.
        """
        from livekit import api

        request = api.CreateSIPParticipantRequest(
            room_name=self._room_name,
            sip_call_to=number,
            # No participant identity of our own: LiveKit mints one for the
            # SIP leg, and that identity is what the report carries as its
            # join to the platform's own telemetry.
            participant_name="agent-under-test",
            wait_until_answered=True,
            play_dialtone=False,
        )
        if self._settings.trunk_id is not None:
            request.sip_trunk_id = self._settings.trunk_id
        else:
            request.trunk.hostname = self._settings.trunk_address
            if self._settings.trunk_username is not None:
                request.trunk.auth_username = self._settings.trunk_username
            if self._settings.trunk_password is not None:
                request.trunk.auth_password = self._settings.trunk_password
        if self._caller_id is not None:
            request.sip_number = self._caller_id

        lkapi = api.LiveKitAPI(
            self._settings.livekit_url,
            self._settings.livekit_api_key,
            self._settings.livekit_api_secret,
        )
        try:
            participant = await lkapi.sip.create_sip_participant(request)
        except api.SipCallError as refused:
            raise sip_refusal(
                refused.sip_status_code,
                refused.sip_status,
                told=self._quotable(refused.message),
            ) from refused
        except api.ServerError as refused:
            raise MediaBackendError(
                "the call could not be placed: livekit answered "
                f"{refused.code} — {self._quotable(refused.message)}",
                ending=ERROR,
            ) from refused
        except asyncio.CancelledError:
            raise
        except Exception as unreachable:
            raise MediaBackendError(
                "the call could not be placed: the livekit server at "
                f"{self._settings.livekit_url} could not be reached — "
                f"{self._quotable(repr(unreachable))}",
                ending=ERROR,
            ) from unreachable
        finally:
            with contextlib.suppress(Exception):
                await lkapi.aclose()
        return participant.participant_identity

    async def _end_transport(self) -> None:
        if self._running is None:
            return
        from pipecat.frames.frames import EndFrame

        try:
            await self._worker.queue_frame(EndFrame())
            await asyncio.wait_for(
                asyncio.shield(self._running), timeout=TEARDOWN_SECONDS
            )
        except Exception as unfinished:
            logger.warning("the call's transport did not end cleanly: %r", unfinished)
        finally:
            if not self._running.done():
                self._running.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._running
            self._running = None

    async def _delete_room(self) -> None:
        if self._transport is None:
            # No room was ever joined, so there is no room to delete and
            # nobody to ask — a trunk refused at construction must cost a
            # call to LiveKit that could only fail.
            return
        from livekit import api

        lkapi = api.LiveKitAPI(
            self._settings.livekit_url,
            self._settings.livekit_api_key,
            self._settings.livekit_api_secret,
        )
        try:
            await lkapi.room.delete_room(
                api.DeleteRoomRequest(room=self._room_name)
            )
        except Exception as unfinished:
            # A room that was never created, or a server that cannot be
            # reached to be told, has nothing left to be told. Teardown is
            # not worth raising over — it would eat the walk's own answer.
            logger.info(
                "the room %s was not deleted: %s",
                self._room_name,
                self._quotable(repr(unfinished)),
            )
        finally:
            with contextlib.suppress(Exception):
                await lkapi.aclose()

    def _quotable(self, told: str) -> str:
        """Somebody else's words, minus this driver's secrets, short enough
        to read. A bridge or a carrier that echoed a trunk password back
        must not get it repeated into a reason or into the traceback
        logged beneath one."""
        return self._secrets.redact(told)[:QUOTED_REFUSAL_CHARS]
