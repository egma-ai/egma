"""Initial STT handshakes use the pinned Pipecat connection path, offline."""

import asyncio
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pipecat.services.websocket_service import WebsocketService
from websockets.datastructures import Headers
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response
from websockets.protocol import State

from egma_simulator import speech
from egma_simulator.speech import SpeechProviders, _openai_realtime_ears


def refused(status, headers=None, body=b""):
    return InvalidStatus(
        Response(status, "provider refusal", Headers(headers or {}), body)
    )


def ear(monkeypatch, outcomes):
    attempted = asyncio.Event()
    remaining = iter(outcomes)

    async def connect(*args, **kwargs):
        attempted.set()
        outcome = next(remaining)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    connector = AsyncMock(side_effect=connect)
    connector.attempted = attempted
    monkeypatch.setattr(WebsocketService, "_websocket_connect", connector)
    monkeypatch.setattr(speech, "OPENAI_STT_RETRY_DELAY_SECONDS", 0)
    leg, _ready = _openai_realtime_ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key="SENTINEL-STT-KEY",
            stt_model="gpt-live-transcribe",
        )
    )
    leg.push_error = AsyncMock()
    # The test stops at the real handshake; there is no remote receive loop.
    leg._receive_task = object()
    return leg, connector


@pytest.mark.parametrize(
    "fault",
    [
        refused(503), TimeoutError(),
        ConnectionResetError(), socket.gaierror(socket.EAI_AGAIN, "temporary DNS"),
    ],
)
async def test_initial_connection_recovers_before_reporting_pipeline_error(
    monkeypatch,
    caplog,
    fault,
):
    connected = SimpleNamespace(state=State.OPEN)
    leg, connector = ear(monkeypatch, [fault, connected])
    await leg._connect()
    assert leg._websocket is connected
    assert connector.await_count == 2
    leg.push_error.assert_not_awaited()
    assert "SENTINEL-STT-KEY" not in caplog.text
    attributes = caplog.records[-1]._egma_log_attributes
    assert attributes["egma.speech.attempt"] == 1
    assert attributes["egma.speech.will_retry"] is True


async def test_rate_limit_with_retry_after_is_retried_once(monkeypatch):
    connected = SimpleNamespace(state=State.OPEN)
    leg, connector = ear(monkeypatch, [refused(429, {"Retry-After": "0"}), connected])
    await leg._connect()
    assert connector.await_count == 2
    assert leg._websocket is connected
    leg.push_error.assert_not_awaited()


async def test_retry_after_wait_is_not_shortened(monkeypatch):
    connected = SimpleNamespace(state=State.OPEN)
    leg, connector = ear(monkeypatch, [refused(429, {"Retry-After": "1"}), connected])
    started = asyncio.get_running_loop().time()
    await leg._connect()
    assert asyncio.get_running_loop().time() - started >= 1
    assert connector.await_count == 2
    assert leg._websocket is connected


@pytest.mark.parametrize("date, attempts", [
    ("Sun, 06 Nov 1994 08:49:37 GMT", 2),
])
async def test_retry_after_http_date_obeys_connection_budget(
    monkeypatch, date, attempts
):
    leg, connector = ear(monkeypatch, [
        refused(429, {"Retry-After": date}), SimpleNamespace(state=State.OPEN)
    ])
    await leg._connect()
    assert connector.await_count == attempts


async def test_cancellation_stops_retry_backoff(monkeypatch):
    leg, connector = ear(monkeypatch, [refused(502)])
    monkeypatch.setattr(speech, "OPENAI_STT_RETRY_DELAY_SECONDS", 60)
    connecting = asyncio.create_task(leg._connect())
    await asyncio.wait_for(connector.attempted.wait(), 1)
    assert connector.await_count == 1
    connecting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await connecting
    leg.push_error.assert_not_awaited()


async def test_stalled_handshake_is_bounded(monkeypatch):
    leg, connector = ear(monkeypatch, [])
    monkeypatch.setattr(speech, "LISTENING_READY_SECONDS", 0.02)

    async def stall(*args, **kwargs):
        await asyncio.Event().wait()

    connector.side_effect = stall
    await asyncio.wait_for(leg._connect(), 1)
    assert connector.await_count == 1
    leg.push_error.assert_awaited_once()
    assert isinstance(leg.push_error.call_args.kwargs["exception"], TimeoutError)


@pytest.mark.parametrize("cancel", [False, True])
async def test_pipeline_stt_startup_failure_keeps_its_source_and_cancels_promptly(
    tmp_path,
    monkeypatch,
    cancel,
):
    from room_stub import RoomStub
    from test_plug_livekit import room_walk

    from egma_simulator import conductor as conductor_module
    from egma_simulator.conversation import ConversationControls
    from egma_simulator.speech import SpeechFault

    leg, connector = ear(monkeypatch, [refused(502)] * 3)
    if cancel:
        monkeypatch.setattr(speech, "OPENAI_STT_RETRY_DELAY_SECONDS", 60)
    build_legs = conductor_module.build_legs

    def with_real_stt(*args, **kwargs):
        legs = build_legs(*args, **kwargs)
        legs.stt = leg
        return legs

    # Use Pipecat's actual error propagation in the running pipeline.
    del leg.push_error
    leg._receive_task = None
    monkeypatch.setattr(conductor_module, "build_legs", with_real_stt)
    controls = ConversationControls()
    walking = asyncio.create_task(
        room_walk(
            tmp_path,
            RoomStub(),
            monkeypatch,
            controls=controls,
            scenario="One point.",
            max_duration_seconds=30,
        )
    )
    try:
        if cancel:
            await asyncio.wait_for(connector.attempted.wait(), 2)
            controls.request_cancel()
            result, turns, _, _ = await asyncio.wait_for(walking, 2)
            assert result.status == "canceled"
            assert not turns
            assert connector.await_count == 1
        else:
            with pytest.raises(SpeechFault, match="speech recognition failed") as fault:
                await asyncio.wait_for(walking, 3)
            assert "502" in str(fault.value)
            assert "livekit server" not in str(fault.value)
    finally:
        if not walking.done():
            walking.cancel()
            await asyncio.gather(walking, return_exceptions=True)
