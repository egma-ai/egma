"""The speech legs, in process: a whole voice exchange, fast and exact.

The same walk the chat suite drives, with the loopback counterpart on the
other end and the speech legs in between: the persona's words are spoken
into real PCM, carried as audio, and read back by the transcriber. Nothing
here reaches a model, a provider, or a network, and every number asserted
below is measured from the audio that flowed rather than from a clock, so
the suite cannot flake.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import loopback_spec, scripted_spec

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import (
    AGENT_CHANNEL,
    PERSONA_CHANNEL,
    Assembled,
    assemble,
    channels_of,
    dual_channel_wav,
)
from egma_simulator.plugs import PlugError
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import (
    DEFAULT_VOICE_ID,
    decode_speech,
    duration_seconds,
    encode_speech,
    leading_silence_seconds,
    silence,
    spoken_seconds,
    voice_from_traits,
)
from egma_simulator.walk import Conducted, WalkControls, conduct

TRAITS_VOICE = {"provider": "cartesia", "voiceId": "warm-alto-2", "speed": 0.9}


def spec_for(**overrides) -> SimulationSpec:
    return SimulationSpec.from_document(loopback_spec("sim-voice", **overrides))


async def voice_walk(
    tmp_path: Path, **overrides
) -> tuple[Conducted, list[tuple[str, str]], list[tuple[str, float]], Assembled]:
    """One voice simulation, conducted the way the service conducts it."""
    spec = spec_for(**overrides)
    turns: list[tuple[str, str]] = []
    measures: list[tuple[str, float]] = []

    async def on_turn(speaker: str, text: str) -> None:
        turns.append((speaker, text))

    async def on_timing(measure: str, milliseconds: float) -> None:
        measures.append((measure, milliseconds))

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), on_timing=on_timing
    )
    conducted = await conduct(
        persona=Persona(
            traits=spec.persona_traits,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        plug=assembled.plug,
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        on_turn=on_turn,
        on_timing=on_timing,
        controls=WalkControls(),
        name="sim:voice-test",
    )
    return conducted, turns, measures, assembled


# -- The codec ---------------------------------------------------------------


@pytest.mark.parametrize("band", [8000, 16000, 48000])
def test_what_is_spoken_is_what_is_heard(band: int):
    """The legs are a round trip, at every band a connection can carry."""
    said = "Move my Tuesday cleaning to Thursday, please. Margaret Hale."
    assert decode_speech(encode_speech(said, band), band) == said


def test_speech_is_read_out_of_the_samples_wherever_it_starts():
    """A recording holds an utterance after however much quiet; the reader
    finds it anyway, which is what lets a channel be read back."""
    spoken = silence(0.4, 16000) + encode_speech("Hello there.", 16000)
    assert decode_speech(spoken, 16000) == "Hello there."


def test_quiet_and_length_are_measured_from_the_audio():
    spoken = silence(0.25, 16000) + encode_speech("abcd", 16000)
    assert leading_silence_seconds(spoken, 16000) == pytest.approx(0.25)
    # Four bytes at 240 samples each, after a quarter second of quiet.
    assert duration_seconds(spoken, 16000) == pytest.approx(0.25 + 4 * 240 / 16000)
    assert spoken_seconds(spoken, 16000) == pytest.approx(4 * 240 / 16000)


def test_the_persona_voice_comes_from_the_authored_traits():
    voice = voice_from_traits({"personality": "…", "voice": TRAITS_VOICE})
    assert (voice.voice_id, voice.provider, voice.speed) == (
        "warm-alto-2",
        "cartesia",
        0.9,
    )


@pytest.mark.parametrize(
    "traits", [{}, {"voice": "warm-alto-2"}, {"voice": {"speed": 1.1}}]
)
def test_a_persona_authored_with_no_usable_voice_still_speaks(traits: dict):
    assert voice_from_traits(traits).voice_id == DEFAULT_VOICE_ID


# -- The recording -----------------------------------------------------------


def test_a_recording_is_two_channels_in_the_transcripts_own_order():
    persona = encode_speech("the persona", 8000)
    agent = encode_speech("the agent under test", 8000)
    written = dual_channel_wav(persona, agent, 8000)

    channels = channels_of(written)
    assert (PERSONA_CHANNEL, AGENT_CHANNEL) == (0, 1)
    assert decode_speech(channels[PERSONA_CHANNEL], 8000) == "the persona"
    assert decode_speech(channels[AGENT_CHANNEL], 8000) == "the agent under test"
    assert channels[2] == 8000
    # The shorter side is padded, never truncated: both channels run the
    # length of the exchange.
    assert len(channels[0]) == len(channels[1]) == len(agent)


# -- A whole exchange --------------------------------------------------------


async def test_a_voice_walk_conducts_the_same_exchange_a_chat_walk_would(
    tmp_path: Path,
):
    """The persona brain is one component: the transcript is what it would
    have been on chat, and only the machinery underneath changed."""
    conducted, turns, _measures, _assembled = await voice_walk(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    assert turns == [
        ("agent", "Front desk, hello."),
        ("human", "First point."),
        ("agent", "Certainly."),
        ("human", "Second point."),
        ("agent", "Done."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"


async def test_the_recording_holds_each_speaker_on_their_own_channel(
    tmp_path: Path,
):
    """The whole point of two channels: read one and you have one speaker."""
    _conducted, turns, _measures, assembled = await voice_walk(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    audio = assembled.audio
    assert audio is not None

    recording = (tmp_path / audio["recording"]).read_bytes()
    persona_audio, agent_audio, band = channels_of(recording)
    assert band == audio["measured_sample_rate_hz"]

    said = {
        "human": decode_speech(persona_audio, band),
        "agent": decode_speech(agent_audio, band),
    }
    # Every turn that was carried appears on its own speaker's channel and
    # on neither of the other's. The persona's concluding goodbye is not
    # among them: the walk ends on it without handing it to the platform,
    # so it was never spoken and the recording does not pretend it was.
    for speaker, text in turns:
        if text == GOODBYE:
            continue
        other = "agent" if speaker == "human" else "human"
        assert text in said[speaker], (speaker, text)
        assert text not in said[other], (speaker, text)


async def test_every_turn_is_measured_and_the_measures_never_run_backwards(
    tmp_path: Path,
):
    """Time-to-first-word and both durations, per turn, from the audio."""
    _conducted, turns, measures, _assembled = await voice_walk(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.2,
    )
    named = [measure for measure, _ in measures]
    agent_turns = sum(1 for speaker, _ in turns if speaker == "agent")
    persona_turns_spoken = sum(1 for speaker, _ in turns if speaker == "human") - 1

    assert named.count("time_to_first_word") == agent_turns
    assert named.count("agent_speech_duration") == agent_turns
    assert named.count("persona_speech_duration") == persona_turns_spoken

    # Every agent turn was quiet for exactly as long as the counterpart
    # waits before speaking, and then spoke for as long as its words take.
    quiet = [ms for measure, ms in measures if measure == "time_to_first_word"]
    assert quiet == pytest.approx([200.0] * agent_turns)
    speaking = [
        ms for measure, ms in measures if measure == "agent_speech_duration"
    ]
    assert all(ms > 0 for ms in speaking)

    # A measure of a stretch of audio is never negative, and the order the
    # measures were reported in is the order they happened in.
    assert all(ms >= 0 for _, ms in measures)
    assert named[:4] == [
        "time_to_first_word",
        "agent_speech_duration",
        "persona_speech_duration",
        "time_to_first_word",
    ]


async def test_the_measured_band_is_what_flowed_not_what_was_configured(
    tmp_path: Path,
):
    """A connection asks for a band; the platform carries what it can. What
    the record keeps is the second one, or a later edit to a connection
    would silently rewrite what an old result meant."""
    _conducted, _turns, _measures, assembled = await voice_walk(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        sample_rate_hz=24000,
    )
    audio = assembled.audio
    assert audio is not None
    assert audio["measured_sample_rate_hz"] == 16000

    _persona, _agent, recorded_band = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
    )
    assert recorded_band == 16000


async def test_a_narrowband_connection_records_narrowband(tmp_path: Path):
    """Telephony is 8 kHz and WebRTC is 48 kHz, and the difference is the
    reason the band is on the record at all."""
    for asked_for, expected in ((8000, 8000), (48000, 48000)):
        _conducted, _turns, _measures, assembled = await voice_walk(
            tmp_path, scenario="One point.", replies=["Noted."],
            sample_rate_hz=asked_for,
        )
        assert assembled.audio is not None
        assert assembled.audio["measured_sample_rate_hz"] == expected


async def test_an_exchange_the_agent_ends_still_leaves_a_recording(
    tmp_path: Path,
):
    conducted, _turns, _measures, assembled = await voice_walk(
        tmp_path,
        scenario="A long scenario. With several sentences. That keep coming.",
        replies=["All sorted, goodbye now."],
        ends_after_replies=True,
    )
    assert conducted.ending == "agent_ended"
    assert assembled.audio is not None
    assert (tmp_path / assembled.audio["recording"]).exists()


def test_a_chat_spec_assembles_no_speech_legs_and_no_audio(tmp_path: Path):
    """Modality selects the legs and nothing else: a chat simulation is the
    plug on its own, and its report has no audio to carry."""
    spec = SimulationSpec.from_document(scripted_spec("sim-chat"))
    assembled = assemble(spec, blobs=FilesystemBlobStore(tmp_path))
    assert assembled.voice is None
    assert assembled.audio is None
    assert list(tmp_path.iterdir()) == []


def test_assembling_a_spec_with_no_plug_refuses_before_anything_happens(
    tmp_path: Path,
):
    document = loopback_spec("sim-unplugged")
    document["connection"]["type"] = "some-platform-nobody-wrote"
    with pytest.raises(PlugError, match="some-platform-nobody-wrote"):
        assemble(
            SimulationSpec.from_document(document),
            blobs=FilesystemBlobStore(tmp_path),
        )
