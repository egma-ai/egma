"""The voice conductor, in process: a whole simulation, fast and exact.

One real Pipecat pipeline against the loopback counterpart: the persona
brain writes the words, the speaking leg turns them into PCM, the line
carries them a slice at a time, the voice activity detector hears the far
end start and stop, the turn model says when it has finished, and the
transcriber reads it back. Nothing here reaches a model, a provider, or a
network.

Every number asserted below is measured from the audio that flowed —
positions on the conversation's own sample timeline — rather than from a
clock, so the suite cannot flake and the assertions can be exact rather
than approximate.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import (
    assert_one_speaker_to_a_channel,
    loopback_spec,
    scripted_spec,
    speech_in_the_recording,
)
from pipecat.frames.frames import InputAudioRawFrame, TextFrame
from pipecat.processors.frame_processor import FrameProcessor

from egma_simulator import conductor as conductor_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import (
    LINE_SLICE_SAMPLES,
    AudioClock,
    ConductParameters,
    VoiceConductor,
)
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import Assembled, assemble
from egma_simulator.plugs import PlugError
from egma_simulator.plugs.loopback import LoopbackCounterpart
from egma_simulator.recording import (
    AGENT_CHANNEL,
    PERSONA_CHANNEL,
    channels_of,
    dual_channel_wav,
)
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import (
    DEFAULT_ENGLISH_VOICE_ID,
    DEFAULT_VOICE_ID,
    SAMPLES_PER_BYTE,
    SCRIPTED_PAIR,
    ScriptedSTT,
    ScriptedTTS,
    ScriptedVAD,
    SpeechFault,
    SpeechLegs,
    SpeechProviders,
    build_vad,
    carries_speech,
    decode_speech,
    duration_seconds,
    encode_speech,
    leading_silence_seconds,
    silence,
    spoken_seconds,
    voice_from_traits,
)
from egma_simulator.walk import Conducted, WalkControls

TRAITS_VOICE = {"provider": "cartesia", "voiceId": "warm-alto-2", "speed": 0.9}

NANOSECONDS_PER_MILLISECOND = 1_000_000


def spec_for(**overrides) -> SimulationSpec:
    return SimulationSpec.from_document(loopback_spec("sim-voice", **overrides))


@dataclass
class Observed:
    """Everything one conducted simulation told the outside world."""

    conducted: Conducted
    assembled: Assembled
    spans: list[tuple[str, str, int, int]] = field(default_factory=list)
    """Each turn with the two instants its audio ran between."""

    measures: list[tuple[str, float]] = field(default_factory=list)
    """Each measurement, as the name and the milliseconds its span holds."""

    @property
    def turns(self) -> list[tuple[str, str]]:
        return [(speaker, text) for speaker, text, _began, _ended in self.spans]

    @property
    def named(self) -> list[str]:
        return [measure for measure, _milliseconds in self.measures]

    def milliseconds_of(self, measure: str) -> list[float]:
        return [
            milliseconds
            for name, milliseconds in self.measures
            if name == measure
        ]


async def voice_simulation(
    tmp_path: Path,
    *,
    speech: SpeechProviders = SCRIPTED_PAIR,
    parameters: ConductParameters | None = None,
    controls: WalkControls | None = None,
    **overrides,
) -> Observed:
    """One voice simulation, conducted the way the service conducts it."""
    spec = spec_for(**overrides)
    assembled = assemble(
        spec,
        blobs=FilesystemBlobStore(tmp_path),
        speech=speech,
        parameters=parameters,
    )
    conductor = assembled.conductor
    assert conductor is not None
    return await observe(
        conductor,
        assembled,
        spec,
        controls=controls or WalkControls(),
    )


async def observe(
    conductor: VoiceConductor,
    assembled: Assembled,
    spec: SimulationSpec,
    *,
    controls: WalkControls,
) -> Observed:
    """Conduct, and keep everything the conductor said about it."""
    spans: list[tuple[str, str, int, int]] = []
    measures: list[tuple[str, float]] = []

    async def on_utterance(
        speaker: str, text: str, began: int, ended: int
    ) -> None:
        spans.append((speaker, text, began, ended))

    async def on_measured(measure: str, began: int, ended: int) -> None:
        measures.append(
            (measure, (ended - began) / NANOSECONDS_PER_MILLISECOND)
        )

    conducted = await conductor.conduct(
        persona=Persona(
            traits=spec.persona_traits,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=controls,
        name="sim:voice-test",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )
    return Observed(
        conducted=conducted, assembled=assembled, spans=spans, measures=measures
    )


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


# -- The voice activity detector ---------------------------------------------


@pytest.mark.parametrize("band", [8000, 16000, 48000])
def test_the_ci_detector_reads_the_codec_exactly(band: int):
    """Speech is a tone and quiet is exactly no samples, so the detector
    answers from the samples and never from a probability."""
    assert carries_speech(encode_speech("a", band))
    assert not carries_speech(silence(0.05, band))


def test_the_ci_detector_confirms_speech_one_window_in_and_quiet_four_out():
    """Both corrections the conductor applies are the detector's own
    declared parameters, so a boundary it reports can be put back exactly
    where the speech was."""
    detector = ScriptedVAD(sample_rate_hz=16000, window_samples=240)
    detector.set_sample_rate(16000)
    assert detector.num_frames_required() == 240
    assert detector.params.start_secs == pytest.approx(240 / 16000)
    assert detector.params.stop_secs == pytest.approx(4 * 240 / 16000)


def test_the_detector_is_chosen_at_assembly_like_every_other_leg(
    monkeypatch: pytest.MonkeyPatch,
):
    """Silero is the production detector and it ships inside the pinned
    wheel, so choosing it downloads nothing and connects to nothing — and
    a deployment that chose nothing never loads it at all."""
    import socket

    def starved(*_args: object, **_kwargs: object):
        raise AssertionError("choosing a detector reached for the network")

    monkeypatch.setattr(socket.socket, "connect", starved)
    monkeypatch.setattr(socket.socket, "connect_ex", starved)

    scripted = build_vad(SCRIPTED_PAIR, sample_rate_hz=16000, window_samples=240)
    assert isinstance(scripted, ScriptedVAD)

    from pipecat.audio.vad.silero import SileroVADAnalyzer

    chosen = build_vad(
        SpeechProviders(vad="silero"), sample_rate_hz=16000, window_samples=240
    )
    assert isinstance(chosen, SileroVADAnalyzer)


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


async def test_a_voice_simulation_conducts_the_same_exchange_a_chat_walk_would(
    tmp_path: Path,
):
    """The persona brain is one component: the transcript is what it would
    have been on chat, and only the machinery underneath changed."""
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    assert observed.turns == [
        ("agent", "Front desk, hello."),
        ("human", "First point."),
        ("agent", "Certainly."),
        ("human", "Second point."),
        ("agent", "Done."),
        ("human", GOODBYE),
    ]
    assert observed.conducted.status == "completed"
    assert observed.conducted.ending == "persona_concluded"


async def test_both_ends_of_every_turn_are_read_off_the_audio(tmp_path: Path):
    """The change this conductor exists for.

    A turn's span is not the moment somebody noticed the turn, minus a
    length: it is the two sample positions the audio really ran between.
    So a spoken turn's length is exactly what its words take to say, to
    the sample, at every band — and the turns are in the order they were
    spoken with no two of them crossing on a script where nobody
    interrupts.
    """
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    band = 16000
    for speaker, text, began, ended in observed.spans:
        if text == GOODBYE:
            # Concluded rather than spoken: the scenario ends the moment
            # the persona decides it, and nothing went on the line.
            assert began == ended
            continue
        spoken = duration_seconds(encode_speech(text, band), band)
        milliseconds = (ended - began) / NANOSECONDS_PER_MILLISECOND
        assert milliseconds == pytest.approx(spoken * 1000, abs=0.001), (
            speaker,
            text,
        )

    opened = [began for _speaker, _text, began, _ended in observed.spans]
    closed = [ended for _speaker, _text, _began, ended in observed.spans]
    assert opened == sorted(opened)
    assert closed == sorted(closed)
    # Nobody interrupted anybody, so no two turns cross.
    assert all(
        closed[position] <= opened[position + 1]
        for position in range(len(opened) - 1)
    )


async def test_the_recording_holds_each_speaker_on_their_own_channel(
    tmp_path: Path,
):
    """The whole point of two channels: read one and you have one speaker."""
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    audio = observed.assembled.audio
    assert audio is not None

    recording = (tmp_path / audio["recording"]).read_bytes()
    assert channels_of(recording)[2] == audio["measured_sample_rate_hz"]

    # Every turn that was carried is on its own speaker's channel and on
    # neither of the other's. The persona's concluding goodbye is not among
    # them: the conductor ends on it without putting it on the line, so it
    # was never spoken and the recording does not pretend it was.
    carried = [
        (speaker, text) for speaker, text in observed.turns if text != GOODBYE
    ]
    assert len(carried) == len(observed.turns) - 1
    assert_one_speaker_to_a_channel(recording, carried)


async def test_every_span_points_at_the_audio_it_names(tmp_path: Path):
    """The two channels are one clock, and the spans are on it.

    Both directions carry the same number of samples, quiet included, so
    the recording is the conversation's own timeline. Every stretch of
    speech a listener can find on it — either channel — is one turn's
    span, at the same distance from every other, to the sample. That is
    what "anchored to the audio timeline" means, checked against the
    audio rather than against the conductor's own bookkeeping.
    """
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    audio = observed.assembled.audio
    assert audio is not None
    persona_audio, agent_audio, band = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
    )
    assert len(persona_audio) == len(agent_audio)

    heard = speech_in_the_recording(
        (tmp_path / audio["recording"]).read_bytes()
    )
    spoken = [span for span in observed.spans if span[1] != GOODBYE]
    assert [speaker for speaker, _began, _ended in heard] == [
        speaker for speaker, _text, _began, _ended in spoken
    ]

    def since_the_first(positions: list[int]) -> list[int]:
        return [position - positions[0] for position in positions]

    def in_samples(instants: list[int]) -> list[int]:
        return [
            round((instant - instants[0]) * band / 1_000_000_000)
            for instant in instants
        ]

    assert since_the_first([began for _speaker, began, _ended in heard]) == (
        in_samples([began for _speaker, _text, began, _ended in spoken])
    )
    assert since_the_first([ended for _speaker, _began, ended in heard]) == (
        in_samples([ended for _speaker, _text, _began, ended in spoken])
    )


async def test_every_turn_is_measured_and_the_measures_never_run_backwards(
    tmp_path: Path,
):
    """Time-to-first-word and both durations, per turn, from the audio."""
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    named = observed.named
    agent_turns = sum(1 for speaker, _ in observed.turns if speaker == "agent")
    persona_turns_spoken = (
        sum(1 for speaker, _ in observed.turns if speaker == "human") - 1
    )

    assert named.count("time_to_first_word") == agent_turns
    assert named.count("agent_speech_duration") == agent_turns
    assert named.count("persona_speech_duration") == persona_turns_spoken
    # The measures every simulation reports are still there: voice adds
    # measurements, it does not replace them.
    assert named.count("first_response_latency") == 1
    assert named.count("turn_response_latency") == persona_turns_spoken

    # Every agent turn was quiet for exactly as long as the counterpart
    # waits before speaking — exactly, because the wait is rendered into
    # the audio and read back off it.
    assert observed.milliseconds_of("time_to_first_word") == [300.0] * agent_turns
    assert all(
        milliseconds > 0
        for milliseconds in observed.milliseconds_of("agent_speech_duration")
    )

    # A measure of a stretch of audio is never negative, and the order the
    # measures were reported in is the order they happened in.
    assert all(milliseconds >= 0 for _, milliseconds in observed.measures)
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
    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        sample_rate_hz=24000,
    )
    audio = observed.assembled.audio
    assert audio is not None
    assert audio["measured_sample_rate_hz"] == 16000

    _persona, _agent, recorded_band = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
    )
    assert recorded_band == 16000


@pytest.mark.parametrize("band", [8000, 48000])
async def test_a_narrowband_connection_records_narrowband(
    tmp_path: Path, band: int
):
    """Telephony is 8 kHz and WebRTC is 48 kHz, and the difference is the
    reason the band is on the record at all."""
    observed = await voice_simulation(
        tmp_path, scenario="One point.", replies=["Noted."], sample_rate_hz=band
    )
    audio = observed.assembled.audio
    assert audio is not None
    assert audio["measured_sample_rate_hz"] == band
    assert observed.turns[:2] == [("human", "One point."), ("agent", "Noted.")]


async def test_an_exchange_the_agent_ends_still_leaves_a_recording(
    tmp_path: Path,
):
    observed = await voice_simulation(
        tmp_path,
        scenario="A long scenario. With several sentences. That keep coming.",
        replies=["All sorted, goodbye now."],
        ends_after_replies=True,
    )
    assert observed.conducted.ending == "agent_ended"
    assert observed.conducted.reason == "the agent ended the exchange"
    assert ("agent", "All sorted, goodbye now.") in observed.turns
    audio = observed.assembled.audio
    assert audio is not None
    assert (tmp_path / audio["recording"]).exists()


async def test_the_persona_opens_when_the_far_end_does_not(tmp_path: Path):
    """No greeting is not a broken call: a persona who hears nothing speaks
    first, after listening for as long as the parameters say.

    How long it listened is spent on the line rather than slept through,
    so a patient persona's recording is longer than a brisk one's by
    exactly the difference between their two windows.
    """
    lengths = {}
    for listening in (1.0, 2.0):
        observed = await voice_simulation(
            tmp_path / f"opening-{listening}",
            scenario="One point.",
            replies=["Noted."],
            parameters=ConductParameters(agent_opening_seconds=listening),
        )
        assert observed.turns[0] == ("human", "One point.")
        audio = observed.assembled.audio
        assert audio is not None
        persona_audio, _agent, band = channels_of(
            (tmp_path / f"opening-{listening}" / audio["recording"]).read_bytes()
        )
        lengths[listening] = len(persona_audio) // 2

    listened_longer = lengths[2.0] - lengths[1.0]
    assert abs(listened_longer - band) < LINE_SLICE_SAMPLES


# -- Limits, cancellation, and the endings -----------------------------------


async def test_the_turn_limit_ends_the_simulation_where_it_says(tmp_path: Path):
    """Counting finished utterances of either speaker — the smallest
    honest rule for a conversation with no turn loop in it."""
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point. Third point.",
        greeting="Front desk, hello.",
        max_turns=3,
    )
    assert observed.conducted.ending == "limit_reached"
    assert observed.conducted.reason == "the turn limit (3 turns) tripped"
    assert len(observed.turns) == 3


class _StopsMidUtterance:
    """A line that puts a hand on the controls while the persona is talking.

    Written against the duplex seam rather than around it, so what it
    stops is a real utterance really in flight: the counterpart behind it
    is the ordinary one, and the only thing added is one call at a slice
    this test picked. Both hands that may stop a simulation are the
    walk's own, so this is the same stop a heartbeat or the duration
    watchdog lands — only at a moment a test can name.
    """

    def __init__(self, line, stop, *, after_slices: int) -> None:
        self._line = line
        self._stop = stop
        self._after = after_slices
        self.heard_speaking = 0

    @property
    def provider_reference(self) -> str | None:
        return self._line.provider_reference

    @property
    def sample_rate_hz(self) -> int:
        return self._line.sample_rate_hz

    @property
    def measured_band_hz(self) -> int | None:
        return self._line.measured_band_hz

    @property
    def far_end_left(self) -> bool:
        return self._line.far_end_left

    async def open(self) -> None:
        await self._line.open()

    async def exchange(self, outgoing: bytes) -> bytes:
        if carries_speech(outgoing):
            self.heard_speaking += 1
            if self.heard_speaking == self._after:
                self._stop()
        return await self._line.exchange(outgoing)

    async def close(self) -> None:
        await self._line.close()


LONG_FIRST_POINT = "A long first point that takes a while to say."
"""Long enough that the line is still carrying it several slices in."""


async def stopped_mid_utterance(
    tmp_path: Path, stop_with: str, **overrides
) -> Observed:
    """One simulation stopped while the persona was still speaking."""
    spec = spec_for(scenario=LONG_FIRST_POINT, **overrides)
    controls = WalkControls()
    stop = getattr(controls, stop_with)
    conductor = VoiceConductor(
        line=_StopsMidUtterance(
            LoopbackCounterpart(
                modality="voice", config=spec.connection_config, credentials=None
            ),
            stop,
            after_slices=5,
        ),
        voice=voice_from_traits(spec.persona_traits),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
    )
    return await observe(
        conductor,
        Assembled(conductor=conductor),
        spec,
        controls=controls,
    )


async def test_a_cancel_lands_mid_utterance_and_keeps_what_was_voiced(
    tmp_path: Path,
):
    """A cancel directive stops the line at the next slice, wherever the
    conversation had got to — and the turn it stopped in the middle of is
    on the record for exactly the stretch of line it occupied."""
    observed = await stopped_mid_utterance(tmp_path, "request_cancel")

    assert observed.conducted.status == "canceled"
    assert observed.conducted.ending == "canceled"
    assert observed.conducted.reason is None

    assert len(observed.turns) == 1
    speaker, text, began, ended = observed.spans[0]
    assert (speaker, text) == ("human", LONG_FIRST_POINT)
    whole = len(encode_speech(text, 16000)) // 2
    voiced = round((ended - began) * 16000 / 1_000_000_000)
    # Stopped where the line stopped: part of the utterance, and a whole
    # number of slices of it.
    assert 0 < voiced < whole
    assert voiced % LINE_SLICE_SAMPLES == 0


async def test_the_duration_limit_ends_the_simulation_honestly(tmp_path: Path):
    """The watchdog is outside the pipeline and on the wall clock,
    deliberately: a call's budget is a budget of somebody's afternoon, and
    Pipecat has no maximum call duration of its own to lean on. What it
    lands is the same stop a cancel lands, reported as the other ending."""
    observed = await stopped_mid_utterance(
        tmp_path, "trip_duration_limit", max_duration_seconds=90
    )
    assert observed.conducted.status == "completed"
    assert observed.conducted.ending == "limit_reached"
    assert observed.conducted.reason == "the duration limit (90s) tripped"


# -- Stopping a simulation that has not opened yet ----------------------------

STOP_LANDS_WITHIN_SECONDS = 10.0
"""How long the tests below give a stop to land before they give up.

A bound on *failing*, not a timing assertion: a stop raced properly lands
on the next turn of the event loop and none of this is ever waited for.
It is here so that a conductor which stopped racing hangs a test for ten
seconds rather than for the suite's whole two-minute timeout, with the
name of the thing that broke on it.
"""


class _NeverAnswers:
    """A line that is still ringing when the stop lands.

    Written against the duplex seam the way :class:`_StopsMidUtterance` is,
    and for the same reason: the stop has to arrive while a real call is
    really in flight. Both fakes the suite ships answer in no wall-clock
    time at all — deliberately, so that CI pays nothing for the quiet a
    live line spends — so neither of them can hold an opening exchange
    open long enough to aim a directive at it.

    A real one holds it for a long time. A phone rings for
    ``RINGING_SECONDS`` before nobody answering is the answer, and a room
    waits ``AGENT_JOIN_SECONDS`` for a worker; this stands in for the
    whole of that with a wait nothing ever ends.
    """

    def __init__(self, stop: Callable[[], None] | None = None) -> None:
        self._stop = stop
        self.closed = False

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def sample_rate_hz(self) -> int:
        return 16000

    @property
    def measured_band_hz(self) -> int | None:
        return 16000

    @property
    def far_end_left(self) -> bool:
        return False

    async def open(self) -> None:
        if self._stop is not None:
            # A directive really arrives on a heartbeat's answer, which is
            # a task of its own landing mid-dial. This is that moment,
            # named by the test instead of raced for.
            self._stop()
        await asyncio.Event().wait()

    async def exchange(self, outgoing: bytes) -> bytes:
        raise AssertionError("the line was driven, and it never answered")

    async def close(self) -> None:
        self.closed = True


async def stopped_while_opening(
    tmp_path: Path,
    stop_with: str,
    *,
    legs=None,
    max_duration_seconds: int = 600,
    monkeypatch: pytest.MonkeyPatch | None = None,
) -> tuple[Conducted, _NeverAnswers]:
    """One simulation stopped before its exchange ever opened."""
    spec = spec_for(max_duration_seconds=max_duration_seconds)
    controls = WalkControls()
    stop = getattr(controls, stop_with)
    # A leg that never connects is the other long wait in opening; where a
    # test names one, the line answers the stop instead.
    line = _NeverAnswers(None if legs is not None else stop)
    if legs is not None:
        assert monkeypatch is not None
        monkeypatch.setattr(conductor_module, "build_legs", legs(stop))
    conductor = VoiceConductor(
        line=line,
        voice=voice_from_traits(spec.persona_traits),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
    )
    observed = await asyncio.wait_for(
        observe(conductor, Assembled(conductor=conductor), spec, controls=controls),
        timeout=STOP_LANDS_WITHIN_SECONDS,
    )
    return observed.conducted, line


async def test_a_cancel_lands_while_the_line_is_still_ringing(tmp_path: Path):
    """The promise the platform makes out loud, held where it was broken.

    A cancel directive is honored within one heartbeat so that nothing
    goes on conversing with a customer's production agent for a simulation
    the record has already closed. Ringing a real phone number for a
    minute after the cancel is exactly the scenario that rule exists to
    prevent, and opening the line used to sit through the whole of it.
    """
    conducted, line = await stopped_while_opening(tmp_path, "request_cancel")

    assert conducted.status == "canceled"
    assert conducted.ending == "canceled"
    assert conducted.reason is None
    # And the line was hung up on the way out, from a state it never
    # finished opening — which is what `close` promises of every state.
    assert line.closed is True


async def test_the_duration_limit_lands_while_the_line_is_still_ringing(
    tmp_path: Path,
):
    """The other hand that stops a simulation, landing in the same place
    and reported as the other ending — the endings vocabulary unchanged."""
    conducted, line = await stopped_while_opening(
        tmp_path, "trip_duration_limit", max_duration_seconds=90
    )

    assert conducted.status == "completed"
    assert conducted.ending == "limit_reached"
    assert conducted.reason == "the duration limit (90s) tripped"
    assert line.closed is True


async def test_a_cancel_lands_while_the_listening_leg_is_still_connecting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The other real wait in opening, and it has its own budget too.

    A streaming transcriber opens its websocket in the background and is
    given fifteen seconds to manage it. A cancel that landed before any of
    that must not wait it out either.
    """

    def never_connecting(stop):
        def legs(providers, *, voice, sample_rate_hz):
            async def connecting() -> None:
                stop()
                await asyncio.Event().wait()

            return SpeechLegs(
                stt=ScriptedSTT(sample_rate_hz=sample_rate_hz),
                tts=ScriptedTTS(voice=voice, sample_rate_hz=sample_rate_hz),
                voice=voice,
                listening=connecting,
            )

        return legs

    conducted, line = await stopped_while_opening(
        tmp_path, "request_cancel", legs=never_connecting, monkeypatch=monkeypatch
    )

    assert conducted.status == "canceled"
    assert conducted.ending == "canceled"
    # The line was never even reached, and closing it is still safe.
    assert line.closed is True


async def test_a_concluding_turn_that_fills_the_budget_still_concludes(
    tmp_path: Path,
):
    """Chat and voice end the same scenario the same way at the same limit.

    The walk checks its budget *before* letting the persona move, so a
    concluding turn it allowed can never also be the turn that trips the
    limit. Reading the count afterwards on voice would report
    ``limit_reached`` for the very turn that concluded the scenario — the
    same run, two endings, depending only on the modality.
    """
    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        greeting="Front desk, hello.",
        replies=["Noted."],
        max_turns=4,
    )
    assert [text for _speaker, text in observed.turns][-1] == GOODBYE
    assert len(observed.turns) == 4
    assert observed.conducted.ending == "persona_concluded"
    assert observed.conducted.reason == "the persona concluded the scenario"


# -- Overlap: what the record refuses to invent -------------------------------


class _TalksOverThePersona:
    """A line whose far end starts speaking while the persona still is.

    Written against the duplex seam rather than around it, the way
    :class:`_StopsMidUtterance` is: nothing is scripted into a counterpart
    or a media backend, because overlap *behaviour* belongs to a later
    effort. What is under test here is only what the record does when the
    two speakers' audio crosses — which the shipped counterparts can never
    show, since both of them wait for the persona to stop before speaking.

    It says one thing, beginning on the slice named by ``after_slices`` of
    persona speech, and then optionally goes — which is how a test can
    reach the far end finishing its turn while the persona is still
    talking without the exchange running on afterwards.
    """

    def __init__(
        self,
        *,
        band_hz: int,
        after_slices: int,
        saying: str,
        leaves_when_done: bool = False,
    ) -> None:
        self._band_hz = band_hz
        self._after = after_slices
        self._saying = saying
        self._leaves = leaves_when_done
        self._heard_speaking = 0
        self._to_say = bytearray()
        self._said_it_all = False
        self._left = False

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def measured_band_hz(self) -> int | None:
        return self._band_hz

    @property
    def far_end_left(self) -> bool:
        return self._left

    async def open(self) -> None:
        return None

    async def exchange(self, outgoing: bytes) -> bytes:
        if carries_speech(outgoing):
            self._heard_speaking += 1
            if self._heard_speaking == self._after:
                self._to_say = bytearray(
                    encode_speech(self._saying, self._band_hz)
                )
        elif self._said_it_all and self._leaves:
            # Said its piece and heard the persona stop: on a phone that is
            # the hang-up, and here it is the same thing.
            self._left = True
        if not self._to_say:
            return bytes(len(outgoing))
        spoken = bytes(self._to_say[: len(outgoing)])
        del self._to_say[: len(outgoing)]
        self._said_it_all = not self._to_say
        return spoken.ljust(len(outgoing), b"\x00")

    async def close(self) -> None:
        return None


async def talked_over(
    tmp_path: Path, *, parameters: ConductParameters, **line: object
) -> Observed:
    """One simulation whose two speakers' audio really crosses."""
    spec = spec_for(scenario="First point.")
    conductor = VoiceConductor(
        line=_TalksOverThePersona(band_hz=16000, **line),
        voice=voice_from_traits(spec.persona_traits),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
        parameters=parameters,
    )
    return await observe(
        conductor, Assembled(conductor=conductor), spec, controls=WalkControls()
    )


def crossing(observed: Observed) -> tuple[tuple, tuple]:
    """The persona's spoken turn and the agent's, which have to cross."""
    persona = next(
        span for span in observed.spans if span[0] == "human" and span[1] != GOODBYE
    )
    agent = next(span for span in observed.spans if span[0] == "agent")
    return persona, agent


VOIDED = ("time_to_first_word", "first_response_latency", "turn_response_latency")
"""The three measures an overlap leaves nothing to measure.

Each is a stretch of quiet before the agent's first word, and there was no
quiet: somebody was speaking through all of it. A span whose duration *is*
the number cannot say "not measured here" — so it is not emitted, which is
the grading precedent for a sample the conversation voided.
"""


async def test_an_agent_that_talks_over_the_persona_voids_the_latencies(
    tmp_path: Path,
):
    """The persona finishes; the agent had already begun over the top of it.

    The agent's first word lands *before* the persona's last, so the quiet
    between them is negative. Clamping that to zero would put a perfect
    latency on the record for an answer nobody waited for, and a p90
    threshold would be improved by every barge-in it saw.
    """
    observed = await talked_over(
        tmp_path,
        parameters=ConductParameters(agent_opening_seconds=0.2),
        after_slices=3,
        saying="Right, go on.",
    )

    persona, agent = crossing(observed)
    assert agent[2] < persona[3], "the two speakers did not actually overlap"

    for measure in VOIDED:
        assert observed.named.count(measure) == 0, measure
    # What was measured is still measured: both durations, and both turns
    # with the two ends the audio really ran between.
    assert observed.named.count("agent_speech_duration") == 1
    assert observed.named.count("persona_speech_duration") == 1
    assert observed.turns == [
        ("human", "First point."),
        ("agent", "Right, go on."),
        ("human", GOODBYE),
    ]
    assert observed.conducted.ending == "persona_concluded"


async def test_an_agent_turn_that_closes_mid_utterance_voids_the_latencies(
    tmp_path: Path,
):
    """The other way round: the agent's turn is over and the persona is
    still speaking, so the persona has never yet stopped for anything to
    be measured from.

    Anchoring to "the persona has said nothing" used to fall back to the
    moment the line opened, which invents a quiet out of the whole opening
    of the simulation. There is no quiet to name here at all.
    """
    observed = await talked_over(
        tmp_path,
        parameters=ConductParameters(
            agent_opening_seconds=0.2,
            # The persona is patient, so the turn it is handed while still
            # speaking is never begun before the far end goes. Only the
            # waiting changes; what is given up on is unchanged.
            persona_pause_seconds=4.0,
        ),
        after_slices=3,
        saying="Yes.",
        leaves_when_done=True,
    )

    persona, agent = crossing(observed)
    assert agent[2] < persona[3], "the two speakers did not actually overlap"
    # The agent's turn closed first, which is what makes this the other case.
    assert observed.turns[0] == ("agent", "Yes.")

    for measure in VOIDED:
        assert observed.named.count(measure) == 0, measure
    assert observed.named.count("agent_speech_duration") == 1
    assert observed.named.count("persona_speech_duration") == 1
    assert observed.conducted.ending == "agent_ended"


async def test_a_turn_made_of_several_stretches_is_anchored_across_all_of_them(
    tmp_path: Path,
):
    """A speaker who pauses mid-thought is still taking one turn.

    The turn model keeps a turn open across a pause it judges incomplete —
    which is the whole reason a turn model exists rather than a silence
    timer — so one turn can hold several stretches of speech. Anchored to
    the first stretch alone, the span would carry the whole turn's words
    and end somewhere in the middle of them, and the speech duration would
    measure only the opening clause.

    Driven through the conductor's own bookkeeping because the scripted
    codec cannot produce it: every scripted stretch is read as a complete
    turn, so only a real voice on a live leg reaches this.
    """
    conductor = VoiceConductor(
        line=LoopbackCounterpart(modality="voice", config={}, credentials=None),
        voice=voice_from_traits({}),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="sim-stretches/dual-channel.wav",
    )
    conductor._clock = AudioClock(sample_rate_hz=16000, opened_unix_nano=0)
    conductor._ear = SimpleNamespace(utterances=[(2400, 4800), (7200, 12000)])

    spans: list[tuple[str, str, int, int]] = []
    measures: list[tuple[str, int, int]] = []

    async def on_utterance(speaker, text, began, ended):
        spans.append((speaker, text, began, ended))

    async def on_measured(measure, began, ended):
        measures.append((measure, began, ended))

    conductor._on_utterance = on_utterance
    conductor._on_measured = on_measured
    conductor._max_turns = 60

    await conductor.the_agent_finished("Thursday — sorry, Friday.", True)
    await conductor.close()

    def samples(instant: int) -> int:
        return round(instant * 16000 / 1_000_000_000)

    # One turn, from its first word to its last, whatever it did between.
    assert len(spans) == 1
    _speaker, _text, began, ended = spans[0]
    assert (samples(began), samples(ended)) == (2400, 12000)

    spoken = next(
        (b, e) for measure, b, e in measures if measure == "agent_speech_duration"
    )
    assert (samples(spoken[0]), samples(spoken[1])) == (2400, 12000)
    # And the quiet before its first word is measured to that first word.
    quiet = next(
        (b, e) for measure, b, e in measures if measure == "time_to_first_word"
    )
    assert (samples(quiet[0]), samples(quiet[1])) == (0, 2400)


async def test_a_measure_is_never_taken_over_a_backwards_interval(
    tmp_path: Path,
):
    """The floor under the two above, said once where it cannot be missed.

    A clamp would turn every one of these into a zero — a perfect score —
    so an interval that runs backwards is refused instead. Nothing may be
    measured from a moment it did not happen after.
    """
    conductor = VoiceConductor(
        line=LoopbackCounterpart(
            modality="voice", config={}, credentials=None
        ),
        voice=voice_from_traits({}),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="sim-backwards/dual-channel.wav",
    )
    conductor._clock = AudioClock(sample_rate_hz=16000, opened_unix_nano=0)
    with pytest.raises(ValueError, match="backwards"):
        await conductor._measure("time_to_first_word", 4800, 2400)


# -- What the legs are, and whose voice --------------------------------------


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
    observed = await voice_simulation(
        tmp_path, scenario=spoken, replies=["Noted."]
    )
    audio = observed.assembled.audio
    assert audio is not None
    assert_one_speaker_to_a_channel(
        (tmp_path / audio["recording"]).read_bytes(),
        [("human", "First sentence."), ("agent", "Noted.")],
    )


async def test_the_speaking_leg_is_built_with_the_authored_voice(
    tmp_path: Path,
):
    """The pipeline is assembled from this simulation's own spec, and the
    persona's voice is part of that spec — so the leg that just spoke a
    whole exchange is the one holding the authored voice."""
    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        voice={"provider": "elevenlabs", "voiceId": "brisk-tenor-7", "speed": 1.15},
    )
    conductor = observed.assembled.conductor
    assert conductor is not None
    spoke_with = conductor.speaking_voice
    assert (spoke_with.voice_id, spoke_with.provider, spoke_with.speed) == (
        "brisk-tenor-7",
        "elevenlabs",
        1.15,
    )

    # A persona authored with no voice still speaks, with the default one.
    plain = await voice_simulation(
        tmp_path, scenario="One point.", replies=["Noted."]
    )
    assert plain.assembled.conductor.speaking_voice.voice_id == DEFAULT_VOICE_ID


async def test_a_counterpart_that_echoes_hands_back_what_it_heard(
    tmp_path: Path,
):
    """The echo test line: the agent side is whatever the persona said.

    Nothing else can prove real speech legs without dialling somebody —
    a scripted script speaks the test codec, which no real transcriber
    can read. Here, with the scripted pair on both ends, the proof is
    exact: every agent turn is the persona turn before it.
    """
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        echoes_what_it_hears=True,
    )
    assert observed.turns[:4] == [
        ("human", "First point."),
        ("agent", "First point."),
        ("human", "Second point."),
        ("agent", "Second point."),
    ]

    # Both channels carry both spoken turns — which is what an echo is,
    # and the one exchange where a speaker's words are meant to be on the
    # other channel too.
    audio = observed.assembled.audio
    assert audio is not None
    persona_audio, agent_audio, band = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
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
    stt_key="deepgram-key-for-assembly-only",
    tts_key="elevenlabs-key-for-assembly-only",
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
    when a simulation starts, which is what lets the whole of this section
    run with no network and no account.
    """
    assembled = assemble(
        spec_for(**overrides), blobs=FilesystemBlobStore(tmp_path), speech=providers
    )
    try:
        yield assembled
    finally:
        await assembled.conductor.close()


async def test_a_deployment_that_configures_nothing_gets_the_scripted_pair(
    tmp_path: Path,
):
    """The default everywhere: CI, the free local demo, and any deployment
    that sets no provider variable."""
    async with assembled_with(
        SCRIPTED_PAIR, tmp_path, voice={"voiceId": "warm-alto-2"}
    ) as assembled:
        legs = assembled.conductor.legs
        assert isinstance(legs.tts, ScriptedTTS)
        assert isinstance(legs.stt, ScriptedSTT)
        assert isinstance(assembled.conductor.vad, ScriptedVAD)
        assert voice_on_the_leg(legs) == "warm-alto-2"


async def test_naming_the_providers_puts_their_stock_services_in_the_slots(
    tmp_path: Path,
):
    """Configuration alone selects them — the spec is the same one the
    scripted pair conducts, and no code above assembly changed."""
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

    async with assembled_with(REAL_PAIR, tmp_path) as assembled:
        legs = assembled.conductor.legs
        assert isinstance(legs.tts, ElevenLabsHttpTTSService)
        assert isinstance(legs.stt, DeepgramSTTService)


async def test_each_leg_is_chosen_on_its_own(tmp_path: Path):
    """A real mouth with scripted ears is a configuration somebody will
    want, and it costs one key rather than two."""
    from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService

    providers = SpeechProviders(
        tts="elevenlabs", tts_key="elevenlabs-key-for-assembly-only"
    )
    async with assembled_with(providers, tmp_path) as assembled:
        legs = assembled.conductor.legs
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
        assert voice_on_the_leg(assembled.conductor.legs) == "brisk-tenor-7"
        spoke_with = assembled.conductor.speaking_voice
        assert (spoke_with.voice_id, spoke_with.speed) == ("brisk-tenor-7", 1.15)


async def test_a_voice_authored_for_nobody_in_particular_is_still_honored(
    tmp_path: Path,
):
    """Traits naming a voice and no provider are authoring for whichever
    deployment runs them, so the id is used as written."""
    async with assembled_with(
        REAL_PAIR, tmp_path, voice={"voiceId": "brisk-tenor-7"}
    ) as assembled:
        assert voice_on_the_leg(assembled.conductor.legs) == "brisk-tenor-7"
        assert assembled.conductor.speaking_voice.voice_id == "brisk-tenor-7"


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
        legs = assembled.conductor.legs
        assert voice_on_the_leg(legs) == DEFAULT_ENGLISH_VOICE_ID, why
        assert assembled.conductor.speaking_voice.voice_id == DEFAULT_ENGLISH_VOICE_ID


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

    monkeypatch.setattr(conductor_module, "build_legs", refusing_legs)

    with pytest.raises(SpeechFault, match="payment_required"):
        await voice_simulation(tmp_path, scenario="One point.", replies=["Noted."])


async def test_a_brain_that_refuses_a_turn_fails_in_its_own_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The persona's brain runs inside the pipeline now, and a pipeline
    swallows what a processor raises into a log line. A model refusing a
    key is exactly the diagnosis a reader of the record needs, so it
    travels back out whole rather than becoming a duration limit."""

    def refusing_persona(*_args: object, **_kwargs: object):
        raise RuntimeError("model refused: unknown api key")

    monkeypatch.setattr(Persona, "next_turn", refusing_persona)

    with pytest.raises(RuntimeError, match="unknown api key"):
        await voice_simulation(tmp_path, scenario="One point.", replies=["Noted."])


async def test_a_turn_no_transcriber_finds_words_in_is_a_turn_without_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The other way a turn goes wrong, and the one a phone call makes
    ordinary: audio arrives and nobody can read it.

    A transcriber handed a stretch of audio it finds no words in pushes no
    frame at all — there is no empty transcript, only silence — and the
    turn model will not call a turn over until it has one. So the turn
    would stay open forever, and without a backstop the simulation runs to
    its duration limit and the record says "limit reached" about hold
    music. What the record should say is that the turn carried no words,
    which is what it did.
    """

    class DeafEars(FrameProcessor):
        """A listening leg that swallows audio and says nothing about it."""

        async def process_frame(self, frame, direction) -> None:
            await super().process_frame(frame, direction)
            if isinstance(frame, InputAudioRawFrame):
                return
            await self.push_frame(frame, direction)

    def deaf_legs(providers, *, voice, sample_rate_hz):
        return SpeechLegs(
            stt=DeafEars(),
            tts=ScriptedTTS(voice=voice, sample_rate_hz=sample_rate_hz),
            voice=voice,
        )

    monkeypatch.setattr(conductor_module, "build_legs", deaf_legs)

    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        # Only the waiting is shortened; what is given up on is exactly
        # what a deployment gives up on.
        parameters=ConductParameters(agent_turn_backstop_seconds=0.3),
    )

    assert observed.conducted.status == "completed"
    assert observed.conducted.ending == "persona_concluded"
    assert ("agent", "") in observed.turns, observed.turns


async def test_an_unconfigured_voice_exchange_connects_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Half the hermeticity guard: with nothing configured, no socket is
    ever connected — the whole simulation is conducted with connecting
    starved. The other half, that no provider library is so much as
    imported, is in the quarantine suite, where a fresh process can say
    it."""
    import socket

    def starved(*_args: object, **_kwargs: object):
        raise AssertionError("the scripted pair reached for the network")

    monkeypatch.setattr(socket.socket, "connect", starved)
    monkeypatch.setattr(socket.socket, "connect_ex", starved)

    observed = await voice_simulation(
        tmp_path, scenario="One point.", replies=["Noted."]
    )

    assert observed.conducted.status == "completed"
    assert ("agent", "Noted.") in observed.turns
    assert observed.assembled.audio is not None


def test_a_chat_spec_assembles_no_speech_legs_and_no_audio(tmp_path: Path):
    """Modality selects the legs and nothing else: a chat simulation is the
    plug on its own, walked, and its report has no audio to carry."""
    spec = SimulationSpec.from_document(scripted_spec("sim-chat"))
    assembled = assemble(spec, blobs=FilesystemBlobStore(tmp_path))
    assert assembled.conductor is None
    assert assembled.plug is not None
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
