"""A canceled deliberate interruption must not touch the persona's next turn.

Two live sequences reach the audio gate with a canceled interruption:

* the interjection's audio already passed the gate and waits in the transport
  when the agent goes quiet — the cancel queues an ``InterruptionFrame``, and
  Pipecat's output transport drops its whole queue, the turn's
  ``TTSStoppedFrame`` included;
* the agent goes quiet while the speaking leg is still making the audio, so
  every frame of the interjection reaches the gate after the cancel.

In both, the persona's next ordinary turn must be heard and recorded, and the
canceled interjection must never be handed to the transport. The pipeline here
is the speaking half of the real one, driven frame by frame, with every wait on
an event rather than on time.
"""

from __future__ import annotations

import asyncio
from fractions import Fraction
from pathlib import Path

import pytest
from pipecat.frames.frames import (
    EndFrame,
    ErrorFrame,
    Frame,
    InterruptionFrame,
    TextFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import WorkerRunner
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from egma_simulator import conductor as conductor_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import ConductParameters, VoiceConductor
from egma_simulator.media import PlayoutStamp
from egma_simulator.speech import PersonaVoice, ScriptedTTS, SpeechGain

pytestmark = pytest.mark.timeout(30)

INTERJECTION = "Sorry, one second."
ANSWER = "Yes, that time works."
NO_AUDIO_FAULT = (
    "Error processing frame: the persona's transcript turn ended without recorded audio"
)


class _Output(BaseOutputTransport):
    """A transport that holds every audio frame until released.

    A real-time source paces audio, so a frame the gate accepted can still be
    waiting in the transport when the agent goes quiet.
    """

    def __init__(self) -> None:
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=24_000,
                audio_out_channels=1,
            )
        )
        self.offered = asyncio.Event()
        self.release = asyncio.Event()
        self.written = 0

    async def start(self, frame) -> None:
        await super().start(frame)
        asyncio.create_task(self.set_transport_ready(frame))

    async def write_audio_frame(self, _frame) -> bool:
        self.offered.set()
        await self.release.wait()
        self.written += 1
        return True


class _Probe(FrameProcessor):
    """Say when a stop frame or an interruption reached the end of the line."""

    def __init__(self) -> None:
        super().__init__()
        self.stopped = asyncio.Event()
        self.interrupted = asyncio.Event()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSStoppedFrame):
            self.stopped.set()
        elif isinstance(frame, InterruptionFrame):
            self.interrupted.set()
        await self.push_frame(frame, direction)


class _Ear:
    """The agent is mid-sentence, so an interruption may start."""

    hearing_speech = True
    position = Fraction(0)


class _Connection:
    provider_reference = None


class _Media:
    def input_recorded(self, _frame) -> None:
        pass


class _Rig:
    """The speaking leg, the gate, the transport, the recorder, the timeline."""

    def __init__(self, tmp_path: Path) -> None:
        voice = PersonaVoice(voice_id="scripted", provider=None, speed=None)
        self.conductor = VoiceConductor(
            connection=_Connection(),
            voice=voice,
            blobs=FilesystemBlobStore(tmp_path),
            recording_key="discard-window/dual-channel.wav",
            parameters=ConductParameters(interruption_level="frequent"),
        )
        self.recorder = conductor_module._EvidenceRecorder(
            num_channels=2, auto_start_recording=True
        )
        self.conductor._recorder = self.recorder
        self.conductor._ear = _Ear()
        self.output = _Output()
        self.probe = _Probe()
        self.spoken: list[tuple[str, str]] = []
        self.turn_taken = asyncio.Event()

        async def on_utterance(speaker: str, text: str, _began: int, _ended: int):
            self.spoken.append((speaker, text))
            self.turn_taken.set()

        self.conductor._on_utterance = on_utterance
        self.worker = PipelineWorker(
            Pipeline(
                [
                    ScriptedTTS(voice=voice),
                    conductor_module._InterruptionAudioLimit(self.conductor),
                    SpeechGain(1.0),
                    self.output,
                    PlayoutStamp(),
                    conductor_module._InterruptionPlayout(self.conductor),
                    self.recorder,
                    conductor_module._Timeline(self.conductor, _Media(), self.recorder),
                    self.probe,
                ]
            ),
            enable_tracing=False,
            enable_turn_tracking=False,
            enable_rtvi=False,
            idle_timeout_secs=None,
        )
        self.conductor._worker = self.worker
        self.errors: list[str] = []
        self.failed = asyncio.Event()

        @self.worker.event_handler("on_pipeline_error")
        async def _remember(_worker, frame: ErrorFrame) -> None:
            self.errors.append(frame.error)
            self.failed.set()

        self._runner = WorkerRunner(handle_sigint=False)
        self._running: asyncio.Task | None = None

    async def __aenter__(self) -> _Rig:
        await self._runner.add_workers(self.worker)
        self._running = asyncio.create_task(self._runner.run())
        return self

    async def __aexit__(self, *_exc: object) -> None:
        running = self._running
        assert running is not None
        self.output.release.set()
        if not running.done():
            await self.worker.queue_frame(EndFrame())
            try:
                await asyncio.wait_for(running, 5)
            except TimeoutError:
                await asyncio.wait_for(self.worker.cancel(), 5)
                await asyncio.wait_for(running, 5)

    async def speak_ordinary_turn(self, text: str) -> None:
        """Speak one ordinary persona turn and wait for it to land or fail."""
        self.turn_taken.clear()
        self.conductor.persona_will_speak(text)
        await self.worker.queue_frame(TextFrame(text))
        await self.until_first(self.turn_taken, self.failed)

    async def until_first(self, *events: asyncio.Event) -> None:
        waits = [asyncio.create_task(event.wait()) for event in events]
        done, pending = await asyncio.wait(
            waits, timeout=5, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        assert done, "nothing happened on the pipeline within five seconds"


async def test_a_cancel_after_the_gate_does_not_eat_the_next_turn(
    tmp_path: Path,
) -> None:
    """The interjection waits in the transport when the agent goes quiet."""
    async with _Rig(tmp_path) as rig:
        conductor = rig.conductor
        conductor.persona_will_speak(INTERJECTION, deliberate=True)
        await rig.worker.queue_frame(TextFrame(INTERJECTION))
        await asyncio.wait_for(rig.output.offered.wait(), 5)
        assert conductor.deliberate_audio_queued

        conductor.agent_speech_stopped()
        assert not conductor.deliberate_response_owned
        rig.output.release.set()
        await asyncio.wait_for(rig.probe.interrupted.wait(), 5)
        assert not conductor.discarding_deliberate_audio

        await rig.speak_ordinary_turn(ANSWER)

    assert rig.errors == []
    assert rig.spoken == [("human", ANSWER)]
    assert [(turn.speaker, turn.text) for turn in conductor.history] == [
        ("human", ANSWER)
    ]
    assert rig.output.written > 0


async def test_a_cancel_before_the_gate_keeps_the_interjection_off_the_line(
    tmp_path: Path,
) -> None:
    """The agent goes quiet while the speaking leg is still making the audio."""
    async with _Rig(tmp_path) as rig:
        conductor = rig.conductor
        conductor.persona_will_speak(INTERJECTION, deliberate=True)
        conductor.agent_speech_stopped()
        assert conductor.deliberate_response_owned
        assert conductor.discarding_deliberate_audio
        rig.output.release.set()

        await rig.worker.queue_frame(TextFrame(INTERJECTION))
        await asyncio.wait_for(rig.probe.stopped.wait(), 5)
        assert not rig.output.offered.is_set(), "the agent was handed the interjection"
        assert rig.output.written == 0
        assert conductor.history == []
        assert not conductor.deliberate_response_owned
        assert not conductor.discarding_deliberate_audio

        await rig.speak_ordinary_turn(ANSWER)

    assert rig.errors == []
    assert rig.spoken == [("human", ANSWER)]
    assert rig.output.written > 0


async def test_a_turn_with_no_audio_is_still_a_speech_fault(tmp_path: Path) -> None:
    """The guard behind the fault stays: a stop frame with nothing before it."""
    async with _Rig(tmp_path) as rig:
        rig.conductor.persona_will_speak(ANSWER)
        await rig.worker.queue_frame(TTSStoppedFrame())
        await rig.until_first(rig.failed)

    assert rig.errors == [NO_AUDIO_FAULT]
    assert rig.conductor.history == []
