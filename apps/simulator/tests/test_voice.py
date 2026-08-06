"""The speech legs, in process: a whole voice exchange, fast and exact.

The same walk the chat suite drives, with the loopback counterpart on the
other end and the speech legs in between: the persona's words are spoken
into real PCM, carried as audio, and read back by the transcriber. Nothing
here reaches a model, a provider, or a network, and every number asserted
below is measured from the audio that flowed rather than from a clock, so
the suite cannot flake.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from conftest import (
    assert_one_speaker_to_a_channel,
    loopback_spec,
    scripted_spec,
)
from pipecat.frames.frames import TextFrame
from pipecat.processors.frame_processor import FrameProcessor

from egma_simulator import pipeline as pipeline_module
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
    DEFAULT_ENGLISH_VOICE_ID,
    DEFAULT_VOICE_ID,
    SAMPLES_PER_BYTE,
    SCRIPTED_PAIR,
    ScriptedSTT,
    ScriptedTTS,
    SpeechFault,
    SpeechLegs,
    SpeechProviders,
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
    four_bytes_spoken = 4 * SAMPLES_PER_BYTE / 16000
    assert leading_silence_seconds(spoken, 16000) == pytest.approx(0.25)
    assert duration_seconds(spoken, 16000) == pytest.approx(0.25 + four_bytes_spoken)
    assert spoken_seconds(spoken, 16000) == pytest.approx(four_bytes_spoken)


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
    assert channels_of(recording)[2] == audio["measured_sample_rate_hz"]

    # Every turn that was carried is on its own speaker's channel and on
    # neither of the other's. The persona's concluding goodbye is not among
    # them: the walk ends on it without handing it to the platform, so it
    # was never spoken and the recording does not pretend it was.
    carried = [(speaker, text) for speaker, text in turns if text != GOODBYE]
    assert len(carried) == len(turns) - 1
    assert_one_speaker_to_a_channel(recording, carried)


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


async def test_the_speech_legs_need_no_corpus_and_no_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The hermetic promise, held where it could quietly break.

    The library under the speaking leg splits sentences with a tokenizer
    corpus it fetches on demand, which in a suite that must need no
    network is a bug waiting for the first machine with a cold cache. The
    simulator never splits sentences, so the corpus is never opened — and
    the way to keep that true is to make any attempt raise here.

    What the assertions below watch is the recording, not an exception.
    A leg that reaches for the corpus and cannot have it does not raise
    out to here — the frame that was being processed is abandoned and the
    error is logged — so the symptom is a persona turn that the transcript
    shows and the audio does not. The turn also carries several sentences
    on purpose: a single sentence never reaches the tokenizer whatever the
    leg is built on, so a one-sentence turn would pass while the promise
    was broken.
    """
    import nltk
    import pipecat.utils.string

    def starved(*_args: object, **_kwargs: object):
        raise LookupError("no tokenizer corpus, and none is meant to be needed")

    monkeypatch.setattr(pipecat.utils.string, "sent_tokenize", starved)
    monkeypatch.setattr(nltk.data, "load", starved)
    monkeypatch.setattr(nltk.data, "find", starved)

    # And the fetch is already gone, so a cold machine reaches no further
    # than a warm one does.
    assert nltk.download("punkt_tab", quiet=True) is False

    spoken = "First sentence. Second sentence. And a third one after that."
    assembled = assemble(
        spec_for(replies=["Noted."]), blobs=FilesystemBlobStore(tmp_path)
    )
    plug = assembled.plug
    await plug.open()
    try:
        answer = await plug.deliver(spoken)
    finally:
        await plug.close()

    assert answer.text == "Noted."
    assert assembled.audio is not None
    assert_one_speaker_to_a_channel(
        (tmp_path / assembled.audio["recording"]).read_bytes(),
        [("human", spoken), ("agent", "Noted.")],
    )


async def test_the_speaking_leg_is_built_with_the_authored_voice(
    tmp_path: Path,
):
    """The pipeline is assembled from this simulation's own spec, and the
    persona's voice is part of that spec — so the leg that just spoke a
    whole exchange is the one holding the authored voice."""
    _conducted, _turns, _measures, assembled = await voice_walk(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        voice={"provider": "elevenlabs", "voiceId": "brisk-tenor-7", "speed": 1.15},
    )
    assert assembled.voice is not None
    spoke_with = assembled.voice.speaking_voice
    assert (spoke_with.voice_id, spoke_with.provider, spoke_with.speed) == (
        "brisk-tenor-7",
        "elevenlabs",
        1.15,
    )

    # A persona authored with no voice still speaks, with the default one.
    _c, _t, _m, plain = await voice_walk(
        tmp_path, scenario="One point.", replies=["Noted."]
    )
    assert plain.voice.speaking_voice.voice_id == DEFAULT_VOICE_ID


async def test_a_counterpart_that_echoes_hands_back_what_it_heard(
    tmp_path: Path,
):
    """The echo test line: the agent side is whatever the persona said.

    Nothing else can prove real speech legs without dialling somebody —
    a scripted script speaks the test codec, which no real transcriber
    can read. Here, with the scripted pair on both ends, the proof is
    exact: every agent turn is the persona turn before it.
    """
    _conducted, turns, _measures, assembled = await voice_walk(
        tmp_path,
        scenario="First point. Second point.",
        echoes_what_it_hears=True,
    )
    said = [(speaker, text) for speaker, text in turns]
    assert said[:4] == [
        ("human", "First point."),
        ("agent", "First point."),
        ("human", "Second point."),
        ("agent", "Second point."),
    ]

    # Both channels carry both spoken turns — which is what an echo is,
    # and the one exchange where a speaker's words are meant to be on the
    # other channel too.
    assert assembled.audio is not None
    persona_audio, agent_audio, band = channels_of(
        (tmp_path / assembled.audio["recording"]).read_bytes()
    )
    for channel in (persona_audio, agent_audio):
        heard = decode_speech(channel, band)
        assert "First point." in heard
        assert "Second point." in heard


def test_a_counterpart_cannot_both_echo_and_read_a_script(tmp_path: Path):
    with pytest.raises(PlugError, match="echoes_what_it_hears"):
        assemble(
            spec_for(echoes_what_it_hears=True, replies=["Certainly."]),
            blobs=FilesystemBlobStore(tmp_path),
        )


# -- Which legs, and whose voice ---------------------------------------------


REAL_PAIR = SpeechProviders(
    stt="deepgram",
    tts="elevenlabs",
    deepgram_api_key="deepgram-key-for-assembly-only",
    elevenlabs_api_key="elevenlabs-key-for-assembly-only",
)
"""Both providers named. Building legs is not connecting to them, so an
assembled pipeline can be inspected here without a network or an account."""


def voice_on_the_leg(legs: SpeechLegs) -> str:
    """The voice the speaking leg will really ask its provider for.

    Read off the leg itself rather than off the bookkeeping beside it: a
    leg built with one voice while the record says another is exactly the
    regression worth catching, and only the leg can be asked. A scripted
    leg keeps it as the persona's voice; a provider's service keeps it in
    the settings it was constructed with.
    """
    if isinstance(legs.tts, ScriptedTTS):
        return legs.tts.voice.voice_id
    return str(legs.tts._settings.voice)


@asynccontextmanager
async def assembled_with(providers: SpeechProviders, tmp_path: Path, **overrides):
    """One assembled voice pipeline, given back after it has been read.

    Nothing is opened: a leg is built here and reaches its provider only
    when an exchange starts, which is what lets the whole of this section
    run with no network and no account.
    """
    assembled = assemble(
        spec_for(**overrides), blobs=FilesystemBlobStore(tmp_path), speech=providers
    )
    try:
        yield assembled
    finally:
        await assembled.plug.close()


async def test_a_deployment_that_configures_nothing_gets_the_scripted_pair(
    tmp_path: Path,
):
    """The default everywhere: CI, the free local demo, and any deployment
    that sets no provider variable."""
    async with assembled_with(
        SCRIPTED_PAIR, tmp_path, voice={"voiceId": "warm-alto-2"}
    ) as assembled:
        legs = assembled.voice.legs
        assert isinstance(legs.tts, ScriptedTTS)
        assert isinstance(legs.stt, ScriptedSTT)
        assert voice_on_the_leg(legs) == "warm-alto-2"


async def test_naming_the_providers_puts_their_stock_services_in_the_slots(
    tmp_path: Path,
):
    """Configuration alone selects them — the spec is the same one the
    scripted pair conducts, and no code above assembly changed."""
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

    async with assembled_with(REAL_PAIR, tmp_path) as assembled:
        legs = assembled.voice.legs
        assert isinstance(legs.tts, ElevenLabsHttpTTSService)
        assert isinstance(legs.stt, DeepgramSTTService)


async def test_each_leg_is_chosen_on_its_own(tmp_path: Path):
    """A real mouth with scripted ears is a configuration somebody will
    want, and it costs one key rather than two."""
    from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

    providers = SpeechProviders(
        tts="elevenlabs", elevenlabs_api_key="elevenlabs-key-for-assembly-only"
    )
    async with assembled_with(providers, tmp_path) as assembled:
        legs = assembled.voice.legs
        assert isinstance(legs.tts, ElevenLabsHttpTTSService)
        assert isinstance(legs.stt, ScriptedSTT)


async def test_a_real_voice_named_in_the_traits_is_the_one_that_speaks(
    tmp_path: Path,
):
    async with assembled_with(
        REAL_PAIR,
        tmp_path,
        voice={"provider": "elevenlabs", "voiceId": "brisk-tenor-7", "speed": 1.15},
    ) as assembled:
        assert voice_on_the_leg(assembled.voice.legs) == "brisk-tenor-7"
        spoke_with = assembled.voice.speaking_voice
        assert (spoke_with.voice_id, spoke_with.speed) == ("brisk-tenor-7", 1.15)


async def test_a_voice_authored_for_nobody_in_particular_is_still_honored(
    tmp_path: Path,
):
    """Traits naming a voice and no provider are authoring for whichever
    deployment runs them, so the id is used as written."""
    async with assembled_with(
        REAL_PAIR, tmp_path, voice={"voiceId": "brisk-tenor-7"}
    ) as assembled:
        assert voice_on_the_leg(assembled.voice.legs) == "brisk-tenor-7"
        assert assembled.voice.speaking_voice.voice_id == "brisk-tenor-7"


@pytest.mark.parametrize(
    ("traits_voice", "why"),
    [
        (None, "a persona authored with no voice at all"),
        ({"speed": 1.1}, "a voice block naming no voice"),
        (TRAITS_VOICE, "a voice belonging to a provider this is not"),
    ],
)
async def test_a_persona_with_no_voice_of_this_providers_gets_the_default_english(
    tmp_path: Path, traits_voice: dict | None, why: str
):
    """Speaking with a sensible default beats failing on a timbre."""
    overrides = {} if traits_voice is None else {"voice": traits_voice}
    async with assembled_with(REAL_PAIR, tmp_path, **overrides) as assembled:
        assert voice_on_the_leg(assembled.voice.legs) == DEFAULT_ENGLISH_VOICE_ID, why
        assert assembled.voice.speaking_voice.voice_id == DEFAULT_ENGLISH_VOICE_ID


async def test_only_a_streaming_transcriber_asks_for_a_pause_after_a_turn(
    tmp_path: Path,
):
    """The pause a real transcriber needs is a real transcriber's cost.

    It is added to what the listening leg hears, so it also lands on the
    recording; a scripted exchange asks for none and its audio is what it
    always was, sample for sample.
    """
    async with assembled_with(SCRIPTED_PAIR, tmp_path) as scripted:
        assert scripted.voice.legs.trailing_quiet_seconds == 0.0
    async with assembled_with(REAL_PAIR, tmp_path) as real:
        assert real.voice.legs.trailing_quiet_seconds > 0.0


async def test_a_leg_that_refuses_a_turn_fails_the_simulation_in_its_own_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A provider saying no is a diagnosis, and it has to reach the record.

    This is what a wrong key, an unpaid plan or a voice an account may not
    use actually looks like: the library logs a line, pushes an error back
    up the pipeline — away from the end everything else is read from — and
    carries on. The turn then carries no audio and nothing is waiting for
    it, so without this the simulation stalls until its duration limit and
    the record says "limit reached" about a provider that refused.
    """
    refusal = (
        'ElevenLabs API error: {"detail":{"status":"payment_required",'
        '"message":"Free users cannot use library voices via the API."}}'
    )

    class RefusingMouth(FrameProcessor):
        async def process_frame(self, frame, direction) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, TextFrame):
                await self.push_error(refusal)
                return
            await self.push_frame(frame, direction)

    def refusing_legs(providers, *, voice, sample_rate_hz):
        return SpeechLegs(
            stt=ScriptedSTT(sample_rate_hz=sample_rate_hz),
            tts=RefusingMouth(),
            voice=voice,
        )

    monkeypatch.setattr(pipeline_module, "build_legs", refusing_legs)

    with pytest.raises(SpeechFault, match="payment_required"):
        await voice_walk(tmp_path, scenario="One point.", replies=["Noted."])


async def test_an_unconfigured_voice_exchange_connects_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Half the hermeticity guard: with nothing configured, no socket is
    ever connected — the whole exchange is conducted with connecting
    starved. The other half, that no provider library is so much as
    imported, is in the quarantine suite, where a fresh process can say
    it."""
    import socket

    def starved(*_args: object, **_kwargs: object):
        raise AssertionError("the scripted pair reached for the network")

    monkeypatch.setattr(socket.socket, "connect", starved)
    monkeypatch.setattr(socket.socket, "connect_ex", starved)

    conducted, turns, _measures, assembled = await voice_walk(
        tmp_path, scenario="One point.", replies=["Noted."]
    )

    assert conducted.status == "completed"
    assert ("agent", "Noted.") in turns
    assert assembled.audio is not None


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
