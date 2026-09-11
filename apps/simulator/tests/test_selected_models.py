"""The simulator dispatches catalog selections by their claimed adapters."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import cast

import pytest
from pipecat.frames.frames import TTSAudioRawFrame
from websockets.protocol import State

from egma_simulator.config import STT_PROVIDERS, TTS_PROVIDERS
from egma_simulator.model import ModelFailure, OpenAICompatibleModel, build_model_client
from egma_simulator.spec import (
    ModelSelection,
    PersonaParameters,
    SelectedModels,
    SimulationSpec,
    SpeechSelection,
)
from egma_simulator.speech import (
    CARTESIA_API_VERSION,
    PersonaVoice,
    SpeechFault,
    SpeechProviders,
    _ears,
    _mouth,
    apply_pcm_gain,
    gained_speech_frame,
    tts_delivery_instructions,
    voice_from_models,
)

STT_ADAPTERS = (
    ("cartesia", "cartesia_manual", "ink-2", "CartesiaSTTService"),
    ("deepgram", "deepgram", "nova-3-general", "DeepgramSTTService"),
    (
        "openai",
        "openai_realtime",
        "gpt-live-transcribe",
        "OpenAIRealtimeSTTService",
    ),
)
TTS_ADAPTERS = (
    ("cartesia", "cartesia", "sonic-3.5", "CartesiaTTSService"),
    ("openai", "openai", "gpt-4o-mini-tts", "OpenAITTSService"),
)


def direct_key(provider: str) -> str:
    return f"{provider}-account-key"


def test_daytona_provider_secret_reference_resolves_only_its_provider_env(monkeypatch):
    monkeypatch.setenv("EGMA_OPENAI_API_KEY", "daytona-openai-placeholder")
    models = SelectedModels.from_document(
        {
            "llm": {
                "provider": "openai",
                "model": "gpt",
                "adapter": "openai_chat_completions",
                "key": "env:EGMA_OPENAI_API_KEY",
            },
            "stt": {"provider": "scripted", "model": "scripted", "adapter": "scripted"},
            "tts": {
                "provider": "scripted",
                "model": "scripted",
                "adapter": "scripted",
                "voice_id": "plain",
                "speed": 1,
            },
        }
    )

    assert models.llm.key == "daytona-openai-placeholder"


def selected(
    *,
    llm_provider: str = "openai",
    llm_model: str = "gpt-5.6-terra",
    llm_adapter: str = "openai_chat_completions",
    stt_provider: str = "deepgram",
    stt_model: str = "nova-3-general",
    stt_adapter: str = "deepgram",
    tts_provider: str = "cartesia",
    tts_model: str = "sonic-3.5",
    tts_adapter: str = "cartesia",
) -> SelectedModels:
    return SelectedModels(
        llm=ModelSelection(
            provider=llm_provider,
            model=llm_model,
            adapter=llm_adapter,
            reasoning_effort="none",
            key=direct_key(llm_provider),
        ),
        stt=ModelSelection(
            provider=stt_provider,
            model=stt_model,
            adapter=stt_adapter,
            key=direct_key(stt_provider),
        ),
        tts=SpeechSelection(
            provider=tts_provider,
            model=tts_model,
            adapter=tts_adapter,
            key=direct_key(tts_provider),
            voice_id=f"{tts_provider}-voice",
            speed=1.0,
        ),
    )


def test_speech_adapter_names_match_the_runtime_builders():
    assert {adapter for _provider, adapter, _model, _service in STT_ADAPTERS} == (
        set(STT_PROVIDERS) - {"scripted"}
    )
    assert {adapter for _provider, adapter, _model, _service in TTS_ADAPTERS} == (
        set(TTS_PROVIDERS) - {"scripted"}
    )


async def test_llm_dispatch_uses_adapter_and_accepts_any_catalog_model_name():
    models = selected(
        llm_provider="catalog-provider-label",
        llm_model="future-catalog-model",
        llm_adapter="openai_chat_completions",
    )
    spec = cast(SimulationSpec, SimpleNamespace(models=models))

    client = build_model_client(spec)
    try:
        assert type(client) is OpenAICompatibleModel
        assert client.model_name == "future-catalog-model"
        assert models.llm.key == direct_key("catalog-provider-label")
    finally:
        await client.close()


def test_llm_dispatch_does_not_fall_back_from_provider_name():
    models = selected(llm_provider="openai", llm_adapter="not-shipped")
    spec = cast(SimulationSpec, SimpleNamespace(models=models))

    with pytest.raises(ModelFailure, match="not-shipped"):
        build_model_client(spec)


@pytest.mark.parametrize(
    ("provider", "adapter", "model", "expected_service"), STT_ADAPTERS
)
def test_each_stt_adapter_builds_its_listening_leg(
    provider: str, adapter: str, model: str, expected_service: str
):
    models = selected(
        stt_provider=provider,
        stt_model=model,
        stt_adapter=adapter,
    )

    providers = SpeechProviders.from_models(models, vad="silero").checked()
    leg, _connected = _ears(providers)

    assert providers.stt == adapter
    assert providers.stt_model == model
    assert providers.stt_key == direct_key(provider)
    assert type(leg).__name__ == expected_service
    assert direct_key(provider) in models.secrets


def test_stt_dispatch_uses_adapter_not_provider():
    models = selected(stt_provider="openai", stt_adapter="deepgram")

    providers = SpeechProviders.from_models(models, vad="silero").checked()
    leg, _connected = _ears(providers)

    assert providers.stt == "deepgram"
    assert type(leg).__name__ == "DeepgramSTTService"


@pytest.mark.parametrize(
    ("provider", "adapter", "model", "expected_service"), TTS_ADAPTERS
)
def test_each_tts_adapter_builds_its_speaking_leg(
    provider: str, adapter: str, model: str, expected_service: str
):
    models = selected(
        tts_provider=provider,
        tts_model=model,
        tts_adapter=adapter,
    )
    voice = voice_from_models(models)

    providers = SpeechProviders.from_models(models, vad="silero").checked()
    leg, spoken_with, _closers = _mouth(providers, voice)

    assert providers.tts == adapter
    assert providers.tts_model == model
    assert providers.tts_key == direct_key(provider)
    assert type(leg).__name__ == expected_service
    assert spoken_with == voice
    assert direct_key(provider) in models.secrets


def test_tts_dispatch_uses_adapter_not_provider():
    models = selected(tts_provider="cartesia", tts_adapter="openai")

    providers = SpeechProviders.from_models(models, vad="silero").checked()

    assert providers.tts == "openai"


def test_runtime_controls_reach_the_selected_voice_and_delivery():
    voice = voice_from_models(
        selected(),
        PersonaParameters(
            language="es-MX",
            emotion="angry",
            accent="spanish",
            speech_volume=1.25,
        ),
    )

    assert voice.language == "es-MX"
    assert voice.speech_volume == 1.25
    assert tts_delivery_instructions(voice) == (
        "Speak in es-MX. Use a consistently angry emotional delivery. "
        "Use a Spanish accent."
    )


async def test_cartesia_36_sends_locale_and_named_accent_on_the_pinned_wire():
    models = selected(tts_model="sonic-3.6")
    voice = PersonaVoice(
        voice_id=models.tts.voice_id,
        provider="cartesia",
        speed=1.1,
        language="en-US",
        emotion="anxious",
        accent="standard-hindi",
    )
    providers = SpeechProviders.from_models(models, vad="silero").checked()

    leg, _spoken_with, _closers = _mouth(providers, voice)
    sent: list[str] = []

    class Socket:
        state = State.OPEN

        async def send(self, message: str) -> None:
            sent.append(message)

    leg._websocket = Socket()  # type: ignore[attr-defined]
    frames = [
        frame
        async for frame in leg.run_tts(  # type: ignore[attr-defined]
            "Please wait.", "context-1"
        )
    ]
    message = json.loads(sent[0])

    assert leg._cartesia_version == CARTESIA_API_VERSION  # type: ignore[attr-defined]
    assert frames == [None]
    assert message["locale"] == "en-US"
    assert message["accent"] == "standard-hindi"
    assert "language" not in message
    assert message["generation_config"] == {
        "speed": 1.1,
        "emotion": "anxious",
    }


def test_cartesia_refuses_a_named_accent_that_its_older_wire_cannot_send():
    models = selected(tts_model="sonic-3.5")
    providers = SpeechProviders.from_models(models, vad="silero").checked()
    voice = PersonaVoice(
        voice_id=models.tts.voice_id,
        provider="cartesia",
        speed=1.0,
        language="en-US",
        accent="standard-hindi",
    )

    with pytest.raises(SpeechFault, match="named Cartesia accents require sonic-3.6"):
        _mouth(providers, voice)


def test_openai_private_voice_requires_customer_funded_credentials():
    with pytest.raises(SpeechFault, match="customer-funded credentials"):
        _mouth(
            SpeechProviders(
                tts="openai",
                tts_key="deployment-key",
                tts_model="gpt-4o-mini-tts",
                tts_provider="openai",
                tts_customer_funded=False,
            ),
            PersonaVoice(
                voice_id="voice_private_123",
                provider="openai",
                speed=1.0,
            ),
        )


def test_speech_gain_is_independent_and_clips_pcm_samples():
    pcm = (10_000).to_bytes(2, "little", signed=True) + (30_000).to_bytes(
        2, "little", signed=True
    )

    gained = apply_pcm_gain(pcm, 1.5)

    assert int.from_bytes(gained[:2], "little", signed=True) == 15_000
    assert int.from_bytes(gained[2:], "little", signed=True) == 32_767


async def test_speech_gain_preserves_frame_identity_and_timing_metadata():
    source = TTSAudioRawFrame(
        audio=(10_000).to_bytes(2, "little", signed=True),
        sample_rate=24_000,
        num_channels=1,
        context_id="context-1",
    )
    source.pts = 123
    source.metadata["trace"] = "kept"
    gained = gained_speech_frame(source, 0.5)

    assert gained.context_id == "context-1"
    assert gained.pts == 123
    assert gained.metadata == {"trace": "kept"}
