"""Real local WebRTC peers exercise Retell signaling and two-way audio."""

from __future__ import annotations

import asyncio
import contextlib
import fractions
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from types import SimpleNamespace

import numpy as np
import pytest
from aiohttp import web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack, MediaStreamError
from av import AudioFrame, AudioResampler
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from egma_simulator.media import (
    TRANSPORT_ARRIVAL,
    TRANSPORT_PLAYOUT,
    MediaBackendError,
    PlayoutClearedFrame,
    RemoteParticipantLeftFrame,
    retell_gateway,
    transport_time,
)
from egma_simulator.media.retell_gateway import (
    RetellGatewayBackend,
    RetellGatewaySettings,
    _GatewayAudioTrack,
)

TOKEN = "gateway-token-sentinel"
CALL_ID = "call-local-peer"


class Tone(AudioStreamTrack):
    def __init__(self, frequency: int) -> None:
        super().__init__()
        self.frequency = frequency
        self.samples = 0

    async def recv(self) -> AudioFrame:
        await asyncio.sleep(0.02)
        if self.readyState != "live":
            raise MediaStreamError
        indexes = np.arange(self.samples, self.samples + 960)
        pcm = (6000 * np.sin(2 * np.pi * self.frequency * indexes / 48000)).astype(
            np.int16
        )
        frame = AudioFrame.from_ndarray(pcm[None, :], format="s16", layout="mono")
        frame.sample_rate = 48000
        frame.pts = self.samples
        frame.time_base = fractions.Fraction(1, 48000)
        self.samples += 960
        return frame


class NoAudio(AudioStreamTrack):
    async def recv(self) -> AudioFrame:
        await asyncio.Event().wait()
        raise MediaStreamError


@dataclass
class GatewayPeer:
    peers: list[RTCPeerConnection] = field(default_factory=list)
    readers: list[asyncio.Task[None]] = field(default_factory=list)
    received: bytearray = field(default_factory=bytearray)
    remote_audio: asyncio.Event = field(default_factory=asyncio.Event)
    ended: bool = False
    deleted: list[str] = field(default_factory=list)
    offers: list[str] = field(default_factory=list)
    frequency: int | None = 700

    async def final_status(self) -> bool:
        return self.ended

    def app(self) -> web.Application:
        app = web.Application()

        async def create(request: web.Request) -> web.Response:
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            assert request.match_info["call_id"] == CALL_ID
            document = await request.json()
            assert document["identity"] == "client"
            self.offers.append(document["sdp"])
            peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
            self.peers.append(peer)

            @peer.on("track")
            def track_arrived(track: object) -> None:
                self.readers.append(asyncio.create_task(self._receive(track)))

            peer.addTrack(
                Tone(self.frequency) if self.frequency is not None else NoAudio()
            )
            await peer.setRemoteDescription(
                RTCSessionDescription(document["sdp"], "offer")
            )
            await peer.setLocalDescription(await peer.createAnswer())
            assert peer.localDescription is not None
            return web.json_response(
                {"session_id": "peer-session", "sdp": peer.localDescription.sdp}
            )

        async def delete(request: web.Request) -> web.Response:
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            self.deleted.append(request.match_info["session_id"])
            return web.Response(status=204)

        path = "/webrtc-proxy/{call_id}/v1/webrtc/sessions"
        app.router.add_post(path, create)
        app.router.add_delete(path + "/{session_id}", delete)
        return app

    async def _receive(self, track: object) -> None:
        resample = AudioResampler("s16", "mono", 48000)
        try:
            while True:
                frame = await track.recv()
                for pcm in resample.resample(frame):
                    self.received.extend(pcm.to_ndarray().tobytes())
                    if dominant_frequency(self.received, 48000) > 1000:
                        self.remote_audio.set()
        except MediaStreamError:
            return

    async def close(self) -> None:
        for peer in self.peers:
            await peer.close()
        for reader in self.readers:
            reader.cancel()
        await asyncio.gather(*self.readers, return_exceptions=True)


@asynccontextmanager
async def serving(app: web.Application) -> AsyncIterator[str]:
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        await runner.cleanup()


class Capture(FrameProcessor):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.cleared = asyncio.Event()
        self.audio_ready = asyncio.Event()
        self.audio_seconds = 0.0
        self.audio: list[InputAudioRawFrame] = []
        self.played: list[OutputAudioRawFrame] = []
        self.markers: list[RemoteParticipantLeftFrame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.started.set()
        elif isinstance(frame, InputAudioRawFrame):
            self.audio.append(frame)
            self.audio_seconds += frame.num_frames / frame.sample_rate
            if self.audio_seconds >= 0.12:
                self.audio_ready.set()
        elif isinstance(frame, OutputAudioRawFrame):
            self.played.append(frame)
        elif isinstance(frame, RemoteParticipantLeftFrame):
            self.markers.append(frame)
            frame.completed.set()
        elif isinstance(frame, PlayoutClearedFrame):
            self.cleared.set()
        await self.push_frame(frame, direction)


def dominant_frequency(pcm: bytes | bytearray, sample_rate: int) -> float:
    samples = np.frombuffer(pcm, dtype=np.int16).astype(float)
    if len(samples) < sample_rate // 10 or not np.any(samples):
        return 0
    samples = samples[-sample_rate // 2 :]
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return float(np.argmax(spectrum) * sample_rate / len(samples))


@pytest.mark.parametrize("ending", ["normal", "media_failed", "provider_failed"])
async def test_real_peer_carries_audio_and_distinguishes_remote_end(
    ending: str, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(retell_gateway, "DEFAULT_ICE_SERVERS", [])
    peer = GatewayPeer()

    async def poll_status() -> bool:
        if ending == "provider_failed" and peer.ended:
            raise MediaBackendError("Retell reported call_status error")
        return peer.ended

    async with serving(peer.app()) as base_url:
        backend = RetellGatewayBackend(
            settings=RetellGatewaySettings(base_url, CALL_ID, TOKEN),
            simulation_id="sim-local-webrtc",
            confirm_remote_end=peer.final_status,
            poll_remote_end=poll_status,
        )
        media = await backend.create_transport()
        capture = Capture()
        worker = PipelineWorker(
            Pipeline([*media.input, *media.output, capture]),
            idle_timeout_secs=None,
            enable_tracing=False,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(capture.started.wait(), 3)
            await backend.dial()
            await backend.wait_answered(3)
            indexes = np.arange(24000)
            audio = (6000 * np.sin(2 * np.pi * 1400 * indexes / 24000)).astype(np.int16)
            await worker.queue_frame(OutputAudioRawFrame(audio.tobytes(), 24000, 1))
            await asyncio.wait_for(peer.remote_audio.wait(), 4)
            await asyncio.wait_for(capture.audio_ready.wait(), 3)
            inbound = b"".join(frame.audio for frame in capture.audio)
            assert dominant_frequency(inbound, capture.audio[0].sample_rate) == (
                pytest.approx(700, abs=15)
            )
            assert dominant_frequency(peer.received, 48000) == pytest.approx(
                1400, abs=15
            )
            assert all(frame.num_channels == 1 for frame in capture.audio)
            assert all(
                transport_time(frame, TRANSPORT_ARRIVAL) is not None
                for frame in capture.audio
            )
            assert capture.played
            assert all(
                transport_time(frame, TRANSPORT_PLAYOUT) is not None
                for frame in capture.played
            )
            assert "a=candidate:" in peer.offers[0]
            if ending == "normal":
                # Final provider status ends a call even if gateway media remains open.
                peer.ended = True
                await asyncio.wait_for(media.ended.wait(), 5)
                assert not media.failed.is_set()
                assert len(capture.markers) == 1
                assert peer.peers[0].connectionState == "connected"
            elif ending == "media_failed":
                await peer.peers[0].close()
                await asyncio.wait_for(media.failed.wait(), 5)
                assert not media.ended.is_set()
                assert capture.markers == []
                assert "normal call ending" in media.fault()
            else:
                peer.ended = True
                await asyncio.wait_for(media.failed.wait(), 5)
                assert not media.ended.is_set()
                assert peer.peers[0].connectionState == "connected"
                assert "call_status error" in media.fault()
        finally:
            await backend.teardown()
            await worker.queue_frame(EndFrame())
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(running, 3)
            if not running.done():
                await worker.cancel()
                await running
            await peer.close()
        assert peer.deleted == ["peer-session"]


async def test_interruption_discards_pending_gateway_audio():
    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-clear",
    )
    media = await backend.create_transport()
    capture = Capture()
    worker = PipelineWorker(
        Pipeline([*media.input, *media.output, capture]),
        idle_timeout_secs=None,
        enable_tracing=False,
        enable_turn_tracking=False,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(capture.started.wait(), 2)
        old_audio = np.full(480, 9000, dtype=np.int16).tobytes()
        queued = asyncio.create_task(backend._outbound.write(old_audio))
        await asyncio.sleep(0)
        await worker.queue_frame(InterruptionFrame())
        await asyncio.wait_for(capture.cleared.wait(), 2)
        assert await queued is False
        frame = await backend._outbound.recv()
        assert not np.any(frame.to_ndarray())
        next_audio = np.full(480, 4000, dtype=np.int16).tobytes()
        replacement = asyncio.create_task(backend._outbound.write(next_audio))
        await asyncio.sleep(0)
        frame = await backend._outbound.recv()
        assert await replacement
        assert np.all(frame.to_ndarray() == 4000)
    finally:
        await worker.queue_frame(EndFrame())
        await asyncio.wait_for(running, 2)
        await backend.teardown()


@pytest.mark.parametrize("provider_error", [True, False])
async def test_provider_startup_status_is_checked_before_first_audio(
    provider_error: bool, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(retell_gateway, "DEFAULT_ICE_SERVERS", [])
    peer = GatewayPeer(frequency=None)

    async def poll_status() -> bool:
        if provider_error:
            raise MediaBackendError("Retell reported a startup error")
        return True

    async with serving(peer.app()) as base_url:
        backend = RetellGatewayBackend(
            settings=RetellGatewaySettings(base_url, CALL_ID, TOKEN),
            simulation_id="sim-before-audio",
            poll_remote_end=poll_status,
        )
        media = await backend.create_transport()
        capture = Capture()
        worker = PipelineWorker(
            Pipeline([*media.input, *media.output, capture]),
            idle_timeout_secs=None,
            enable_tracing=False,
            enable_turn_tracking=False,
            enable_rtvi=False,
        )
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        running = asyncio.create_task(runner.run())
        try:
            await asyncio.wait_for(capture.started.wait(), 3)
            await backend.dial()
            with pytest.raises(MediaBackendError) as status:
                await backend.wait_answered(4)
            assert not backend._audio.is_set()
            if provider_error:
                assert status.value.ending == "error"
                assert media.failed.is_set()
                assert "startup error" in str(status.value)
                assert not media.ended.is_set()
            else:
                assert status.value.ending == "agent_never_joined"
                assert not media.failed.is_set()
                assert media.ended.is_set()
        finally:
            await backend.teardown()
            await worker.queue_frame(EndFrame())
            await asyncio.wait_for(running, 3)
            await peer.close()


async def test_audio_track_stops_without_leaving_a_blocked_writer():
    track = _GatewayAudioTrack(24000)
    writing = asyncio.create_task(track.write(bytes(960)))
    await asyncio.sleep(0)
    track.stop()
    assert await writing is False
    with pytest.raises(MediaStreamError):
        await track.recv()


@pytest.mark.parametrize("canceled_during", ["peer_close", "session_delete"])
async def test_repeated_teardown_finishes_after_its_first_caller_is_canceled(
    canceled_during: str,
):
    started = asyncio.Event()
    release = asyncio.Event()
    peer_closed = asyncio.Event()
    session_deleted = asyncio.Event()

    class ClosingPeer:
        async def close(self) -> None:
            if canceled_during == "peer_close":
                started.set()
                await release.wait()
            peer_closed.set()

    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-canceled-cleanup",
    )
    backend._peer = ClosingPeer()
    backend._session_id = "cleanup-session"

    async def remove_session(method: str, _url: str) -> dict:
        assert method == "DELETE"
        if canceled_during == "session_delete":
            started.set()
            await release.wait()
        session_deleted.set()
        return {}

    backend._request = remove_session
    first = asyncio.create_task(backend.teardown())
    await asyncio.wait_for(started.wait(), 1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(backend.teardown())
    await asyncio.sleep(0)
    assert not second.done(), "the next caller must wait for unfinished cleanup"
    release.set()
    await asyncio.wait_for(second, 1)
    assert peer_closed.is_set()
    assert session_deleted.is_set()


async def test_cleanup_does_not_wait_for_the_monitor_that_called_teardown():
    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-monitor-cleanup",
    )
    backend._monitor = asyncio.create_task(backend.teardown())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(backend._monitor, 1)
    await asyncio.wait_for(backend.teardown(), 1)
    assert backend._cleanup_task.done()


async def test_audio_pacing_does_not_accumulate_scheduler_overshoot(
    monkeypatch: pytest.MonkeyPatch,
):
    class Clock:
        now = 100.0
        waits = []

        def monotonic(self) -> float:
            return self.now

        async def sleep(self, seconds: float) -> None:
            self.waits.append(seconds)
            self.now += seconds + 0.003

    clock = Clock()
    monkeypatch.setattr(retell_gateway, "time", clock)
    monkeypatch.setattr(retell_gateway, "asyncio", SimpleNamespace(sleep=clock.sleep))
    track = _GatewayAudioTrack(24000)
    began = clock.now
    for _ in range(251):
        frame = await track.recv()
    elapsed_samples = frame.pts / frame.sample_rate
    assert clock.now - began - elapsed_samples < 0.005

    # A long stall must resume at the packet cadence instead of sending a burst.
    clock.now += 0.5
    await track.recv()
    resumed = clock.now
    await track.recv()
    assert clock.now - resumed >= 0.02
    track.stop()


async def test_gateway_refusal_and_settings_hide_credentials():
    app = web.Application()

    async def refused(_request: web.Request) -> web.Response:
        return web.Response(
            status=401,
            text=f"{TOKEN} turn-user turn-password api-key " + "x" * 1000,
        )

    app.router.add_post("/session", refused)
    async with serving(app) as base_url:
        settings = RetellGatewaySettings(
            base_url,
            CALL_ID,
            TOKEN,
            ice_servers=[
                {
                    "urls": "turn:localhost:3478",
                    "username": "turn-user",
                    "credential": "turn-password",
                }
            ],
            secrets=("api-key",),
        )
        backend = RetellGatewayBackend(settings=settings, simulation_id="sim-refusal")
        with pytest.raises(MediaBackendError) as fault:
            await backend._request("POST", f"{base_url}/session")
        for secret in (TOKEN, "turn-user", "turn-password", "api-key"):
            assert secret not in str(fault.value)
            assert secret not in repr(settings)
        assert len(str(fault.value)) < 300
        await backend.teardown()


@pytest.mark.parametrize("local_cancel", [True, False])
async def test_pending_confirmation_is_canceled_or_cannot_hide_media_failure(
    local_cancel: bool,
):
    checking = asyncio.Event()
    release = asyncio.Event()
    canceled = asyncio.Event()

    async def confirm() -> bool:
        checking.set()
        try:
            await release.wait()
            return True
        except asyncio.CancelledError:
            canceled.set()
            raise

    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-pending-confirmation",
        confirm_remote_end=confirm,
    )
    media = await backend.create_transport()
    backend._audio.set()
    backend._begin_remote_close()
    await asyncio.wait_for(checking.wait(), 1)
    if local_cancel:
        await backend.teardown()
        assert canceled.is_set()
        assert not media.failed.is_set()
    else:
        backend._fail("inbound decoding failed")
        release.set()
        await asyncio.wait_for(backend._remote_close, 1)
        assert media.failed.is_set()
        assert media.fault() == "inbound decoding failed"
        await backend.teardown()
    assert not media.ended.is_set()


async def test_repeated_remote_close_emits_one_ordered_marker():
    async def confirm() -> bool:
        return True

    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-repeated-close",
        confirm_remote_end=confirm,
    )
    media = await backend.create_transport()
    backend._audio.set()
    input_transport = media.input[0]
    input_transport._audio_in_queue = asyncio.Queue()
    markers = []

    async def acknowledge(frame: RemoteParticipantLeftFrame) -> None:
        markers.append(frame)
        frame.completed.set()

    input_transport.push_frame = acknowledge
    try:
        backend._begin_remote_close()
        backend._begin_remote_close()
        await asyncio.wait_for(media.ended.wait(), 1)
        backend._begin_remote_close()
        assert len(markers) == 1
        assert not media.failed.is_set()
    finally:
        await backend.teardown()


async def test_join_timeout_and_input_failure_have_distinct_endings():
    backend = RetellGatewayBackend(
        settings=RetellGatewaySettings("http://unused.invalid", CALL_ID, TOKEN),
        simulation_id="sim-never-heard",
    )
    media = await backend.create_transport()
    with pytest.raises(MediaBackendError) as missing:
        await backend.wait_answered(0.001)
    assert missing.value.ending == "agent_never_joined"

    class BrokenAudio:
        async def recv(self):
            raise ValueError(f"audio could not decode {TOKEN}")

    input_transport = media.input[0]
    input_transport.ready.set()
    input_transport._sample_rate = 16000
    await backend._read_audio(BrokenAudio())
    assert media.failed.is_set()
    assert TOKEN not in media.fault()
    with pytest.raises(MediaBackendError) as broken:
        await backend.wait_answered(1)
    assert broken.value.ending == "error"
    await backend.teardown()


@pytest.mark.parametrize("body", [b"not-json", b"[]", b"x" * (128 * 1024 + 1)])
async def test_gateway_refuses_invalid_or_oversized_session_response(body: bytes):
    app = web.Application()

    async def response(_request: web.Request) -> web.Response:
        return web.Response(body=body)

    app.router.add_post("/session", response)
    async with serving(app) as base_url:
        backend = RetellGatewayBackend(
            settings=RetellGatewaySettings(base_url, CALL_ID, TOKEN),
            simulation_id="sim-invalid-session",
        )
        with pytest.raises(MediaBackendError):
            await backend._request("POST", f"{base_url}/session")
        await backend.teardown()
