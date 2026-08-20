"""The simulator resolves every model and technical voice from one block."""

from egma_simulator.spec import ModelSelection, SelectedModels, SpeechSelection
from egma_simulator.speech import SpeechProviders, voice_from_models


def selected(*, stt_provider: str, stt_model: str) -> SelectedModels:
    return SelectedModels(
        llm=ModelSelection(provider="openai", model="gpt-4o-mini", key="llm-key"),
        stt=ModelSelection(provider=stt_provider, model=stt_model, key="stt-key"),
        tts=SpeechSelection(
            provider="cartesia",
            model="sonic-3.5",
            key="tts-key",
            voice_id="cartesia-voice",
            speed=1.1,
        ),
    )


def test_openai_stt_selection_has_only_the_realtime_runtime_meaning():
    models = selected(stt_provider="openai", stt_model="gpt-live-transcribe")

    providers = SpeechProviders.from_models(models, vad="silero")

    assert providers.stt == "openai_realtime"
    assert providers.stt_model == "gpt-live-transcribe"
    assert providers.stt_key == "stt-key"


def test_deepgram_stt_selection_keeps_its_provider_model_pair():
    models = selected(stt_provider="deepgram", stt_model="nova-3-general")

    providers = SpeechProviders.from_models(models, vad="silero")

    assert providers.stt == "deepgram"
    assert providers.stt_model == "nova-3-general"


def test_tts_selection_is_the_only_technical_voice_source():
    models = selected(stt_provider="deepgram", stt_model="nova-3-general")

    voice = voice_from_models(models)
    providers = SpeechProviders.from_models(models, vad="silero")

    assert voice.provider == "cartesia"
    assert voice.voice_id == "cartesia-voice"
    assert voice.speed == 1.1
    assert providers.tts == "cartesia"
    assert providers.tts_model == "sonic-3.5"
    assert providers.tts_key == "tts-key"
