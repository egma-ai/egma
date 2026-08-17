"""A LiveKit room exposed directly to the simulator's Pipecat pipeline."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from ..contract import ERROR
from ..mock_tools import MockToolRefusal
from . import MediaBackendError, RemoteParticipantLeftFrame, VoiceMedia

logger = logging.getLogger(__name__)

RpcMethod = Callable[[str], Awaitable[str]]

ROOM_PREFIX = "egma-sim"
PERSONA_IDENTITY = "egma-persona"
CONNECT_SECONDS = 30.0
AUDIO_STREAM_CLOSE_SECONDS = 2.0
PIPECAT_VERSION = "1.7.0"
LIVEKIT_VERSION = "1.1.14"
QUOTED_REFUSAL_CHARS = 200


def fresh_room_name() -> str:
    return f"{ROOM_PREFIX}-{uuid.uuid4().hex}"


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


class _Pipecat17InputDrain:
    """Order participant departure after Pipecat 1.7.0's inbound queues.

    Pipecat has no public input-drain operation. LiveKit 1.1.14's iterator also
    stops as soon as its native task ends, before it reads buffered frames that
    precede the queue's explicit end marker. This exact-version shim replaces
    its stream reader and close coordinator, makes its existing client iterator
    joinable, then joins BaseInput before one ordinary control frame enters the
    pipeline. Pipecat's conversion and push path remain unchanged.
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
            reader = client._process_audio_stream
            client_iterator = client.get_next_audio_frame
            stream_closer = client._close_audio_stream
        except AttributeError as changed:
            raise MediaBackendError(
                "pipecat 1.7 no longer exposes the livekit input drain needed "
                "to order participant departure after audio",
                ending=ERROR,
            ) from changed
        if (
            type(audio_queue) is not asyncio.Queue
            or not audio_queue.empty()
            or not isinstance(streams, dict)
            or not callable(reader)
            or not callable(client_iterator)
            or not callable(stream_closer)
        ):
            raise MediaBackendError(
                "pipecat 1.7 no longer exposes the livekit input drain needed "
                "to order participant departure after audio",
                ending=ERROR,
            )
        self._input = input_transport
        self._failed = failed
        self._stock_close = stream_closer
        self._canceling = False
        self._audio_queue = _JoinAfterPipecatConversion()
        client._audio_queue = self._audio_queue
        self._ring_queue_type = RingQueue
        self._audio_event_type = rtc.AudioFrameEvent
        self._streams: dict[str, tuple[object, asyncio.Task[Any]]] = streams
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

    async def _read_audio_stream(self, stream: object, participant_id: str) -> None:
        """Read LiveKit 1.1.14 through its explicit end marker."""
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
                await self._audio_queue.put((event, participant_id))
        except asyncio.CancelledError:
            raise
        except Exception:
            self._failed.set()
            raise RuntimeError("the livekit input stream could not be read") from None

    def _finish_for(self, participant_id: str) -> asyncio.Task[None] | None:
        entry = self._streams.get(participant_id)
        owned = self._finishes.get(participant_id)
        if owned is not None:
            owned_entry, finish = owned
            if entry is None or entry is owned_entry:
                return finish
        if entry is None:
            return None
        finish = asyncio.create_task(
            self._finish_stream(participant_id, entry),
            name="livekit-audio-stream-finish",
        )
        self._finishes[participant_id] = (entry, finish)
        return finish

    async def finish_stream(self, participant_id: str) -> None:
        """Drain one unsubscribed stream without declaring a departure."""
        if self._canceling:
            await self._stock_close(participant_id)
            return
        finish = self._finish_for(participant_id)
        if finish is not None:
            await asyncio.shield(finish)

    async def _finish_stream(
        self,
        participant_id: str,
        entry: tuple[object, asyncio.Task[Any]],
    ) -> None:
        stream, reader = entry
        try:
            async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                if self._streams.get(participant_id) is entry:
                    self._streams.pop(participant_id)
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

    async def _finish_departure(
        self, participant_id: str, completed: asyncio.Event
    ) -> None:
        finish = self._finish_for(participant_id)
        try:
            async with asyncio.timeout(AUDIO_STREAM_CLOSE_SECONDS):
                if finish is not None:
                    await asyncio.shield(finish)
                await self._audio_queue.join()
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
                acknowledged = asyncio.Event()
                marker = RemoteParticipantLeftFrame(completed=acknowledged)
                await self._input.push_frame(marker)
                await acknowledged.wait()
                completed.set()
        except TimeoutError:
            if finish is not None and not finish.done():
                finish.cancel()
                await asyncio.gather(finish, return_exceptions=True)
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

    @property
    def joined(self) -> bool:
        return self._transport is not None

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
