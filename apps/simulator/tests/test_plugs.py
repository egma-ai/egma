"""The platform-plug seam, and the two counterparts that prove it.

A plug is the one component that knows how to reach and talk to a
platform; everything else is plug-blind. The scripted counterpart and the
loopback counterpart are CI's two fake platforms — one chatting, one
speaking — so their behavior is pinned here: the greeting, the scripted
replies in order, the deliberate ending, the fallback when the script runs
dry, and the refusal of config they do not understand. The pair are
deliberately alike in what they script, and deliberately unalike in shape:
chat is asked for a turn, and a voice line is driven one slice of audio at
a time because both directions of it are open at once.
"""

from __future__ import annotations

import pytest

from egma_simulator.plugs import (
    AgentReply,
    DuplexLine,
    PlugError,
    plug_for,
)
from egma_simulator.plugs.loopback import (
    CALLER_FINISHED_SECONDS,
    SUPPORTED_BANDS_HZ,
    LoopbackCounterpart,
    negotiated_band,
)
from egma_simulator.plugs.loopback import FALLBACK_REPLY as SPOKEN_FALLBACK
from egma_simulator.plugs.scripted import FALLBACK_REPLY, ScriptedCounterpart
from egma_simulator.speech import (
    SAMPLES_PER_BYTE,
    decode_speech,
    encode_speech,
    leading_silence_seconds,
    silence,
)

SLICE_SAMPLES = SAMPLES_PER_BYTE
"""One slice of the line, the same one the conductor drives it with."""


def scripted(config: dict, *, modality: str = "chat") -> ScriptedCounterpart:
    return ScriptedCounterpart(modality=modality, config=config, credentials=None)


def loopback(config: dict, *, modality: str = "voice") -> LoopbackCounterpart:
    return LoopbackCounterpart(modality=modality, config=config, credentials=None)


async def carry(
    line: LoopbackCounterpart, outgoing: bytes = b"", *, slices: int = 1
) -> bytes:
    """Drive the line the way the conductor drives it, and keep what came
    back: the same number of samples each way, every slice, quiet
    included."""
    width = SLICE_SAMPLES * 2
    said = bytearray(outgoing)
    said += bytes(max(0, slices * width - len(said)))
    heard = bytearray()
    for offset in range(0, len(said), width):
        heard += await line.exchange(bytes(said[offset : offset + width]))
    return bytes(heard)


async def hear(line: LoopbackCounterpart, said: str = "", *, seconds: float = 3.0):
    """What the far end says back over one caller turn and the quiet after
    it — read as words, which is all any test here cares about."""
    band = line.sample_rate_hz
    spoken = encode_speech(said, band) if said else b""
    quiet = round(seconds * band / SLICE_SAMPLES)
    heard = await carry(line, spoken)
    heard += await carry(line, slices=quiet)
    return decode_speech(heard, band)


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


def test_the_loopback_counterpart_is_a_full_duplex_line():
    """The seam it wears is what decides which conductor it gets, so the
    four verbs are the thing to pin."""
    assert isinstance(loopback({}), DuplexLine)


async def test_the_loopback_counterpart_answers_in_audio():
    line = loopback(
        {
            "greeting": "Front desk, good morning.",
            "replies": ["Certainly.", "One moment."],
        }
    )
    await line.open()
    assert await hear(line) == "Front desk, good morning."
    assert await hear(line, "I need help.") == "Certainly."
    assert await hear(line, "And another thing.") == "One moment."
    # The script is dry and the counterpart was not told to end: it holds
    # the exchange open with a fixed line, deterministically.
    assert await hear(line, "Anything else?") == SPOKEN_FALLBACK
    await line.close()


async def test_the_loopback_counterpart_can_end_the_exchange():
    line = loopback({"replies": ["All sorted."], "ends_after_replies": True})
    await line.open()
    assert not line.far_end_left
    assert await hear(line, "Is that everything?") == "All sorted."
    assert line.far_end_left

    silent = loopback({"replies": [], "ends_after_replies": True})
    await silent.open()
    assert await hear(silent, "Hello?") == ""
    assert silent.far_end_left


async def test_the_counterpart_hears_the_caller_stop_by_listening():
    """Nothing tells it where a turn ended, because nothing tells a real
    platform either: it answers once the line has been quiet long enough
    for the caller to have finished."""
    line = loopback({"replies": ["Yes."]})
    await line.open()
    await carry(line, encode_speech("A question.", 16000))

    nearly = round(CALLER_FINISHED_SECONDS * 16000 / SLICE_SAMPLES) - 1
    assert decode_speech(await carry(line, slices=nearly), 16000) == ""
    assert decode_speech(await carry(line, slices=200), 16000) == "Yes."


async def test_the_quiet_before_an_answer_is_spent_on_the_line():
    """A real call carries the agent's thinking as silence, and that is
    where time-to-first-word is measured from — so the counterpart spends
    the delay it was given as quiet on the line before its first word,
    counted in samples and landing on the next slice of it."""
    line = loopback({"replies": ["Yes."], "answer_delay_seconds": 0.5})
    await line.open()
    await carry(line, encode_speech("A question.", 16000))
    heard = await carry(line, slices=round(3.0 * 16000 / SLICE_SAMPLES))

    asked_for = round(0.5 * 16000)
    quiet = round(leading_silence_seconds(heard, 16000) * 16000)
    assert asked_for <= quiet < asked_for + SLICE_SAMPLES
    assert decode_speech(heard, 16000) == "Yes."


async def test_a_greeting_is_the_first_thing_on_the_line():
    """Nobody has said anything yet, so the counterpart opens the
    conversation the moment the line does."""
    line = loopback({"greeting": "Front desk."})
    await line.open()
    heard = await carry(line, slices=round(3.0 * 16000 / SLICE_SAMPLES))
    assert heard.startswith(encode_speech("Front desk.", 16000))


async def test_a_counterpart_that_echoes_hands_back_the_caller_own_words():
    line = loopback({"echoes_what_it_hears": True})
    await line.open()
    assert await hear(line, "Say that again.") == "Say that again."


async def test_the_line_is_quiet_when_nobody_is_speaking():
    """Quiet is audio: a slice of it crosses the line like any other, or
    the two speakers would be on two different clocks."""
    line = loopback({"replies": ["Noted."]})
    await line.open()
    assert await carry(line, slices=4) == silence(
        4 * SLICE_SAMPLES / 16000, 16000
    )


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
    assert carried in SUPPORTED_BANDS_HZ


async def test_the_loopback_counterpart_speaks_at_the_band_it_carries():
    line = loopback({"replies": ["Noted."], "sample_rate_hz": 8000})
    await line.open()
    assert await hear(line, "A question.") == "Noted."


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
