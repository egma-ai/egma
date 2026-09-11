"""The shipped streaming adapters use the pinned selection exactly."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from egma_simulator.contract import spec_validator
from egma_simulator.speech import (
    CARTESIA_SPEED_RANGE,
    LISTENING_READY_SECONDS,
    OPENAI_REALTIME_PROXY_OPEN_SECONDS,
    OPENAI_REALTIME_PROXY_READY_SECONDS,
    PersonaVoice,
    SpeechFault,
    SpeechProviders,
    _daytona_deepgram_connect,
    _ears,
    _mouth,
    build_legs,
)

A_KEY = "sk-only-this-test-holds-this-one"


def contract_tts_speed_range() -> tuple[float, float]:
    speed_schema = spec_validator().schema["$defs"]["tts_selection"]["properties"][
        "speed"
    ]
    return (speed_schema["minimum"], speed_schema["maximum"])


CONTRACT_TTS_SPEED_RANGE = contract_tts_speed_range()


def capture_construction(
    monkeypatch: pytest.MonkeyPatch, service: type
) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    original = service.__init__

    def remember(instance: object, *args: object, **kwargs: Any) -> None:
        calls.append(kwargs)
        original(instance, *args, **kwargs)

    monkeypatch.setattr(service, "__init__", remember)
    return calls


def cartesia_voice(speed: float = 1.1) -> PersonaVoice:
    return PersonaVoice(
        provider="cartesia", voice_id="pinned-cartesia-voice", speed=speed
    )


def test_cartesia_speed_range_matches_the_simulation_contract():
    assert CONTRACT_TTS_SPEED_RANGE == (0.25, 4)
    assert CARTESIA_SPEED_RANGE == (0.6, 1.5)


@pytest.mark.parametrize("speed", CARTESIA_SPEED_RANGE)
def test_cartesia_receives_the_pinned_model_voice_and_speed(
    monkeypatch: pytest.MonkeyPatch,
    speed: float,
):
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    voice = cartesia_voice(speed)
    _leg, spoken_with, closers = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_model="sonic-3.5",
        ),
        voice,
    )

    settings = calls[0]["settings"]
    assert settings.model == "sonic-3.5"
    assert settings.voice == "pinned-cartesia-voice"
    assert settings.generation_config.speed == pytest.approx(speed)
    assert spoken_with == voice
    assert closers == ()


async def test_cartesia_tts_sends_its_key_in_a_websocket_header(monkeypatch):
    from pipecat.services.websocket_service import WebsocketService

    connected: list[tuple[str, dict[str, str]]] = []

    async def connect(_service: object, uri: str, **kwargs: Any) -> object:
        connected.append((uri, kwargs["additional_headers"]))
        return object()

    monkeypatch.setattr(WebsocketService, "_websocket_connect", connect)
    placeholder = "dtn_secret_cartesia_under_test"
    leg, _, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=placeholder,
            tts_model="sonic-3.5",
        ),
        cartesia_voice(),
    )

    await leg._websocket_connect(
        f"wss://api.cartesia.ai/tts/websocket?api_key={placeholder}"
        "&cartesia_version=2026-03-01"
    )

    uri, headers = connected[0]
    assert placeholder not in uri
    assert "api_key" not in uri
    assert "cartesia_version=2026-03-01" in uri
    assert headers == {"X-API-Key": placeholder}


@pytest.mark.parametrize(
    ("providers", "reason"),
    [
        (SpeechProviders(tts="cartesia", tts_model="sonic-3.5"), "key"),
        (SpeechProviders(tts="cartesia", tts_key=A_KEY), "model"),
    ],
)
def test_cartesia_refuses_an_incomplete_selection(
    providers: SpeechProviders, reason: str
):
    with pytest.raises(SpeechFault, match=reason):
        _mouth(providers, cartesia_voice())


@pytest.mark.parametrize(
    "speed",
    [CONTRACT_TTS_SPEED_RANGE[0] - 0.0001, CONTRACT_TTS_SPEED_RANGE[1] + 0.0001],
)
def test_cartesia_refuses_a_speed_it_cannot_honor(speed: float):
    with pytest.raises(SpeechFault, match="supported range"):
        _mouth(
            SpeechProviders(tts="cartesia", tts_key=A_KEY, tts_model="sonic-3.5"),
            cartesia_voice(speed),
        )


def test_cartesia_stt_receives_the_pinned_model(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.cartesia.stt import CartesiaSTTService

    calls = capture_construction(monkeypatch, CartesiaSTTService)
    _leg, connected = _ears(
        SpeechProviders(
            stt="cartesia_manual",
            stt_key=A_KEY,
            stt_model="ink-2",
        )
    )

    assert calls[0]["settings"].model == "ink-2"
    assert connected is not None


async def test_daytona_deepgram_sends_its_key_through_the_environment_proxy(
    monkeypatch: pytest.MonkeyPatch,
):
    from deepgram.listen.v1 import client as deepgram_listen_client
    from websockets.asyncio import client as websocket_client

    original_connector = deepgram_listen_client.websockets_client_connect
    monkeypatch.setattr(
        deepgram_listen_client,
        "websockets_client_connect",
        original_connector,
    )
    calls: list[tuple[str, dict[str, Any]]] = []

    protocol = object()

    class Connected:
        async def __aenter__(self) -> object:
            return protocol

        async def __aexit__(self, *_args: object) -> None:
            return None

    def connect(url: str, **kwargs: Any) -> Connected:
        calls.append((url, kwargs))
        return Connected()

    monkeypatch.setattr(websocket_client, "connect", connect)
    _ears(
        SpeechProviders(
            stt="deepgram",
            stt_key="dtn_secret_deepgram_under_test",
            stt_model="nova-3",
            use_environment_proxy=True,
        )
    )

    assert deepgram_listen_client.websockets_client_connect is (
        _daytona_deepgram_connect
    )
    connector = deepgram_listen_client.websockets_client_connect
    async with connector(
        "wss://api.deepgram.com/v1/listen",
        extra_headers={"Authorization": "Token dtn_secret_deepgram_under_test"},
    ) as connected:
        assert connected is protocol
    assert calls == [
        (
            "wss://api.deepgram.com/v1/listen",
            {
                "additional_headers": {
                    "Authorization": "Token dtn_secret_deepgram_under_test",
                },
                "proxy": True,
            },
        )
    ]


async def test_daytona_deepgram_redacts_modern_auth_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    from deepgram.core.api_error import ApiError
    from websockets.asyncio import client as websocket_client
    from websockets.exceptions import InvalidStatus

    class Rejected:
        async def __aenter__(self) -> object:
            raise InvalidStatus(SimpleNamespace(status_code=401))

        async def __aexit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(
        websocket_client, "connect", lambda *_args, **_kwargs: Rejected()
    )
    placeholder = "dtn_secret_deepgram_under_test"

    with pytest.raises(ApiError) as caught:
        async with _daytona_deepgram_connect(
            "wss://api.deepgram.com/v1/listen",
            extra_headers={"Authorization": f"Token {placeholder}"},
        ):
            pass

    assert caught.value.status_code == 401
    assert caught.value.headers is None
    assert placeholder not in str(caught.value)


def test_non_daytona_deepgram_keeps_the_sdk_connector(
    monkeypatch: pytest.MonkeyPatch,
):
    from deepgram.listen.v1 import client as deepgram_listen_client

    original_connector = deepgram_listen_client.websockets_client_connect
    monkeypatch.setattr(
        deepgram_listen_client,
        "websockets_client_connect",
        original_connector,
    )
    _ears(
        SpeechProviders(
            stt="deepgram",
            stt_key=A_KEY,
            stt_model="nova-3",
        )
    )

    assert deepgram_listen_client.websockets_client_connect is original_connector


@pytest.mark.parametrize(
    ("providers", "reason"),
    [
        (SpeechProviders(stt="cartesia_manual", stt_model="ink-2"), "key"),
        (SpeechProviders(stt="cartesia_manual", stt_key=A_KEY), "model"),
    ],
)
def test_cartesia_stt_refuses_an_incomplete_selection(
    providers: SpeechProviders, reason: str
):
    with pytest.raises(SpeechFault, match=reason):
        _ears(providers)


async def test_cartesia_stt_waits_until_its_socket_is_connected(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.services.cartesia import stt as cartesia_stt

    class PendingCartesiaSTT(FrameProcessor):
        created: PendingCartesiaSTT | None = None

        class Settings:
            def __init__(self, *, model: str) -> None:
                self.model = model

        def __init__(self, **_kwargs: object) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            PendingCartesiaSTT.created = self

        def event_handler(self, name: str):
            def register(handler):
                self.handlers[name] = handler
                return handler

            return register

        async def announce_connected(self) -> None:
            await self.handlers["on_connected"](self)

    monkeypatch.setattr(cartesia_stt, "CartesiaSTTService", PendingCartesiaSTT)
    _leg, connected = _ears(
        SpeechProviders(
            stt="cartesia_manual",
            stt_key=A_KEY,
            stt_model="ink-2",
        )
    )
    leg = PendingCartesiaSTT.created
    assert leg is not None
    assert connected is not None

    waiting = asyncio.create_task(connected())
    await asyncio.sleep(0)
    assert not waiting.done()

    await leg.announce_connected()
    await waiting


def test_openai_realtime_receives_the_pinned_model(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _leg, connected = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_model="gpt-live-transcribe",
        )
    )

    assert calls[0]["settings"].model == "gpt-live-transcribe"
    assert calls[0]["turn_detection"] is False
    assert connected is not None


async def test_proxied_openai_realtime_has_a_longer_opening_deadline(monkeypatch):
    from pipecat.services.websocket_service import WebsocketService

    calls: list[dict[str, Any]] = []

    async def connect(_service: object, _uri: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return object()

    monkeypatch.setattr(WebsocketService, "_websocket_connect", connect)
    legs = build_legs(
        SpeechProviders(
            stt="openai_realtime",
            stt_key="dtn_secret_openai_under_test",
            stt_model="gpt-live-transcribe",
            use_environment_proxy=True,
        ),
        voice=PersonaVoice(voice_id="scripted", provider=None, speed=None),
    )

    await legs.stt._websocket_connect("wss://api.openai.com/v1/realtime")

    assert calls == [
        {"proxy": True, "open_timeout": OPENAI_REALTIME_PROXY_OPEN_SECONDS}
    ]
    assert legs.listening_ready_seconds == OPENAI_REALTIME_PROXY_READY_SECONDS
    assert OPENAI_REALTIME_PROXY_READY_SECONDS > OPENAI_REALTIME_PROXY_OPEN_SECONDS


async def test_direct_openai_realtime_keeps_the_library_opening_deadline(monkeypatch):
    from pipecat.services.websocket_service import WebsocketService

    calls: list[dict[str, Any]] = []

    async def connect(_service: object, _uri: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return object()

    monkeypatch.setattr(WebsocketService, "_websocket_connect", connect)
    legs = build_legs(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_model="gpt-live-transcribe",
        ),
        voice=PersonaVoice(voice_id="scripted", provider=None, speed=None),
    )

    await legs.stt._websocket_connect("wss://api.openai.com/v1/realtime")

    assert calls == [{}]
    assert legs.listening_ready_seconds == LISTENING_READY_SECONDS


async def test_live_transcribe_uses_the_plural_languages_request():
    leg, _connected = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_model="gpt-live-transcribe",
        ),
        language="es-MX",
    )
    service = leg  # The adapter deliberately returns the real Pipecat service.
    sent: list[dict[str, Any]] = []

    async def remember(message: dict[str, Any]) -> None:
        sent.append(message)

    service._ws_send = remember
    await service._send_session_update()

    transcription = sent[0]["session"]["audio"]["input"]["transcription"]
    assert transcription == {
        "model": "gpt-live-transcribe",
        "languages": ["es"],
    }
    assert "language" not in transcription


@pytest.mark.parametrize(
    ("providers", "reason"),
    [
        (
            SpeechProviders(stt="openai_realtime", stt_model="gpt-live-transcribe"),
            "key",
        ),
        (SpeechProviders(stt="openai_realtime", stt_key=A_KEY), "model"),
    ],
)
def test_openai_realtime_refuses_an_incomplete_selection(
    providers: SpeechProviders, reason: str
):
    with pytest.raises(SpeechFault, match=reason):
        _ears(providers)


async def test_realtime_readiness_refuses_if_the_pinned_pipecat_signal_moves(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.services.openai import stt as openai_stt

    class SessionlessRealtimeSTT(FrameProcessor):
        created: SessionlessRealtimeSTT | None = None

        class Settings:
            def __init__(self, *, model: str) -> None:
                self.model = model

        def __init__(self, **_kwargs: object) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            SessionlessRealtimeSTT.created = self

        def event_handler(self, name: str):
            def register(handler):
                self.handlers[name] = handler
                return handler

            return register

        async def announce_connected(self) -> None:
            await self.handlers["on_connected"](self)

    monkeypatch.setattr(openai_stt, "OpenAIRealtimeSTTService", SessionlessRealtimeSTT)
    _leg, connected = _ears(
        SpeechProviders(
            stt="openai_realtime",
            stt_key=A_KEY,
            stt_model="gpt-live-transcribe",
        )
    )
    leg = SessionlessRealtimeSTT.created
    assert leg is not None
    assert connected is not None

    await leg.announce_connected()
    with pytest.raises(SpeechFault, match="no longer says when"):
        await connected()
