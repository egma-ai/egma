"""The simulator dispatches catalog selections by their claimed adapters."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from egma_simulator.config import STT_PROVIDERS, TTS_PROVIDERS
from egma_simulator.model import ModelFailure, OpenAICompatibleModel, build_model_client
from egma_simulator.spec import (
    ModelSelection,
    SelectedModels,
    SimulationSpec,
    SpeechSelection,
)
from egma_simulator.speech import SpeechProviders, _ears, _mouth, voice_from_models

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
