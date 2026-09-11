"""Opt-in proof of the caller mix at a real LiveKit receiver.

This lane uses a stock LiveKit server, the installed Pipecat LiveKit transport,
and an independent RTC participant. It does not call a speech provider and it
does not prove Retell, phone, or human-perceived audio quality.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
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
from test_voice import spec_for

from egma_simulator.background import (
    DEFAULT_BACKGROUND_VOLUME,
    MAX_BACKGROUND_VOLUME,
    MIN_BACKGROUND_VOLUME,
    BackgroundSound,
    asset_catalog,
    soundfile_mixer,
)
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import (
    _INTERRUPTION_AUDIO,
    ConductParameters,
    VoiceConductor,
    _EvidenceRecorder,
)
from egma_simulator.conversation import ConversationControls
from egma_simulator.media import (
    _TRANSPORT_PLAYOUT_GENERATION,
    TRANSPORT_PLAYOUT,
    PlayoutStamp,
    VoiceMedia,
    transport_time,
)
from egma_simulator.media.room import JoinedRoom
from egma_simulator.model import ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.recording import channels_of
from egma_simulator.speech import SCRIPTED_PAIR, encode_speech, voice_from_models

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
    frame_times: list[float] = field(default_factory=list)
    subscribed: asyncio.Event = field(default_factory=asyncio.Event)
    stream: rtc.AudioStream | None = None
    reader: asyncio.Task[None] | None = None
    source: rtc.AudioSource | None = None

    async def publish(
        self, pcm: bytes, *, stop_after: asyncio.Event | None = None
    ) -> None:
        self.source = rtc.AudioSource(SAMPLE_RATE, 1)
        track = rtc.LocalAudioTrack.create_audio_track("controlled-agent", self.source)
        await self.room.local_participant.publish_track(
            track,
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
        )
        width = round(SAMPLE_RATE * FRAME_SECONDS) * 2
        for offset in range(0, len(pcm), width):
            chunk = pcm[offset : offset + width]
            if len(chunk) < width:
                chunk += bytes(width - len(chunk))
            await self.source.capture_frame(
                rtc.AudioFrame(
                    data=chunk,
                    sample_rate=SAMPLE_RATE,
                    num_channels=1,
                    samples_per_channel=len(chunk) // 2,
                )
            )
            if stop_after is not None and stop_after.is_set():
                self.source.clear_queue()
                silence = bytes(width)
                for _ in range(20):
                    await self.source.capture_frame(
                        rtc.AudioFrame(
                            data=silence,
                            sample_rate=SAMPLE_RATE,
                            num_channels=1,
                            samples_per_channel=len(silence) // 2,
                        )
                    )
                return

    async def close(self) -> None:
        if self.stream is not None:
            await self.stream.aclose()
        if self.reader is not None:
            self.reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader
        await self.room.disconnect()


class _AcceptedOutput(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.first = asyncio.Event()
        self.playout_at: float | None = None
        self.pcm: bytes | None = None
        self.frame: TTSAudioRawFrame | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        is_speech = (
            isinstance(frame, TTSAudioRawFrame)
            and any(
                abs(
                    int.from_bytes(
                        frame.audio[offset : offset + 2], "little", signed=True
                    )
                )
                > 100
                for offset in range(0, len(frame.audio), 2)
            )
        )
        if is_speech and not self.first.is_set():
            assert isinstance(frame, TTSAudioRawFrame)
            self.playout_at = transport_time(frame, TRANSPORT_PLAYOUT)
            self.pcm = bytes(frame.audio)
            self.frame = frame
            self.first.set()
        await self.push_frame(frame, direction)


class _QueuedLead(FrameProcessor):
    """Put quiet ahead of the first speech frame in the real transport queue."""

    def __init__(self, seconds: float) -> None:
        super().__init__()
        self._seconds = seconds
        self._added = False
        self.deliberate_pcm: bytes | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame) and not self._added:
            self._added = True
            frames = round(SAMPLE_RATE * self._seconds)
            await self.push_frame(
                OutputAudioRawFrame(bytes(frames * 2), SAMPLE_RATE, 1), direction
            )
        if (
            isinstance(frame, OutputAudioRawFrame)
            and frame.metadata.get(_INTERRUPTION_AUDIO) is True
            and self.deliberate_pcm is None
        ):
            self.deliberate_pcm = bytes(frame.audio)
        await self.push_frame(frame, direction)


class _LiveConductorConnection:
    """Give the public conductor one stock LiveKit transport and real peer."""

    def __init__(
        self,
        server,
        room_name: str,
        background: BackgroundSound,
        accepted: _AcceptedOutput | None = None,
        queued_lead_seconds: float = 0,
    ) -> None:
        self._room = JoinedRoom(
            url=server.url,
            token=_token(server.api_key, server.api_secret, room_name, "egma-persona"),
            room_name=room_name,
        )
        self._background = background
        self._accepted = accepted
        self._queued_lead_seconds = queued_lead_seconds
        self.lead: _QueuedLead | None = None

    @property
    def provider_reference(self) -> str:
        return "controlled-livekit-room"

    @property
    def far_end_left(self) -> bool:
        return self._room.ended.is_set()

    async def prepare(self):
        media = self._room.create_transport(
            audio_out_mixer=soundfile_mixer(self._background)
        )
        if self._accepted is None:
            return media
        lead = _QueuedLead(self._queued_lead_seconds)
        self.lead = lead
        return VoiceMedia(
            input=media.input,
            output=(lead, *media.output, self._accepted),
            ended=media.ended,
            failed=media.failed,
            transport_name=media.transport_name,
            input_recorded=media.input_recorded,
            real_time=media.real_time,
        )

    async def open(self) -> None:
        await self._room.wait_connected()

    async def close(self) -> None:
        await self._room.leave()


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
                capture.frame_times.append(time.monotonic())

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


async def test_real_caller_receives_deliberate_overlap_while_background_continues(
    live_livekit,
    tmp_path,
):
    """Exercise the conductor, mixer, recorder, and real RTC peer together."""
    room_name = f"egma-combined-proof-{uuid.uuid4().hex}"
    remote = await _observer(live_livekit, room_name)
    connection = _LiveConductorConnection(
        live_livekit,
        room_name,
        BackgroundSound("rain-v1", DEFAULT_BACKGROUND_VOLUME),
    )
    spec = spec_for(
        scenario="Interrupt with one brief relevant sentence.",
        greeting="",
        replies=[],
        max_turns=8,
        max_duration_seconds=15,
    )
    conductor = VoiceConductor(
        connection=connection,
        voice=voice_from_models(spec.models),
        speech=SCRIPTED_PAIR,
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="combined.wav",
        parameters=ConductParameters(interruption_level="frequent"),
    )
    conductor._random.uniform = lambda _low, _high: 0.1
    controls = ConversationControls()
    interruptions = []
    delivered = asyncio.Event()
    received_at_schedule = 0
    received_at_delivery = 0

    def on_interruption(evidence) -> None:
        nonlocal received_at_delivery, received_at_schedule
        interruptions.append(evidence)
        if evidence.event == "scheduled":
            received_at_schedule = len(remote.frames)
        elif evidence.event == "delivered":
            received_at_delivery = len(remote.frames)
            delivered.set()

    async def ignore(*_args) -> None:
        return None

    running = asyncio.create_task(
        conductor.conduct(
            persona=Persona(
                authored=spec.persona,
                scenario_instructions=spec.scenario_instructions,
                model=ScriptedModel("Please wait while I clarify that."),
            ),
            max_turns=spec.limits.max_turns,
            max_duration_seconds=spec.limits.max_duration_seconds,
            controls=controls,
            name="sim:combined-livekit-proof",
            on_utterance=ignore,
            on_measured=ignore,
            on_interruption=on_interruption,
        )
    )
    publishing = None
    try:
        await asyncio.sleep(0.2)
        assert interruptions == []
        publishing = asyncio.create_task(
            remote.publish(
                encode_speech(
                    "The agent keeps explaining the issue. " * 30,
                    SAMPLE_RATE,
                )
            )
        )
        await asyncio.wait_for(delivered.wait(), 10)
        await asyncio.sleep(0.2)
        controls.request_cancel()
        conducted = await asyncio.wait_for(running, 5)
        publishing.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await publishing

        assert conducted.status == "canceled"
        assert len(remote.tracks) == 1
        assert 0 < received_at_schedule < received_at_delivery
        assert any(
            _rms(frame) > 20
            for frame in remote.frames[received_at_schedule:received_at_delivery]
        )
        assert any(_rms(frame) > 20 for frame in remote.frames[received_at_delivery:])
        assert [event.event for event in interruptions].count("scheduled") == 1
        assert [event.event for event in interruptions].count("delivered") == 1

        assert conductor.audio is not None
        persona, agent, rate = channels_of(
            (tmp_path / conductor.audio.recording).read_bytes()
        )
        assert rate == SAMPLE_RATE
        actual = next(event for event in interruptions if event.event == "delivered")
        assert actual.began_unix_nano is not None
        assert actual.ended_unix_nano is not None
        recording_start = conductor.audio.started_unix_nano
        overlap_start = max(
            0, (actual.began_unix_nano - recording_start) * rate // 1_000_000_000
        )
        overlap_end = min(
            len(persona) // 2,
            (actual.ended_unix_nano - recording_start) * rate // 1_000_000_000,
        )
        assert any(
            abs(int.from_bytes(persona[offset : offset + 2], "little", signed=True))
            > 100
            and abs(int.from_bytes(agent[offset : offset + 2], "little", signed=True))
            > 100
            for offset in range(overlap_start * 2, overlap_end * 2, 2)
        )
    finally:
        controls.request_cancel()
        if not running.done():
            with contextlib.suppress(Exception):
                await asyncio.wait_for(running, 5)
        if publishing is not None and not publishing.done():
            publishing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await publishing
        await remote.close()


async def test_agent_stop_clears_deliberate_audio_queued_before_playout(
    live_livekit,
    tmp_path,
):
    """Accepted future audio is not evidence until the real caller can hear it."""
    room_name = f"egma-queued-interruption-{uuid.uuid4().hex}"
    remote = await _observer(live_livekit, room_name)
    accepted = _AcceptedOutput()
    connection = _LiveConductorConnection(
        live_livekit,
        room_name,
        BackgroundSound("rain-v1", DEFAULT_BACKGROUND_VOLUME),
        accepted,
        queued_lead_seconds=0.75,
    )
    spec = spec_for(
        scenario="Try one short interruption while the agent is speaking.",
        greeting="",
        replies=[],
        max_turns=8,
        max_duration_seconds=15,
    )
    conductor = VoiceConductor(
        connection=connection,
        voice=voice_from_models(spec.models),
        speech=SCRIPTED_PAIR,
        blobs=FilesystemBlobStore(tmp_path),
        recording_key="queued-before-playout.wav",
        parameters=ConductParameters(interruption_level="frequent"),
    )
    conductor._random.uniform = lambda _low, _high: 0.1
    controls = ConversationControls()
    interruptions = []
    canceled = asyncio.Event()
    canceled_at = None
    canceled_wall = None

    def on_interruption(evidence) -> None:
        nonlocal canceled_at, canceled_wall
        interruptions.append(evidence)
        if evidence.event == "canceled":
            assert conductor._recorder is not None
            canceled_at = conductor._recorder.clock_position
            canceled_wall = time.monotonic()
            canceled.set()

    async def ignore(*_args) -> None:
        return None

    running = asyncio.create_task(
        conductor.conduct(
            persona=Persona(
                authored=spec.persona,
                scenario_instructions=spec.scenario_instructions,
                model=ScriptedModel("Let me stop you there."),
            ),
            max_turns=spec.limits.max_turns,
            max_duration_seconds=spec.limits.max_duration_seconds,
            controls=controls,
            name="sim:queued-before-playout",
            on_utterance=ignore,
            on_measured=ignore,
            on_interruption=on_interruption,
        )
    )
    publishing = asyncio.create_task(
        remote.publish(
            encode_speech("The agent is still explaining. " * 40, SAMPLE_RATE),
            stop_after=accepted.first,
        )
    )
    try:
        await asyncio.wait_for(accepted.first.wait(), 10)
        assert accepted.playout_at is not None
        assert accepted.frame is not None
        assert conductor._recorder is not None
        accepted_at = conductor._recorder.playout_position(accepted.frame)
        await asyncio.wait_for(publishing, 3)
        await asyncio.wait_for(canceled.wait(), 3)
        assert canceled_at is not None
        assert canceled_at < accepted_at
        assert canceled_wall is not None
        assert canceled_wall < accepted.playout_at
        accepted_duration = len(accepted.pcm) / 2 / SAMPLE_RATE
        observed_through = accepted.playout_at + accepted_duration + 0.1
        await asyncio.sleep(max(0, observed_through - time.monotonic()))
        controls.request_cancel()
        conducted = await asyncio.wait_for(running, 5)

        assert conducted.status == "canceled"
        actual = next(event for event in interruptions if event.event == "canceled")
        assert actual.reason == "agent_stopped_before_playout"
        assert actual.began_unix_nano is None
        assert actual.ended_unix_nano is None
        assert not any(event.event == "delivered" for event in interruptions)
        assert conductor.audio is not None
        persona, agent, rate = channels_of(
            (tmp_path / conductor.audio.recording).read_bytes()
        )
        assert rate == SAMPLE_RATE
        assert any(
            abs(int.from_bytes(agent[offset : offset + 2], "little", signed=True)) > 100
            for offset in range(0, len(agent), 2)
        )
        assert accepted.pcm is not None
        assert connection.lead is not None
        assert connection.lead.deliberate_pcm is not None
        deliberate_pcm = connection.lead.deliberate_pcm
        accepted_start = round(float(accepted_at) * rate) * 2
        accepted_end = accepted_start + len(accepted.pcm)
        scheduled_recording = persona[accepted_start:accepted_end]
        chunk_bytes = rate // 1_000 * 2
        accepted_generation = accepted.frame.metadata.get(
            _TRANSPORT_PLAYOUT_GENERATION
        )
        assert isinstance(accepted_generation, int)
        assert accepted_generation in conductor._recorder._cleared_playout
        assert (
            conductor._recorder._cleared_playout[accepted_generation]
            < accepted.playout_at
        )
        leaked_chunks = [
            offset
            for offset in range(0, len(deliberate_pcm), chunk_bytes)
            if _rms(deliberate_pcm[offset : offset + chunk_bytes]) > 4_000
            and deliberate_pcm[offset : offset + chunk_bytes] in scheduled_recording
        ]
        assert not leaked_chunks, leaked_chunks
        scheduled_remote = [
            frame
            for frame, received_at in zip(
                remote.frames, remote.frame_times, strict=True
            )
            if accepted.playout_at <= received_at <= observed_through
        ]
        background_remote = [
            frame
            for frame, received_at in zip(
                remote.frames, remote.frame_times, strict=True
            )
            if accepted.playout_at - 0.2 <= received_at < accepted.playout_at
        ]
        assert background_remote
        assert scheduled_remote
        assert any(_rms(frame) > 20 for frame in scheduled_remote)
        background_peak = max(_rms(frame) for frame in background_remote)
        assert max(_rms(frame) for frame in scheduled_remote) <= background_peak * 1.5
    finally:
        controls.request_cancel()
        if not running.done():
            with contextlib.suppress(Exception):
                await asyncio.wait_for(running, 5)
        if not publishing.done():
            publishing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await publishing
        await remote.close()
