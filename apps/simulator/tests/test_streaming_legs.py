"""The shipped streaming adapters use the pinned selection exactly."""

from __future__ import annotations

from typing import Any

import pytest

from egma_simulator.speech import (
    PersonaVoice,
    SpeechFault,
    SpeechProviders,
    _ears,
    _mouth,
)

A_KEY = "sk-only-this-test-holds-this-one"


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


@pytest.mark.parametrize("speed", [0.6, 1.5])
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


@pytest.mark.parametrize("speed", [0.5999, 1.5001])
def test_cartesia_refuses_a_speed_it_cannot_honor(speed: float):
    with pytest.raises(SpeechFault, match="supported range"):
        _mouth(
            SpeechProviders(tts="cartesia", tts_key=A_KEY, tts_model="sonic-3.5"),
            cartesia_voice(speed),
        )


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
