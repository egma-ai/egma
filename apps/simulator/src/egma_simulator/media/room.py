"""A LiveKit room exposed directly to the simulator's Pipecat pipeline."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from ..contract import ERROR
from ..mock_tools import MockToolRefusal
from . import MediaBackendError, VoiceMedia

logger = logging.getLogger(__name__)

RpcMethod = Callable[[str], Awaitable[str]]

ROOM_PREFIX = "egma-sim"
PERSONA_IDENTITY = "egma-persona"
CONNECT_SECONDS = 30.0
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
        self._connected = asyncio.Event()
        self.arrivals = asyncio.Event()
        self.carrying_audio = asyncio.Event()
        self.ended = asyncio.Event()

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

        @transport.event_handler("on_connected")
        async def _connected(_transport: object) -> None:
            self._connected.set()

        @transport.event_handler("on_disconnected")
        async def _disconnected(_transport: object) -> None:
            self.ended.set()

        @transport.event_handler("on_participant_connected")
        async def _arrived(_transport: object, _participant: str) -> None:
            self.arrivals.set()

        @transport.event_handler("on_participant_disconnected")
        async def _left(_transport: object, _participant: str) -> None:
            self.ended.set()

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
            input=(transport.input(), _Arrival()),
            output=(transport.output(),),
            ended=self.ended,
        )

    async def wait_connected(self) -> None:
        """Wait for the running Pipecat transport to enter the room."""
        if not await first_of(self._connected, self.ended, within=CONNECT_SECONDS):
            raise MediaBackendError(
                f"the livekit server at {self._url} did not let the simulator "
                f"into a room within {CONNECT_SECONDS:.0f}s",
                ending=ERROR,
            )
        if not self._connected.is_set():
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
        # LiveKitTransport offers no public path to its participant. This one
        # access is pinned to the Pipecat version in uv.lock and covered by the
        # room mock-tool tests.
        self._transport._client.room.local_participant.register_rpc_method(
            method, answering(handler)
        )

    async def leave(self) -> None:
        """Release transport event handlers after the pipeline has ended."""
        transport, self._transport = self._transport, None
        self.ended.set()
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
