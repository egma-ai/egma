"""The platform-plug seam, and the two counterparts that prove it.

A plug is the one component that knows how to reach and talk to a
platform; everything else is plug-blind. The scripted counterpart and the
loopback counterpart are CI's two fake platforms — one chatting, one
speaking — so their behavior is pinned here: the greeting, the scripted
replies in order, the deliberate ending, the fallback when the script runs
dry, and the refusal of config they do not understand. The pair are
deliberately alike, because the difference between chat and voice is meant
to be the modality and nothing else.
"""

from __future__ import annotations

import pytest

from egma_simulator.plugs import AgentReply, PlugError, Utterance, plug_for
from egma_simulator.plugs.loopback import FALLBACK_REPLY as SPOKEN_FALLBACK
from egma_simulator.plugs.loopback import (
    SUPPORTED_BANDS,
    LoopbackCounterpart,
    negotiated_band,
)
from egma_simulator.plugs.scripted import FALLBACK_REPLY, ScriptedCounterpart
from egma_simulator.speech import decode_speech, encode_speech


def scripted(config: dict, *, modality: str = "chat") -> ScriptedCounterpart:
    return ScriptedCounterpart(modality=modality, config=config, credentials=None)


def loopback(config: dict, *, modality: str = "voice") -> LoopbackCounterpart:
    return LoopbackCounterpart(modality=modality, config=config, credentials=None)


def said(speech) -> str | None:
    """What one spoken answer carried, read from its samples."""
    if speech is None or speech.audio is None:
        return None
    return decode_speech(speech.audio.pcm, speech.audio.sample_rate_hz)


def test_the_registry_knows_the_two_plugs_and_nothing_imaginary():
    assert plug_for("scripted") is ScriptedCounterpart
    assert plug_for("loopback") is LoopbackCounterpart
    assert plug_for("no-such-platform") is None


async def test_the_counterpart_greets_replies_in_order_then_falls_back():
    plug = scripted(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly.", "One moment."],
        }
    )
    assert await plug.open() == "Front desk, good morning."
    assert await plug.deliver("I need help.") == AgentReply(
        text="Certainly.", ended=False
    )
    assert await plug.deliver("With a booking.") == AgentReply(
        text="One moment.", ended=False
    )
    # The script is dry and the counterpart was not told to end: it holds
    # the exchange open with a fixed line, deterministically.
    assert await plug.deliver("Hello?") == AgentReply(
        text=FALLBACK_REPLY, ended=False
    )
    await plug.close()


async def test_the_counterpart_can_end_the_exchange_with_its_last_reply():
    plug = scripted(
        {
            "replies": ["All sorted. Goodbye now."],
            "ends_after_replies": True,
        }
    )
    assert await plug.open() is None
    assert await plug.deliver("Please cancel it.") == AgentReply(
        text="All sorted. Goodbye now.", ended=True
    )
    await plug.close()


async def test_a_counterpart_with_nothing_to_say_ends_silently():
    plug = scripted({"replies": [], "ends_after_replies": True})
    assert await plug.open() is None
    assert await plug.deliver("Anyone there?") == AgentReply(text=None, ended=True)
    await plug.close()


async def test_the_counterpart_offers_its_provider_reference():
    plug = scripted({"provider_reference": "scripted-0001"})
    assert plug.provider_reference == "scripted-0001"
    assert scripted({}).provider_reference is None


def test_config_the_counterpart_does_not_know_is_refused():
    with pytest.raises(PlugError) as refusal:
        scripted({"repliez": ["typo"]})
    assert "repliez" in str(refusal.value)


@pytest.mark.parametrize(
    "config",
    [
        {"greeting": 7},
        {"replies": "not a list"},
        {"replies": [1, 2]},
        {"ends_after_replies": "yes"},
        {"turn_seconds": "fast"},
        {"turn_seconds": -1},
        {"provider_reference": 12},
    ],
)
def test_config_of_the_wrong_shape_is_refused(config: dict):
    with pytest.raises(PlugError):
        scripted(config)


def test_the_counterpart_speaks_chat_only_for_now():
    with pytest.raises(PlugError) as refusal:
        scripted({}, modality="voice")
    assert "voice" in str(refusal.value)


# -- The loopback counterpart ------------------------------------------------


async def test_the_loopback_counterpart_answers_in_audio():
    plug = loopback(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly.", "One moment."],
        }
    )
    assert said(await plug.open()) == "Front desk, good morning."

    persona = Utterance(pcm=encode_speech("I need help.", 16000), sample_rate_hz=16000)
    assert said(await plug.deliver(persona)) == "Certainly."
    assert said(await plug.deliver(persona)) == "One moment."
    # The script is dry and the counterpart was not told to end: it holds
    # the exchange open with a fixed line, deterministically.
    assert said(await plug.deliver(persona)) == SPOKEN_FALLBACK
    await plug.close()


async def test_the_loopback_counterpart_can_end_the_exchange():
    plug = loopback({"replies": ["All sorted."], "ends_after_replies": True})
    assert await plug.open() is None
    answer = await plug.deliver(
        Utterance(pcm=b"", sample_rate_hz=plug.sample_rate_hz)
    )
    assert (said(answer), answer.ended) == ("All sorted.", True)

    silent = loopback({"replies": [], "ends_after_replies": True})
    ending = await silent.deliver(Utterance(pcm=b"", sample_rate_hz=16000))
    assert (ending.audio, ending.ended) == (None, True)


async def test_the_quiet_before_an_answer_is_in_the_answers_own_audio():
    """A real call carries the agent's thinking as silence, and that is
    where time-to-first-word is measured from."""
    plug = loopback({"replies": ["Yes."], "answer_delay_seconds": 0.5})
    answer = await plug.deliver(Utterance(pcm=b"", sample_rate_hz=16000))
    quiet_samples = int(0.5 * plug.sample_rate_hz)
    assert answer.audio.pcm[: quiet_samples * 2] == bytes(quiet_samples * 2)
    assert said(answer) == "Yes."


@pytest.mark.parametrize(
    ("asked_for", "carried"),
    [(8000, 8000), (16000, 16000), (24000, 16000), (48000, 48000), (4000, 8000)],
)
def test_the_counterpart_carries_the_band_it_can_not_the_one_asked_for(
    asked_for: int, carried: int
):
    """Platforms negotiate down to what they actually do, and what a
    simulation stamps is the second number."""
    assert negotiated_band(asked_for) == carried
    assert loopback({"sample_rate_hz": asked_for}).sample_rate_hz == carried
    assert carried in SUPPORTED_BANDS


async def test_the_loopback_counterpart_speaks_at_the_band_it_carries():
    plug = loopback({"replies": ["Noted."], "sample_rate_hz": 8000})
    answer = await plug.deliver(Utterance(pcm=b"", sample_rate_hz=8000))
    assert answer.audio.sample_rate_hz == 8000
    assert decode_speech(answer.audio.pcm, 8000) == "Noted."


def test_the_loopback_counterpart_offers_its_provider_reference():
    assert loopback({"provider_reference": "loopback-0001"}).provider_reference == (
        "loopback-0001"
    )
    assert loopback({}).provider_reference is None


def test_loopback_config_it_does_not_know_is_refused():
    with pytest.raises(PlugError) as refusal:
        loopback({"turn_seconds": 1})
    assert "turn_seconds" in str(refusal.value)


@pytest.mark.parametrize(
    "config",
    [
        {"greeting": 7},
        {"replies": "not a list"},
        {"replies": [1, 2]},
        {"ends_after_replies": "yes"},
        {"answer_delay_seconds": "slowly"},
        {"answer_delay_seconds": -1},
        {"sample_rate_hz": "wideband"},
        {"sample_rate_hz": 0},
        {"provider_reference": 12},
    ],
)
def test_loopback_config_of_the_wrong_shape_is_refused(config: dict):
    with pytest.raises(PlugError):
        loopback(config)


def test_the_loopback_counterpart_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        loopback({}, modality="chat")
    assert "chat" in str(refusal.value)
