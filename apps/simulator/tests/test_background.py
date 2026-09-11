from __future__ import annotations

import asyncio
from array import array

import pytest
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    OutputAudioRawFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams
from pipecat.workers.runner import WorkerRunner

from egma_simulator.background import (
    DEFAULT_BACKGROUND_VOLUME,
    MAX_BACKGROUND_VOLUME,
    MIN_BACKGROUND_VOLUME,
    BackgroundSound,
    asset_catalog,
    soundfile_mixer,
)
from egma_simulator.conductor import _EvidenceRecorder
from egma_simulator.media import PlayoutStamp


class _TransmittedAudio(BaseOutputTransport):
    def __init__(self, mixer) -> None:
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=24_000,
                audio_out_10ms_chunks=1,
                audio_out_mixer=mixer,
            )
        )
        self.audio: list[tuple[type[OutputAudioRawFrame], bytes]] = []
        self.background_ready = asyncio.Event()
        self.frames = asyncio.Event()

    async def start(self, frame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        self.audio.append((type(frame), bytes(frame.audio)))
        if len(self.audio) >= 2:
            self.background_ready.set()
        if len(self.audio) >= 8:
            self.frames.set()
        await asyncio.sleep(0.005)
        return True


class _RecordedOutput(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.audio: list[tuple[type[OutputAudioRawFrame], bytes]] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame):
            self.audio.append((type(frame), bytes(frame.audio)))
        await self.push_frame(frame, direction)


def test_all_packaged_assets_are_immutable_readable_files():
    catalog = asset_catalog()
    assert set(catalog) == {
        "office-v1",
        "cafe-v1",
        "street-traffic-v1",
        "crowd-talking-v1",
        "inside-car-v1",
        "home-tv-v1",
        "wind-v1",
        "rain-v1",
    }
    assert all(
        path.is_file() and path.stat().st_size > 900_000 for path in catalog.values()
    )


@pytest.mark.parametrize("volume", [0, float("nan"), 1])
def test_background_volume_stays_in_the_published_range(volume: float):
    with pytest.raises(ValueError, match="-36 dB and -12 dB"):
        BackgroundSound("rain-v1", volume)


async def test_background_gain_is_independent_and_the_final_mix_clips():
    quiet = soundfile_mixer(BackgroundSound("rain-v1", MIN_BACKGROUND_VOLUME))
    loud = soundfile_mixer(BackgroundSound("rain-v1", MAX_BACKGROUND_VOLUME))
    assert quiet is not None and loud is not None
    await quiet.start(24_000)
    await loud.start(24_000)
    silence = bytes(24_000 * 2)
    quiet_samples = array("h", await quiet.mix(silence))
    loud_samples = array("h", await loud.mix(silence))
    assert max(map(abs, loud_samples)) > max(map(abs, quiet_samples)) * 10

    hot_speech = array("h", [32_760] * 24_000).tobytes()
    protected = array("h", await loud.mix(hot_speech))
    assert max(protected) == 32_767
    await quiet.stop()
    await loud.stop()


async def test_pipecat_transmits_and_records_one_continuous_protected_mix():
    mixer = soundfile_mixer(BackgroundSound("rain-v1", DEFAULT_BACKGROUND_VOLUME))
    assert mixer is not None
    transport = _TransmittedAudio(mixer)
    recorded = _RecordedOutput()
    evidence = _EvidenceRecorder(num_channels=2, auto_start_recording=True)
    recorded_persona = bytearray()

    @evidence.event_handler("on_track_audio_data")
    async def keep_recording(
        _processor, _agent, persona, _sample_rate, _channels
    ) -> None:
        recorded_persona.extend(persona)

    worker = PipelineWorker(
        Pipeline([transport, PlayoutStamp(), recorded, evidence]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(transport.background_ready.wait(), 2)
        loud_speech = array("h", [30_000] * 240).tobytes()
        await worker.queue_frame(
            TTSAudioRawFrame(loud_speech, sample_rate=24_000, num_channels=1)
        )
        await asyncio.wait_for(transport.frames.wait(), 2)
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 2)
    finally:
        if not running.done():
            await worker.cancel()
            await running

    assert transport.audio[: len(recorded.audio)] == recorded.audio
    speech = [pcm for kind, pcm in recorded.audio if issubclass(kind, TTSAudioRawFrame)]
    background_only = [
        pcm for kind, pcm in recorded.audio if not issubclass(kind, TTSAudioRawFrame)
    ]
    assert speech and len(background_only) >= 2
    assert any(any(frame) for frame in background_only)
    assert any(recorded_persona)
    assert max(array("h", speech[0])) <= 32_767
