"""The two streaming legs, and what each of them is built with.

The pair a real deployment speaks and hears with over a phone line:
Cartesia's mouth and OpenAI's realtime ears. Both hold a socket open and
work while the far end is still talking, which is the whole reason they
exist beside the segmented legs already here.

Nothing in this file reaches a provider. What is checked is what a leg is
built with — the model, the voice, and where the turn boundary is decided.
The live suites beside this one
prove the audio really flows; this one proves the wiring.
"""

from __future__ import annotations

from typing import Any

import pytest

from egma_simulator.config import (
    DEFAULT_CARTESIA_TTS_MODEL,
    DEFAULT_REALTIME_STT_MODEL,
    DEFAULT_STT_MODEL,
)
from egma_simulator.speech import (
    DEFAULT_CARTESIA_VOICE_ID,
    SpeechFault,
    SpeechProviders,
    _ears,
    _mouth,
    voice_from_traits,
)

A_KEY = "sk-only-this-test-holds-this-one"


def capture_construction(
    monkeypatch: pytest.MonkeyPatch, service: type
) -> list[dict[str, Any]]:
    """Remember the public arguments Egma hands a provider service."""
    calls: list[dict[str, Any]] = []
    original = service.__init__

    def remember(instance: object, *args: object, **kwargs: Any) -> None:
        calls.append(kwargs)
        original(instance, *args, **kwargs)

    monkeypatch.setattr(service, "__init__", remember)
    return calls


# -- The cartesia mouth -------------------------------------------------------


def test_the_cartesia_mouth_uses_the_default_voice():
    _leg, spoken_with, closers = _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert spoken_with.voice_id == DEFAULT_CARTESIA_VOICE_ID
    assert spoken_with.provider == "cartesia"
    assert closers == ()


def test_the_cartesia_mouth_asks_for_this_providers_model_when_nobody_named_one(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({}),
    )

    assert calls[0]["settings"].model == DEFAULT_CARTESIA_TTS_MODEL


def test_a_named_model_and_voice_reach_the_cartesia_mouth(
    monkeypatch: pytest.MonkeyPatch,
):
    """What the platform said wins over the provider's own default."""
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _leg, spoken_with, _ = _mouth(
        SpeechProviders(
            tts="cartesia",
            tts_key=A_KEY,
            tts_model="sonic-something-newer",
            tts_voice="a-voice-the-platform-chose",
        ),
        voice_from_traits({}),
    )

    assert calls[0]["settings"].model == "sonic-something-newer"
    assert spoken_with.voice_id == "a-voice-the-platform-chose"


def test_a_persona_authored_for_another_provider_speaks_with_the_default_voice():
    """A voice id belongs to whoever minted it. Handing Cartesia an
    ElevenLabs identifier is a refusal at the first word, and a simulation
    must not fail on a timbre."""
    _, spoken_with, _ = _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits(
            {"voice": {"voiceId": "EXAVITQu4vr4xnSDxMaL", "provider": "elevenlabs"}}
        ),
    )

    assert spoken_with.voice_id == DEFAULT_CARTESIA_VOICE_ID


@pytest.mark.parametrize(
    ("authored", "spoken"),
    [(1.2, 1.2), (3.0, 1.5), (0.1, 0.6)],
)
def test_a_speed_outside_what_cartesia_accepts_is_clamped_rather_than_refused(
    authored: float, spoken: float, monkeypatch: pytest.MonkeyPatch
):
    """Speed rides this provider's own generation block, and a persona's
    speed was authored against whichever provider it was written for. Out
    of range is clamped, because a refused request would fail a whole
    simulation over a timbre."""
    from pipecat.services.cartesia.tts import CartesiaTTSService

    calls = capture_construction(monkeypatch, CartesiaTTSService)
    _mouth(
        SpeechProviders(tts="cartesia", tts_key=A_KEY),
        voice_from_traits({"voice": {"speed": authored}}),
    )

    generation = calls[0]["settings"].generation_config
    assert generation.speed == pytest.approx(spoken)


def test_the_cartesia_mouth_refuses_without_a_key_rather_than_at_the_first_turn():
    with pytest.raises(SpeechFault, match="without a key"):
        _mouth(
            SpeechProviders(tts="cartesia"),
            voice_from_traits({}),
        )


# -- The openai realtime ears -------------------------------------------------


def test_the_realtime_ears_ask_for_the_streaming_model_by_default(
    monkeypatch: pytest.MonkeyPatch,
):
    """The two openai transports are two provider names, and each has its
    own default model. The segmented leg's default reaching the streaming
    one would be a name asked of the wrong endpoint."""
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _leg, connected = _ears(
        SpeechProviders(stt="openai_realtime", stt_key=A_KEY)
    )

    model = calls[0]["settings"].model
    assert model == DEFAULT_REALTIME_STT_MODEL
    assert model != DEFAULT_STT_MODEL
    # A streaming leg drops audio handed to it before it can hear, so it
    # must offer something to wait on. The segmented leg has nothing to
    # wait for and offers none.
    assert connected is not None


def test_the_segmented_ears_keep_their_own_default(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.openai.stt import OpenAISTTService

    calls = capture_construction(monkeypatch, OpenAISTTService)
    _leg, connected = _ears(SpeechProviders(stt="openai", stt_key=A_KEY))

    assert calls[0]["settings"].model == DEFAULT_STT_MODEL
    assert connected is None


def test_a_named_model_reaches_the_realtime_ears(
    monkeypatch: pytest.MonkeyPatch,
):
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _ears(
        SpeechProviders(
            stt="openai_realtime", stt_key=A_KEY, stt_model="gpt-live-something-newer"
        ),
    )

    assert calls[0]["settings"].model == "gpt-live-something-newer"


def test_the_realtime_ears_leave_the_turn_boundary_to_the_detector_in_the_pipeline(
    monkeypatch: pytest.MonkeyPatch,
):
    """The one setting on this leg that is not a name.

    Server-side detection would be a second opinion about where a turn
    ended, arriving on a different clock from the ear that stamps the
    record's sample positions — and the transcript and the timings would
    then disagree. False is this service's word for "the detector is in
    the pipeline", which is where egma's is.
    """
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

    calls = capture_construction(monkeypatch, OpenAIRealtimeSTTService)
    _ears(SpeechProviders(stt="openai_realtime", stt_key=A_KEY))

    assert calls[0]["turn_detection"] is False


def test_the_realtime_ears_refuse_without_a_key_rather_than_at_the_first_turn():
    with pytest.raises(SpeechFault, match="without a key"):
        _ears(SpeechProviders(stt="openai_realtime"))
