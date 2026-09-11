"""Opt-in proof of the caller mix at a real LiveKit receiver.

This lane uses a stock LiveKit server, the installed Pipecat LiveKit transport,
and an independent RTC participant. It does not call a speech provider and it
does not prove Retell, phone, or human-perceived audio quality.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import uuid
from array import array
from dataclasses import dataclass, field

import pytest
from livekit import api, rtc
from pipecat.frames.frames import EndFrame, Frame, OutputAudioRawFrame, TTSAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
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

SAMPLE_RATE = 24_000
FRAME_SECONDS = 0.01


def _token(key: str, secret: str, room: str, identity: str) -> str:
    return (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )


def _rms(pcm: bytes) -> float:
    samples = array("h", pcm)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


class _SubmittedMix(FrameProcessor):
    """Keep the frames Pipecat has submitted to LiveKit, with their clock."""

    def __init__(self) -> None:
        super().__init__()
        self.frames: list[tuple[type[OutputAudioRawFrame], bytes, float]] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame):
            self.frames.append(
                (type(frame), bytes(frame.audio), frame.num_frames / frame.sample_rate)
            )
        await self.push_frame(frame, direction)


@dataclass
class _RemoteCapture:
    room: rtc.Room
    tracks: list[str] = field(default_factory=list)
    frames: list[bytes] = field(default_factory=list)
    subscribed: asyncio.Event = field(default_factory=asyncio.Event)
    stream: rtc.AudioStream | None = None
    reader: asyncio.Task[None] | None = None

    async def close(self) -> None:
        if self.stream is not None:
            await self.stream.aclose()
        if self.reader is not None:
            self.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader
        await self.room.disconnect()


async def _observer(server, room_name: str) -> _RemoteCapture:
    room = rtc.Room()
    capture = _RemoteCapture(room)

    @room.on("track_subscribed")
    def subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if (
            track.kind != rtc.TrackKind.KIND_AUDIO
            or participant.identity != "egma-persona"
        ):
            return
        capture.tracks.append(publication.sid)
        capture.stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)

        async def read() -> None:
            assert capture.stream is not None
            async for event in capture.stream:
                capture.frames.append(bytes(event.frame.data))

        capture.reader = asyncio.create_task(read())
        capture.subscribed.set()

    await room.connect(
        server.url,
        _token(server.api_key, server.api_secret, room_name, "controlled-receiver"),
        options=rtc.RoomOptions(auto_subscribe=True),
    )
    return capture


async def _received_mix(
    server, sound_id: str, volume: float
) -> tuple[_RemoteCapture, _SubmittedMix, bytearray]:
    room_name = f"egma-background-proof-{uuid.uuid4().hex}"
    remote = await _observer(server, room_name)
    mixer = soundfile_mixer(BackgroundSound(sound_id, volume))
    transport = LiveKitTransport(
        url=server.url,
        token=_token(server.api_key, server.api_secret, room_name, "egma-persona"),
        room_name=room_name,
        params=LiveKitParams(
            audio_in_enabled=False,
            audio_out_enabled=True,
            audio_out_sample_rate=SAMPLE_RATE,
            audio_out_channels=1,
            audio_out_10ms_chunks=1,
            audio_out_mixer=mixer,
        ),
    )
    submitted = _SubmittedMix()
    evidence = _EvidenceRecorder(num_channels=2, auto_start_recording=True)
    recorded_persona = bytearray()

    @evidence.event_handler("on_track_audio_data")
    async def recorded(_processor, _agent, persona, _sample_rate, _channels) -> None:
        recorded_persona.extend(persona)

    worker = PipelineWorker(
        Pipeline([transport.output(), PlayoutStamp(), submitted, evidence]),
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(remote.subscribed.wait(), 5)
        await asyncio.sleep(0.12)
        speech = array("h", [8_000] * int(SAMPLE_RATE * 0.1)).tobytes()
        await worker.queue_frame(
            TTSAudioRawFrame(speech, sample_rate=SAMPLE_RATE, num_channels=1)
        )
        await asyncio.sleep(0.25)
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 5)
        await asyncio.sleep(0.05)
        return remote, submitted, recorded_persona
    except BaseException:
        if not running.done():
            await worker.cancel()
            await running
        await remote.close()
        raise


@pytest.mark.parametrize("sound_id", [*asset_catalog(), "none"])
async def test_every_background_choice_reaches_one_real_caller_microphone_track(
    live_livekit,
    sound_id: str,
):
    remote, submitted, _recorded = await _received_mix(
        live_livekit,
        sound_id,
        DEFAULT_BACKGROUND_VOLUME,
    )
    try:
        assert len(remote.tracks) == 1
        assert remote.frames
        assert any(_rms(frame) > 100 for frame in remote.frames)

        speech = [
            frame
            for kind, frame, _duration in submitted.frames
            if issubclass(kind, TTSAudioRawFrame)
        ]
        background_only = [
            frame
            for kind, frame, _duration in submitted.frames
            if not issubclass(kind, TTSAudioRawFrame)
        ]
        assert speech
        if sound_id == "none":
            assert background_only == []
        else:
            assert len(background_only) >= 10
            assert _rms(b"".join(background_only)) > 20
            assert any(_rms(frame) > 20 for frame in remote.frames[:8])
            assert any(_rms(frame) > 20 for frame in remote.frames[20:])
    finally:
        await remote.close()


async def test_remote_background_gain_and_recording_follow_submitted_audio(
    live_livekit,
):
    quiet_remote, quiet, _quiet_recorded = await _received_mix(
        live_livekit, "rain-v1", MIN_BACKGROUND_VOLUME
    )
    loud_remote, loud, loud_recorded = await _received_mix(
        live_livekit, "rain-v1", MAX_BACKGROUND_VOLUME
    )
    try:
        quiet_noise = b"".join(
            frame
            for kind, frame, _ in quiet.frames
            if not issubclass(kind, TTSAudioRawFrame)
        )
        loud_noise = b"".join(
            frame
            for kind, frame, _ in loud.frames
            if not issubclass(kind, TTSAudioRawFrame)
        )
        quiet_speech = b"".join(
            frame
            for kind, frame, _ in quiet.frames
            if issubclass(kind, TTSAudioRawFrame)
        )
        loud_speech = b"".join(
            frame
            for kind, frame, _ in loud.frames
            if issubclass(kind, TTSAudioRawFrame)
        )
        quiet_received_before_speech = b"".join(quiet_remote.frames[:8])
        loud_received_before_speech = b"".join(loud_remote.frames[:8])

        assert _rms(loud_noise) > _rms(quiet_noise) * 8
        assert (
            _rms(loud_received_before_speech) > _rms(quiet_received_before_speech) * 6
        )
        assert 0.8 < _rms(loud_speech) / _rms(quiet_speech) < 1.25

        # Background frames are recorded on the same submitted-output clock but
        # retain their non-TTS type. They add recording time without becoming
        # persona speech evidence.
        submitted_seconds = sum(duration for _kind, _pcm, duration in loud.frames)
        received_active_seconds = sum(
            len(frame) / 2 / SAMPLE_RATE
            for frame in loud_remote.frames
            if _rms(frame) > 20
        )
        recorded_seconds = len(loud_recorded) / 2 / SAMPLE_RATE
        assert submitted_seconds >= 0.3
        assert received_active_seconds >= 0.3
        assert abs(recorded_seconds - submitted_seconds) < FRAME_SECONDS
        assert any(
            not issubclass(kind, TTSAudioRawFrame)
            for kind, _pcm, _duration in loud.frames
        )
        assert (
            sum(
                issubclass(kind, TTSAudioRawFrame)
                for kind, _pcm, _duration in loud.frames
            )
            > 0
        )
    finally:
        await quiet_remote.close()
        await loud_remote.close()
