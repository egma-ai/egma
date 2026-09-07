"""Provider completion and media failure stay distinct at the real callbacks."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import pytest
from aiohttp import web
from livekit import rtc
from retell_stub import RetellStub, serving
from test_plug_livekit import ScriptedRtcRoom
from test_plug_retell_web_call import AN_AGENT, SENTINEL_KEY

from egma_simulator.media.room import JoinedRoom
from egma_simulator.media.livekit_room import TextRoom
from egma_simulator.plugs.retell_web_call import RetellWebCall
from egma_simulator.plugs import retell_web_call


@dataclass
class FinalCallStub(RetellStub):
    status: str = "ended"
    reason: str = "agent_hangup"
    returned_id: str | None = None
    checks: int = 0
    pending_checks: int = 0
    response_delay: float = 0

    def build_app(self) -> web.Application:
        app = super().build_app()

        async def get_call(request: web.Request) -> web.Response:
            self._authorized(request)
            self.checks += 1
            if self.response_delay:
                await asyncio.sleep(self.response_delay)
            return web.json_response(
                {
                    "call_id": self.returned_id or request.match_info["call_id"],
                    "call_status": (
                        "ongoing" if self.checks <= self.pending_checks else self.status
                    ),
                    "disconnection_reason": self.reason,
                }
            )

        app.router.add_get("/v2/get-call/{call_id}", get_call)
        return app


def connected_room(room: JoinedRoom, media: Any) -> tuple[Any, list[object]]:
    """Keep Pipecat real, replacing only RTC networking and the final sink."""
    input_transport = media.input[0]
    input_transport._audio_in_queue = asyncio.Queue()
    client = input_transport._client
    client._room = ScriptedRtcRoom()
    room._input_drain.watch_mutes()
    room._connected.set()
    room.carrying_audio.set()
    room.arrivals.set()
    markers: list[object] = []

    async def acknowledge(frame: Any, *_args: object) -> None:
        markers.append(frame)
        frame.completed.set()

    input_transport.push_frame = acknowledge
    return client, markers


async def disconnect(client: Any, media: Any, reason: int) -> None:
    # RTC invokes all synchronous listeners before Pipecat's scheduled async
    # callback runs. Pipecat 1.7 drops the reason from that second callback.
    for handler in client._room.handlers.get("disconnected", []):
        handler(reason)
    await client._async_on_disconnected()
    ended = asyncio.create_task(media.ended.wait())
    failed = asyncio.create_task(media.failed.wait())
    try:
        await asyncio.wait_for(
            asyncio.wait((ended, failed), return_when=asyncio.FIRST_COMPLETED), 5
        )
    finally:
        for task in (ended, failed):
            task.cancel()
        await asyncio.gather(ended, failed, return_exceptions=True)


async def test_livekit_room_deletion_finishes_the_established_exchange():
    room = JoinedRoom(url="wss://livekit.test", token="test", room_name="room")
    media = room.create_transport()
    client, markers = connected_room(room, media)
    try:
        await disconnect(client, media, rtc.DisconnectReason.ROOM_DELETED)
        assert not media.failed.is_set(), "normal room deletion became PlugError"
        assert media.ended.is_set()
        assert len(markers) == 1, "completion must follow the audio drain marker"
    finally:
        await room.leave()


@pytest.mark.parametrize("departed_first", [False, True])
async def test_chat_room_closure_preserves_an_established_ending(departed_first: bool):
    class ChatWire(ScriptedRtcRoom):
        def register_text_stream_handler(self, *_args: object) -> None:
            pass

    room = TextRoom(url="wss://livekit.test", token="test", room_name="room")
    wire = ChatWire()
    room._room = wire
    room._watch(wire)
    wire.handlers["participant_connected"][0](object())
    if departed_first:
        wire.handlers["participant_disconnected"][0](object())
    wire.handlers["disconnected"][0](rtc.DisconnectReason.ROOM_DELETED)
    assert not room.failed.is_set()
    assert room.ended.is_set()


@pytest.mark.parametrize("reason", ["agent_hangup", "inactivity", "user_hangup"])
async def test_retell_final_ended_status_confirms_a_whole_room_close(reason: str):
    stub = FinalCallStub(api_key=SENTINEL_KEY, reason=reason)
    async with serving(stub) as server:
        plug = RetellWebCall(
            modality="voice",
            access_variant="retell_web_call.api_key",
            config={"retellAgentId": AN_AGENT, "baseUrl": server.base_url},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id="sim-completion",
        )
        media = await plug.prepare()
        client, markers = connected_room(plug._room._room, media)
        try:
            await disconnect(client, media, rtc.DisconnectReason.CLIENT_INITIATED)
            assert not media.failed.is_set(), "Retell ended this call normally"
            assert media.ended.is_set()
            assert len(markers) == 1
            assert stub.checks == 1
        finally:
            await plug.close()


@pytest.mark.parametrize(
    ("reason", "connected", "heard"),
    [
        (rtc.DisconnectReason.ROOM_DELETED, False, True),
        (rtc.DisconnectReason.ROOM_DELETED, True, False),
        (rtc.DisconnectReason.CLIENT_INITIATED, True, True),
        (rtc.DisconnectReason.STATE_MISMATCH, True, True),
    ],
)
async def test_unconfirmed_livekit_disconnect_remains_failure(
    reason: int, connected: bool, heard: bool
):
    room = JoinedRoom(url="wss://livekit.test", token="test", room_name="room")
    media = room.create_transport()
    client, markers = connected_room(room, media)
    if not connected:
        room._connected.clear()
    if not heard:
        room.carrying_audio.clear()
    try:
        await disconnect(client, media, reason)
        assert media.failed.is_set()
        assert not media.ended.is_set()
        assert not markers
    finally:
        await room.leave()


@pytest.mark.parametrize("media_error", [False, True])
async def test_room_close_waits_for_departure_and_preserves_drain_errors(media_error: bool):
    room = JoinedRoom(url="wss://livekit.test", token="test", room_name="room")
    media = room.create_transport()
    client, markers = connected_room(room, media)
    queue = media.input[0]._audio_in_queue
    queue.put_nowait(object())
    transport = room._transport
    left = transport._event_handlers["on_participant_disconnected"].handlers[0]
    departure = asyncio.create_task(left(transport, "agent"))
    await asyncio.sleep(0)
    closing = asyncio.create_task(disconnect(client, media, rtc.DisconnectReason.UNKNOWN_REASON))
    try:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not media.failed.is_set(), "the room close canceled the audio drain"
        assert not media.ended.is_set()
        assert not markers
        if media_error:
            # An independently reported input error must win, even after
            # a participant has left and a room close has been observed.
            media.failed.set()
        queue.get_nowait()
        queue.task_done()
        await asyncio.wait_for(asyncio.gather(departure, closing), 1)
        assert media.failed.is_set() is media_error
        assert media.ended.is_set() is not media_error
        assert len(markers) == (0 if media_error else 1)
    finally:
        await room.leave()
        await asyncio.gather(departure, closing, return_exceptions=True)


@pytest.mark.parametrize(
    ("status", "returned_id"), [("error", None), ("ongoing", None), ("ended", "another-call")]
)
async def test_retell_cannot_confirm_a_failed_unfinished_or_different_call(
    status: str, returned_id: str | None, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(retell_web_call, "FINAL_STATUS_SECONDS", 0.05)
    stub = FinalCallStub(api_key=SENTINEL_KEY, status=status, returned_id=returned_id)
    async with serving(stub) as server:
        plug = RetellWebCall(
            modality="voice",
            access_variant="retell_web_call.api_key",
            config={"retellAgentId": AN_AGENT, "baseUrl": server.base_url},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id="sim-completion",
        )
        media = await plug.prepare()
        client, markers = connected_room(plug._room._room, media)
        try:
            await disconnect(client, media, rtc.DisconnectReason.ROOM_DELETED)
            assert media.failed.is_set()
            assert not media.ended.is_set()
            assert not markers
            assert stub.checks >= 1
        finally:
            await plug.close()


async def test_retell_final_status_can_arrive_after_the_room_close():
    stub = FinalCallStub(api_key=SENTINEL_KEY, pending_checks=1)
    async with serving(stub) as server:
        plug = RetellWebCall(
            modality="voice",
            access_variant="retell_web_call.api_key",
            config={"retellAgentId": AN_AGENT, "baseUrl": server.base_url},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id="sim-completion",
        )
        media = await plug.prepare()
        client, markers = connected_room(plug._room._room, media)
        try:
            await disconnect(client, media, rtc.DisconnectReason.CLIENT_INITIATED)
            assert media.ended.is_set()
            assert not media.failed.is_set()
            assert len(markers) == 1
            assert stub.checks == 2
        finally:
            await plug.close()


async def test_local_teardown_cancels_a_pending_provider_status_check():
    stub = FinalCallStub(api_key=SENTINEL_KEY, response_delay=0.2)
    async with serving(stub) as server:
        plug = RetellWebCall(
            modality="voice",
            access_variant="retell_web_call.api_key",
            config={"retellAgentId": AN_AGENT, "baseUrl": server.base_url},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id="sim-completion",
        )
        media = await plug.prepare()
        room = plug._room._room
        client, markers = connected_room(room, media)
        closing = asyncio.create_task(disconnect(client, media, rtc.DisconnectReason.CLIENT_INITIATED))
        try:
            async with asyncio.timeout(1):
                while not stub.checks:
                    await asyncio.sleep(0)
            await asyncio.wait_for(plug.close(), 0.1)
            await closing
            assert not media.failed.is_set()
            assert not markers, "a canceled simulation must not complete from provider status"
            assert room._remote_close.done()
        finally:
            await plug.close()
            await asyncio.gather(closing, return_exceptions=True)
