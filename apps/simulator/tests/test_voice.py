"""The voice conductor, in process: a whole simulation, fast and exact.

One real Pipecat pipeline against the loopback counterpart: the persona
brain writes the words, the speaking leg turns them into PCM, the line
carries them a slice at a time, the voice activity detector hears the far
end start and stop, the turn model says when it has finished, and the
transcriber reads it back. Nothing here reaches a model, a provider, or a
network.

Every number asserted below is measured from the audio that flowed —
positions on the conversation's own sample timeline — rather than from a
packet-arrival clock. Transcript boundaries may differ by one media frame,
and the acceptance proves that this offset does not grow.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from conftest import (
    A_NAME,
    A_PERSONALITY,
    assert_one_speaker_to_a_channel,
    loopback_spec,
    scripted_spec,
    speech_in_the_recording,
)
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import TextFrame
from pipecat.processors.frame_processor import FrameProcessor

from egma_simulator import conductor as conductor_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import ConductParameters, VoiceConductor
from egma_simulator.contract import ERROR
from egma_simulator.media import VoiceMedia
from egma_simulator.media.scripted_transport import ScriptedTransport
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import Assembled, assemble
from egma_simulator.plugs import PlugError, failed_ending
from egma_simulator.recording import (
    AGENT_CHANNEL,
    PERSONA_CHANNEL,
    channels_of,
    dual_channel_wav,
)
from egma_simulator.spec import AuthoredPersona, SimulationSpec
from egma_simulator.speech import (
    CONVERSATION_VAD,
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
    voice_from_models,
)
from egma_simulator.walk import Conducted, WalkControls

TTS_VOICE = {"provider": "cartesia", "voiceId": "warm-alto-2", "speed": 0.9}

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
        return [milliseconds for name, milliseconds in self.measures if name == measure]


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

    async def on_utterance(speaker: str, text: str, began: int, ended: int) -> None:
        spans.append((speaker, text, began, ended))

    async def on_measured(measure: str, began: int, ended: int) -> None:
        measures.append((measure, (ended - began) / NANOSECONDS_PER_MILLISECOND))

    conducted = await conductor.conduct(
        persona=Persona(
            authored=spec.persona,
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


def test_the_persona_voice_comes_from_the_pinned_tts_selection():
    spec = spec_for(voice=TTS_VOICE)
    voice = voice_from_models(spec.models)
    assert (voice.voice_id, voice.provider, voice.speed) == (
        "warm-alto-2",
        "cartesia",
        0.9,
    )

    assert spec.persona == AuthoredPersona(
        name=A_NAME,
        personality=A_PERSONALITY,
        language="en-US",
    )


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
    detector = ScriptedVAD()
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

    scripted = build_vad(SCRIPTED_PAIR)
    assert isinstance(scripted, ScriptedVAD)

    from pipecat.audio.vad.silero import SileroVADAnalyzer

    chosen = build_vad(SpeechProviders(vad="silero"))
    assert isinstance(chosen, SileroVADAnalyzer)


def test_one_live_simulation_keeps_one_silero_model_state(
    monkeypatch: pytest.MonkeyPatch,
):
    """A detector starts clean, then keeps its context until this simulation ends."""
    from pipecat.audio.vad import silero

    now = [0.0]
    monkeypatch.setattr(silero.time, "time", lambda: now[0])
    detector = build_vad(SpeechProviders(vad="silero"))
    detector.set_sample_rate(16000)

    window = b"\0" * detector.num_frames_required() * 2
    detector.voice_confidence(window)

    resets = 0
    reset_states = detector._model.reset_states

    def count_reset(batch_size: int = 1) -> None:
        nonlocal resets
        resets += 1
        reset_states(batch_size)

    monkeypatch.setattr(detector._model, "reset_states", count_reset)
    now[0] = 6.0
    detector.voice_confidence(window)

    assert resets == 0
    assert build_vad(SpeechProviders(vad="silero")) is not detector


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


async def test_incoming_audio_continues_while_the_persona_thinks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A model wait cannot stop the transport input side of Pipecat."""
    spec = spec_for(
        scenario="One point.", greeting="Front desk, hello.", replies=["Noted."]
    )
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    conductor = assembled.conductor
    assert conductor is not None
    transport = conductor._connection.transport
    reply_to = Persona.reply_to

    async def delayed(persona: Persona, messages):
        before = transport.input_frames
        for _ in range(100):
            await asyncio.sleep(0)
            if transport.input_frames > before:
                break
        assert transport.input_frames > before
        return await reply_to(persona, messages)

    monkeypatch.setattr(Persona, "reply_to", delayed)
    observed = await observe(conductor, assembled, spec, controls=WalkControls())
    assert observed.conducted.status == "completed"


async def test_both_ends_of_every_turn_are_read_off_the_audio(tmp_path: Path):
    """Every transcript turn is spoken and stays ordered on the audio clock."""
    observed = await voice_simulation(
        tmp_path,
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
    )
    for speaker, text, began, ended in observed.spans:
        assert ended > began, (speaker, text)

    opened = [began for _speaker, _text, began, _ended in observed.spans]
    closed = [ended for _speaker, _text, _began, ended in observed.spans]
    assert opened == sorted(opened)
    assert closed == sorted(closed)
    # Nobody interrupted anybody, so no two turns cross.
    assert all(
        closed[position] <= opened[position + 1] for position in range(len(opened) - 1)
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
    assert set(audio) == {"recording"}
    assert channels_of(recording)[2] > 0

    # Every transcript turn was carried on its own speaker's channel and on
    # neither of the other's, including the final words that conclude the run.
    carried = observed.turns
    assert_one_speaker_to_a_channel(recording, carried)


async def test_every_span_points_at_the_audio_it_names(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The two channels are one clock, and the spans are on it.

    Both directions carry the same number of samples, quiet included, so
    the recording is the conversation's own timeline. Every stretch of
    speech a listener can find on it — either channel — is one turn's
    span on that shared timeline. Its transcript boundary stays within one
    media frame, and the offset at the final spoken turn does not grow from
    the first. The check uses the audio, not a second transcript clock.
    """
    opened_unix_nano = 1_800_000_000_000_000_000
    monkeypatch.setattr(conductor_module, "_now", lambda: opened_unix_nano)
    spec = spec_for(
        scenario="First point. Second point.",
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    conductor = assembled.conductor
    assert conductor is not None
    transport = conductor._connection.transport

    def no_recorder_backpressure(_frame: InputAudioRawFrame) -> asyncio.Event:
        acknowledged = asyncio.Event()
        acknowledged.set()
        return acknowledged

    monkeypatch.setattr(transport, "wait_for_ack", no_recorder_backpressure)
    input_processor = transport.media.input[0]
    push_frame = input_processor.push_frame
    arrival_clock = [0.0]
    recording_clock = [0.0]
    quiet_after_speech = 0
    inserted_gap = False

    class RecordingTime:
        @staticmethod
        def monotonic() -> float:
            return recording_clock[0]

        @staticmethod
        def time() -> float:
            return recording_clock[0]

    from pipecat.audio.resamplers import soxr_stream_resampler
    from pipecat.frames.frames import InputAudioRawFrame
    from pipecat.processors.audio import audio_buffer_processor

    monkeypatch.setattr(audio_buffer_processor, "time", RecordingTime)
    monkeypatch.setattr(soxr_stream_resampler, "time", RecordingTime)
    process_recording = conductor_module._EvidenceRecorder._process_recording
    held_one_frame = False

    async def briefly_hold_the_recorder(recorder, frame):
        nonlocal held_one_frame
        if isinstance(frame, InputAudioRawFrame) and not held_one_frame:
            held_one_frame = True
            await asyncio.sleep(0.3)
        if isinstance(frame, InputAudioRawFrame):
            recording_clock[0] = frame.metadata["test.recorded_at"]
        await process_recording(recorder, frame)

    monkeypatch.setattr(
        conductor_module._EvidenceRecorder,
        "_process_recording",
        briefly_hold_the_recorder,
    )

    async def carry_one_transport_gap(frame, direction=None):
        nonlocal inserted_gap, quiet_after_speech
        if isinstance(frame, InputAudioRawFrame):
            arrival_clock[0] += frame.num_frames / frame.sample_rate
            if carries_speech(frame.audio):
                quiet_after_speech = max(quiet_after_speech, 1)
            elif quiet_after_speech:
                quiet_after_speech += 1
                if quiet_after_speech == 11:
                    arrival_clock[0] += 1.0
                    inserted_gap = True
            frame.metadata["test.recorded_at"] = arrival_clock[0]
        if direction is None:
            await push_frame(frame)
        else:
            await push_frame(frame, direction)

    monkeypatch.setattr(input_processor, "push_frame", carry_one_transport_gap)
    observed = await observe(conductor, assembled, spec, controls=WalkControls())
    assert inserted_gap
    audio = observed.assembled.audio
    assert audio is not None
    persona_audio, agent_audio, band = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
    )
    assert len(persona_audio) == len(agent_audio)

    heard = speech_in_the_recording((tmp_path / audio["recording"]).read_bytes())
    spoken = observed.spans
    assert [speaker for speaker, _began, _ended in heard] == [
        speaker for speaker, _text, _began, _ended in spoken
    ]

    def in_samples(instants: list[int]) -> list[int]:
        return [
            round((instant - opened_unix_nano) * band / 1_000_000_000)
            for instant in instants
        ]

    media_frame = round(0.02 * band)
    recorded_begins = [began for _speaker, began, _ended in heard]
    transcript_begins = in_samples([began for _speaker, _text, began, _ended in spoken])
    recorded_ends = [ended for _speaker, _began, ended in heard]
    transcript_ends = in_samples([ended for _speaker, _text, _began, ended in spoken])
    begin_offsets = [
        recorded - transcript
        for recorded, transcript in zip(recorded_begins, transcript_begins, strict=True)
    ]
    end_offsets = [
        recorded - transcript
        for recorded, transcript in zip(recorded_ends, transcript_ends, strict=True)
    ]
    first_offsets = (begin_offsets[0], end_offsets[0])
    final_offsets = (begin_offsets[-1], end_offsets[-1])
    assert all(abs(offset) <= media_frame for offset in begin_offsets + end_offsets)
    assert all(
        abs(final - first) <= media_frame
        for first, final in zip(first_offsets, final_offsets, strict=True)
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
    persona_turns = sum(1 for speaker, _ in observed.turns if speaker == "human")

    assert named.count("time_to_first_word") == agent_turns
    assert named.count("agent_speech_duration") == agent_turns
    assert named.count("persona_speech_duration") == persona_turns
    # The measures every simulation reports are still there: voice adds
    # measurements, it does not replace them.
    assert named.count("first_response_latency") == 1
    assert named.count("turn_response_latency") == persona_turns - 1

    # Each turn includes real quiet before the first word. The recording
    # alignment check above owns the frame-level timing assertion.
    assert all(
        milliseconds > 0
        for milliseconds in observed.milliseconds_of("time_to_first_word")
    )
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


async def test_an_exchange_the_agent_ends_still_leaves_a_recording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    spec = spec_for(
        scenario="One final point.",
        replies=["All sorted, goodbye now."],
        ends_after_replies=False,
    )
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    conductor = assembled.conductor
    assert conductor is not None
    transport = conductor._connection.transport
    persona_stopped = VoiceConductor.persona_stopped

    async def agent_departs_as_the_concluding_tts_stops(
        active: VoiceConductor,
    ) -> None:
        if active._pending_persona_concludes:
            active.agent_is_departing()
            transport.stop()
        await persona_stopped(active)

    monkeypatch.setattr(
        VoiceConductor,
        "persona_stopped",
        agent_departs_as_the_concluding_tts_stops,
    )
    observed = await observe(conductor, assembled, spec, controls=WalkControls())

    assert observed.conducted.ending == "agent_ended"
    assert observed.conducted.reason == "the agent ended the exchange"
    assert ("agent", "All sorted, goodbye now.") in observed.turns
    goodbye = next(span for span in observed.spans if span[1] == GOODBYE)
    assert goodbye[3] > goodbye[2]
    audio = observed.assembled.audio
    assert audio is not None
    recording = (tmp_path / audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(recording, observed.turns)


class _ProductionStopScriptedVAD(ScriptedVAD):
    """The exact test detector with the live detector's stop window."""

    def set_sample_rate(self, sample_rate: int) -> None:
        super().set_sample_rate(sample_rate)
        self.set_params(
            self.params.model_copy(update={"stop_secs": CONVERSATION_VAD.stop_secs})
        )


async def test_production_stop_window_needs_the_full_declared_quiet_period():
    """The test detector recalculates its counters after taking live settings."""
    detector = _ProductionStopScriptedVAD()
    band = 16000
    detector.set_sample_rate(band)
    state = await detector.analyze_audio(encode_speech("a", band))
    assert state is VADState.SPEAKING

    quiet_windows = round(
        CONVERSATION_VAD.stop_secs * band / detector.num_frames_required()
    )
    for _ in range(quiet_windows - 1):
        state = await detector.analyze_audio(bytes(detector.num_frames_required() * 2))
    assert state is not VADState.QUIET
    state = await detector.analyze_audio(bytes(detector.num_frames_required() * 2))
    assert state is VADState.QUIET


class _AbruptDeparture:
    """An agent that leaves while its final utterance is still active."""

    def __init__(self) -> None:
        self.transport = ScriptedTransport(
            greeting="These are my final words before I leave the room now.",
            replies=[],
            answer_delay_seconds=0,
            ends_after_replies=True,
            # Short enough that the live 0.8 s VAD is still active, but long
            # enough to prove partial quiet is removed from the turn boundary.
            hangup_silence_seconds=0.1,
        )

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def far_end_left(self) -> bool:
        return self.transport.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        return self.transport.media

    async def open(self) -> None:
        await self.transport.activate()

    async def close(self) -> None:
        self.transport.stop()


async def test_departure_finalizes_the_active_agent_utterance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A live 0.8 second VAD stop window cannot erase the last words."""
    opened_unix_nano = 1_800_000_000_000_000_000
    monkeypatch.setattr(conductor_module, "_now", lambda: opened_unix_nano)
    detector = _ProductionStopScriptedVAD()
    monkeypatch.setattr(
        conductor_module,
        "build_vad",
        lambda _speech: detector,
    )
    spec = spec_for(scenario="A scenario the agent ends itself.")
    connection = _AbruptDeparture()
    conductor = VoiceConductor(
        connection=connection,
        voice=voice_from_models(spec.models),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
    )

    observed = await observe(
        conductor, Assembled(conductor=conductor), spec, controls=WalkControls()
    )

    assert observed.conducted.ending == "agent_ended"
    assert observed.turns == [
        ("agent", "These are my final words before I leave the room now.")
    ]
    audio = observed.assembled.audio
    assert audio is not None
    recording = (tmp_path / audio["recording"]).read_bytes()
    heard = speech_in_the_recording(recording)
    assert len(heard) == 1
    _speaker, recorded_began, recorded_ended = heard[0]
    _speaker, _text, began, ended = observed.spans[0]
    _persona, _agent, band = channels_of(recording)
    transcript_began = round((began - opened_unix_nano) * band / 1_000_000_000)
    transcript_ended = round((ended - opened_unix_nano) * band / 1_000_000_000)
    media_frame = round(0.02 * band)
    assert abs(recorded_began - transcript_began) <= media_frame
    assert abs(recorded_ended - transcript_ended) <= media_frame


class _TransportLost:
    """A connected media path that fails without its agent leaving."""

    def __init__(self) -> None:
        self.transport = ScriptedTransport(
            greeting="Front desk, hello.",
            replies=[],
            answer_delay_seconds=0,
            ends_after_replies=False,
        )
        self.failed = asyncio.Event()

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def far_end_left(self) -> bool:
        return False

    async def prepare(self) -> VoiceMedia:
        media = self.transport.media
        return VoiceMedia(
            input=media.input,
            output=media.output,
            ended=media.ended,
            failed=self.failed,
            input_recorded=media.input_recorded,
        )

    async def open(self) -> None:
        await self.transport.activate()
        self.failed.set()
        await asyncio.Event().wait()

    async def close(self) -> None:
        self.transport.stop()


async def test_transport_loss_is_a_platform_fault(tmp_path: Path):
    spec = spec_for(scenario="One point.")
    connection = _TransportLost()
    conductor = VoiceConductor(
        connection=connection,
        voice=voice_from_models(spec.models),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
    )

    with pytest.raises(PlugError) as lost:
        await asyncio.wait_for(
            observe(
                conductor,
                Assembled(conductor=conductor),
                spec,
                controls=WalkControls(),
            ),
            timeout=1.0,
        )

    assert failed_ending(lost.value) == ERROR
    assert "voice transport disconnected" in str(lost.value)


async def test_the_persona_opens_when_the_far_end_does_not(tmp_path: Path):
    """No greeting is not a broken call: a persona may speak first."""
    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        parameters=ConductParameters(agent_opening_seconds=1.0),
    )
    assert observed.turns[0] == ("human", "One point.")
    audio = observed.assembled.audio
    assert audio is not None
    assert (tmp_path / audio["recording"]).exists()


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
    """A connection that is still opening when the stop lands."""

    def __init__(self, stop: Callable[[], None] | None = None) -> None:
        self._stop = stop
        self._transport = ScriptedTransport(
            greeting=None,
            replies=[],
            answer_delay_seconds=0,
            ends_after_replies=False,
        )
        self.closed = False

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def far_end_left(self) -> bool:
        return False

    async def prepare(self) -> VoiceMedia:
        return self._transport.media

    async def open(self) -> None:
        if self._stop is not None:
            # A directive really arrives on a heartbeat's answer, which is
            # a task of its own landing mid-dial. This is that moment,
            # named by the test instead of raced for.
            self._stop()
        await asyncio.Event().wait()

    async def close(self) -> None:
        self.closed = True
        self._transport.stop()


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
        connection=line,
        voice=voice_from_models(spec.models),
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
        def legs(providers, *, voice):
            async def connecting() -> None:
                stop()
                await asyncio.Event().wait()

            return SpeechLegs(
                stt=ScriptedSTT(),
                tts=ScriptedTTS(voice=voice),
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


class _OverlappingConnection:
    """A transport fixture whose agent speaks while persona audio is accepted."""

    def __init__(self) -> None:
        self.transport = ScriptedTransport(
            greeting="",
            replies=[],
            answer_delay_seconds=0,
            ends_after_replies=False,
        )

    @property
    def provider_reference(self) -> str | None:
        return None

    @property
    def far_end_left(self) -> bool:
        return self.transport.ended.is_set()

    async def prepare(self) -> VoiceMedia:
        return self.transport.media

    async def open(self) -> None:
        await self.transport.activate()

    async def close(self) -> None:
        self.transport.stop()


async def test_genuine_overlap_stays_in_the_transcript_and_recording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The running Pipecat path keeps two speakers on one media timeline."""
    spec = spec_for(
        scenario=(
            "A long first point that keeps the persona speaking while the "
            "agent starts its own answer over the top of the same recording."
        )
    )
    connection = _OverlappingConnection()
    original = connection.transport.accepted_output
    injected = False

    async def agent_starts_while_persona_audio_is_accepted(frame) -> None:
        nonlocal injected
        await original(frame)
        if injected:
            return
        injected = True
        connection.transport._queue_words("Right, go on.")

    monkeypatch.setattr(
        connection.transport,
        "accepted_output",
        agent_starts_while_persona_audio_is_accepted,
    )
    conductor = VoiceConductor(
        connection=connection,
        voice=voice_from_models(spec.models),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
        parameters=ConductParameters(agent_opening_seconds=0.2),
    )
    observed = await observe(
        conductor, Assembled(conductor=conductor), spec, controls=WalkControls()
    )

    persona = next(
        span for span in observed.spans if span[0] == "human" and span[1] != GOODBYE
    )
    agent = next(span for span in observed.spans if span[0] == "agent")
    assert persona[2] < agent[3] and agent[2] < persona[3]

    audio = observed.assembled.audio
    assert audio is not None
    persona_track, agent_track, _rate = channels_of(
        (tmp_path / audio["recording"]).read_bytes()
    )
    persona_samples = {
        position
        for position in range(0, len(persona_track), 2)
        if persona_track[position : position + 2] != b"\x00\x00"
    }
    agent_samples = {
        position
        for position in range(0, len(agent_track), 2)
        if agent_track[position : position + 2] != b"\x00\x00"
    }
    assert persona_samples & agent_samples

    for measure in (
        "time_to_first_word",
        "first_response_latency",
        "turn_response_latency",
    ):
        assert measure not in observed.named


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
    observed = await voice_simulation(tmp_path, scenario=spoken, replies=["Noted."])
    audio = observed.assembled.audio
    assert audio is not None
    assert_one_speaker_to_a_channel(
        (tmp_path / audio["recording"]).read_bytes(),
        observed.turns,
    )


async def test_the_speaking_leg_is_built_with_the_pinned_tts_voice(
    tmp_path: Path,
):
    """The pipeline is assembled from this simulation's own spec, and the
    pinned persona model selection owns the voice in that spec — so the leg
    that just spoke a whole exchange holds that exact authored choice."""
    observed = await voice_simulation(
        tmp_path,
        scenario="One point.",
        replies=["Noted."],
        voice={"provider": "cartesia", "voiceId": "brisk-tenor-7", "speed": 1.15},
    )
    conductor = observed.assembled.conductor
    assert conductor is not None
    spoke_with = conductor.speaking_voice
    assert (spoke_with.voice_id, spoke_with.provider, spoke_with.speed) == (
        "brisk-tenor-7",
        "cartesia",
        1.15,
    )

    # The helper's complete TTS selection is also explicit.
    plain = await voice_simulation(tmp_path, scenario="One point.", replies=["Noted."])
    assert plain.assembled.conductor.speaking_voice.voice_id == "warm-alto-2"


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

    # The transcript proves what was echoed. The recording proves that each
    # echoed turn stayed on the speaker channel Pipecat assigned it.
    audio = observed.assembled.audio
    assert audio is not None
    assert_one_speaker_to_a_channel(
        (tmp_path / audio["recording"]).read_bytes(),
        observed.turns,
    )


def test_a_counterpart_cannot_both_echo_and_read_a_script(tmp_path: Path):
    with pytest.raises(PlugError, match="echoes_what_it_hears"):
        assemble(
            spec_for(echoes_what_it_hears=True, replies=["Certainly."]),
            blobs=FilesystemBlobStore(tmp_path),
            speech=SCRIPTED_PAIR,
        )


# -- Which legs, and whose voice ---------------------------------------------


async def test_the_unit_speech_pair_uses_the_voice_from_models(tmp_path: Path):
    """The deterministic pair is a test injection, not a runtime fallback."""
    spec = spec_for(voice=TTS_VOICE)
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    conductor = assembled.conductor
    assert conductor is not None
    try:
        legs = conductor.legs
        assert isinstance(legs.tts, ScriptedTTS)
        assert isinstance(legs.stt, ScriptedSTT)
        assert isinstance(conductor.vad, ScriptedVAD)
        assert legs.tts.voice == voice_from_models(spec.models)
    finally:
        await conductor.close()


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

    def refusing_legs(providers, *, voice):
        return SpeechLegs(
            stt=ScriptedSTT(),
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

    async def refusing_persona(*_args: object, **_kwargs: object):
        raise RuntimeError("model refused: unknown api key")

    monkeypatch.setattr(Persona, "reply_to", refusing_persona)

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
        """A listening leg that carries audio but emits no transcription."""

        async def process_frame(self, frame, direction) -> None:
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    def deaf_legs(providers, *, voice):
        return SpeechLegs(
            stt=DeafEars(),
            tts=ScriptedTTS(voice=voice),
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
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is None
    assert assembled.plug is not None
    assert assembled.audio is None
    assert list(tmp_path.iterdir()) == []


def test_assembling_a_spec_with_no_plug_refuses_before_anything_happens(
    tmp_path: Path,
):
    document = loopback_spec("sim-unplugged")
    document["connection"]["connection_type"] = "some-connection-nobody-wrote"
    with pytest.raises(PlugError, match="some-connection-nobody-wrote"):
        assemble(
            SimulationSpec.from_document(document),
            blobs=FilesystemBlobStore(tmp_path),
            speech=SCRIPTED_PAIR,
        )


async def test_a_wall_clock_gap_inside_one_utterance_loses_no_audio(
    monkeypatch: pytest.MonkeyPatch,
):
    """A slow machine is not a silence, and the recorder must not treat it
    as one.

    Pipecat's recorder resamples the agent's audio, and this recorder maps
    each turn onto that recording by reading the resampler's own
    ``delay()`` — the samples it has consumed and not yet emitted. The map
    is only true while every consumed sample is still accounted for.

    Pipecat clears that held state after 0.2 seconds of **wall-clock**
    quiet, which is the right default for audio that really did pause. It
    is the wrong one here, and the trigger is not the conversation: a
    loaded machine can be descheduled for longer than that between two
    frames of one continuous utterance. Nothing paused; only the CPU did.
    The clear then discards samples ``delay()`` had counted, the map grows
    a hole where they were, and a turn boundary landing inside it cannot
    be placed on the recording at all — a ``SpeechFault``, and a whole
    simulation failed over audio the recording actually holds.

    So this feeds one unbroken utterance across a clock jump far past that
    window and counts the samples out the other side. Sixteen kilohertz in
    and twenty-four out is the real ratio: three samples for every two.
    """
    from pipecat.audio.resamplers import soxr_stream_resampler

    clock = [1000.0]

    class Descheduled:
        @staticmethod
        def time() -> float:
            return clock[0]

        @staticmethod
        def monotonic() -> float:
            return clock[0]

    monkeypatch.setattr(soxr_stream_resampler, "time", Descheduled)

    recorder = conductor_module._EvidenceRecorder(sample_rate=24_000)
    frame = b"\x00\x01" * 320  # 20 ms at 16 kHz

    # Both channels, because the two fail differently and only one of them
    # says so. A clear on the agent's side breaks the map and raises; a
    # clear on the persona's side raises nothing, because `bot_position`
    # counts the buffer rather than reading a delay — it just drops the
    # tail of an utterance out of the recording and stays quiet about it.
    for channel, resampler in (
        ("agent", recorder._input_resampler),
        ("persona", recorder._output_resampler),
    ):
        clock[0] = 1000.0
        emitted = len(await resampler.resample(frame, 16_000, 24_000)) // 2
        # Long enough that Pipecat's own default would have cleared, and far
        # longer than any real machine takes for one frame.
        clock[0] += 5.0
        emitted += len(await resampler.resample(frame, 16_000, 24_000)) // 2
        held = float(resampler._soxr_stream.delay())

        fed = 2 * 320
        assert emitted + held == pytest.approx(
            fed * 24_000 / 16_000, abs=1.0
        ), channel
