"""Retell v3 gateway audio over WebRTC and its HTTP session API.

Pipecat owns conversion, background mixing, and output buffering. aiortc
gathers ICE candidates into the offer before the one-time session request.
Provider status confirms normal remote endings; lost media remains an error.
"""

from __future__ import annotations

import asyncio
import contextlib
import fractions
import json
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import aiohttp
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.mediastreams import AudioStreamTrack, MediaStreamError
from av import AudioFrame, AudioResampler
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from ..contract import AGENT_NEVER_JOINED
from ..platform_logging import log_event
from ..redaction import SecretRegistry
from . import (
    MediaBackendError,
    PlayoutClearAcknowledger,
    PlayoutStamp,
    RemoteParticipantLeftFrame,
    VoiceMedia,
    arrived_now,
    first_of,
)

logger = logging.getLogger(__name__)
CONNECT_SECONDS = 30.0
HTTP_RESPONSE_BYTES = 128 * 1024
FINAL_AUDIO_SECONDS = 2.0
FINAL_AUDIO_GRACE_SECONDS = 0.2
MAX_AUDIO_CATCHUP_SECONDS = 0.1
DEFAULT_ICE_SERVERS = [{"urls": "stun:stun.l.google.com:19302"}]


@dataclass(frozen=True)
class RetellGatewaySettings:
    base_url: str
    call_id: str
    access_token: str = field(repr=False)
    ice_servers: list[dict[str, Any]] = field(default_factory=list, repr=False)
    secrets: tuple[str, ...] = field(default=(), repr=False)


class _GatewayAudioTrack(AudioStreamTrack):
    """Pace mono PCM in 20 ms packets, with silence between persona turns."""

    def __init__(self, sample_rate: int) -> None:
        super().__init__()
        self._sample_rate = sample_rate
        self._samples = sample_rate // 50
        self._bytes = self._samples * 2
        self._pending: deque[tuple[bytes, asyncio.Future[bool] | None]] = deque()
        self._timestamp = 0
        self._next_at: float | None = None

    async def write(self, audio: bytes) -> bool:
        if self.readyState != "live":
            return False
        if not audio or len(audio) % self._bytes:
            raise MediaBackendError("Retell output audio is not a whole 20 ms packet")
        played = asyncio.get_running_loop().create_future()
        for offset in range(0, len(audio), self._bytes):
            last = offset + self._bytes == len(audio)
            self._pending.append(
                (audio[offset : offset + self._bytes], played if last else None)
            )
        return await played

    def clear(self) -> None:
        while self._pending:
            _audio, played = self._pending.popleft()
            if played is not None and not played.done():
                played.set_result(False)

    def stop(self) -> None:
        self.clear()
        super().stop()

    async def recv(self) -> AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError
        now = time.monotonic()
        if self._next_at is None:
            self._next_at = now
        if self._next_at > now:
            await asyncio.sleep(self._next_at - now)
        now = time.monotonic()
        # Keep packet deadlines anchored despite normal scheduler overshoot.
        # After a long stall, resume pacing without a burst of overdue packets.
        if now - self._next_at > MAX_AUDIO_CATCHUP_SECONDS:
            self._next_at = now
        self._next_at += 0.02
        if self.readyState != "live":
            raise MediaStreamError
        if self._pending:
            audio, played = self._pending.popleft()
            if played is not None and not played.done():
                played.set_result(True)
        else:
            audio = bytes(self._bytes)
        frame = AudioFrame(format="s16", layout="mono", samples=self._samples)
        frame.planes[0].update(audio)
        frame.sample_rate = self._sample_rate
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        self._timestamp += self._samples
        return frame


class _GatewayInput(BaseInputTransport):
    def __init__(self, backend: RetellGatewayBackend, params: TransportParams) -> None:
        super().__init__(params)
        self._backend = backend
        self.ready = asyncio.Event()

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)
        self.ready.set()

    async def drain(self) -> None:
        # Pipecat 1.9 acknowledges input only after its downstream push.
        await self._audio_in_queue.join()

    async def cancel(self, frame: CancelFrame) -> None:
        await self._backend.teardown()
        await super().cancel(frame)

    async def cleanup(self) -> None:
        await self._backend.teardown()
        await super().cleanup()


class _GatewayOutput(BaseOutputTransport):
    def __init__(self, backend: RetellGatewayBackend, params: TransportParams) -> None:
        super().__init__(params)
        self._backend = backend

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._backend.teardown()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, (InterruptionFrame, CancelFrame)):
            self._backend._outbound.clear()

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        try:
            return await self._backend._outbound.write(frame.audio)
        except asyncio.CancelledError:
            raise
        except Exception as fault:
            self._backend._fail("Retell outbound audio failed", fault)
            return False


class RetellGatewayBackend:
    """One gateway session, with pipeline-owned audio and bounded cleanup."""

    def __init__(
        self,
        *,
        settings: RetellGatewaySettings,
        simulation_id: str,
        confirm_remote_end: Callable[[], Awaitable[bool]] | None = None,
        poll_remote_end: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        self._settings = settings
        self._simulation_id = simulation_id
        self._confirm_remote_end = confirm_remote_end
        self._poll_remote_end = poll_remote_end or confirm_remote_end
        self._secrets = SecretRegistry()
        self._secrets.register([settings.access_token, *settings.secrets])
        for server in settings.ice_servers:
            self._secrets.register([server.get("username"), server.get("credential")])
        self._session_url = (
            f"{settings.base_url.rstrip('/')}/webrtc-proxy/"
            f"{quote(settings.call_id, safe='')}/v1/webrtc/sessions"
        )
        self._session_id: str | None = None
        self._peer: RTCPeerConnection | None = None
        self._input: _GatewayInput | None = None
        self._reader: asyncio.Task[None] | None = None
        self._monitor: asyncio.Task[None] | None = None
        self._remote_close: asyncio.Task[None] | None = None
        self._cleanup_task: asyncio.Task[None] | None = None
        self._remote_track: Any = None
        self._outbound = _GatewayAudioTrack(24_000)
        self._connected = asyncio.Event()
        self._audio = asyncio.Event()
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self._fault: str | None = None
        self._closing = False
        self._dialed = False

    def _event(self, name: str, text: str, **attributes: object) -> None:
        log_event(
            logger,
            logging.INFO,
            f"egma.retell.gateway.{name}",
            text,
            attributes={
                "simulation.id": self._simulation_id,
                "retell.call_id": self._settings.call_id,
                **attributes,
            },
        )

    def _fail(self, text: str, error: Exception | None = None) -> None:
        if self._closing or self.failed.is_set():
            return
        detail = "" if error is None else f": {self._secrets.redact(str(error))[:200]}"
        self._fault = text + detail
        self.failed.set()
        self._event("failed", text)

    async def create_transport(self, *, audio_out_mixer: object = None) -> VoiceMedia:
        if self._input is not None:
            raise MediaBackendError("a Retell gateway transport is created once")
        params = TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_out_sample_rate=24_000,
            audio_out_10ms_chunks=2,
            audio_out_end_silence_secs=0,
            audio_out_mixer=audio_out_mixer,
        )
        self._input = _GatewayInput(self, params)
        return VoiceMedia(
            input=(self._input,),
            output=(
                PlayoutClearAcknowledger(),
                _GatewayOutput(self, params),
                PlayoutStamp(wait_for_playout=True, acknowledged_clears=True),
            ),
            ended=self.ended,
            failed=self.failed,
            transport_name="Retell gateway WebRTC",
            fault=lambda: self._fault,
        )

    async def dial(self) -> None:
        if self._input is None:
            raise MediaBackendError("Retell gateway was opened before its transport")
        if self._dialed or self._closing:
            raise MediaBackendError("a Retell gateway access token is used once")
        self._dialed = True
        try:
            async with asyncio.timeout(CONNECT_SECONDS):
                servers = [
                    RTCIceServer(**server)
                    for server in (self._settings.ice_servers or DEFAULT_ICE_SERVERS)
                ]
                peer = RTCPeerConnection(RTCConfiguration(iceServers=servers))
                self._peer = peer
                peer.addTrack(self._outbound)
                peer.createDataChannel("control")

                @peer.on("track")
                def remote_track(track: Any) -> None:
                    if track.kind == "audio" and self._remote_track is None:
                        self._remote_track = track
                        self._reader = asyncio.create_task(
                            self._read_audio(track), name="retell-gateway-audio"
                        )

                @peer.on("connectionstatechange")
                def state_changed() -> None:
                    if peer.connectionState == "connected":
                        self._connected.set()
                    elif peer.connectionState in {"failed", "closed"}:
                        self._begin_remote_close()

                await peer.setLocalDescription(await peer.createOffer())
                assert peer.localDescription is not None
                document = await self._request(
                    "POST",
                    self._session_url,
                    document={"identity": "client", "sdp": peer.localDescription.sdp},
                )
                session_id = document.get("session_id")
                if isinstance(session_id, str) and session_id:
                    self._session_id = session_id
                else:
                    raise MediaBackendError("Retell gateway answered no session_id")
                sdp = document.get("sdp")
                if not isinstance(sdp, str) or not sdp:
                    raise MediaBackendError("Retell gateway answered no SDP")
                await peer.setRemoteDescription(RTCSessionDescription(sdp, "answer"))
                self._event("session_created", "Retell gateway session created")
                if not await first_of(self._connected, self.failed, within=None):
                    raise MediaBackendError("Retell gateway did not connect")
                if self.failed.is_set():
                    raise MediaBackendError(
                        self._fault or "Retell gateway did not connect"
                    )
                self._event("connected", "Retell gateway media connected")
                if self._poll_remote_end is not None:
                    self._monitor = asyncio.create_task(
                        self._monitor_end(), name="retell-gateway-status"
                    )
        except asyncio.CancelledError:
            raise
        except Exception as fault:
            self._fail("Retell gateway connection failed", fault)
            raise MediaBackendError(
                self._fault or "Retell gateway connection failed"
            ) from fault

    async def wait_answered(self, seconds: float) -> str:
        await first_of(self._audio, self.ended, self.failed, within=seconds)
        if self.failed.is_set():
            raise MediaBackendError(self._fault or "Retell gateway media failed")
        if not self._audio.is_set():
            raise MediaBackendError(
                "Retell's agent sent no audio before the join timeout",
                ending=AGENT_NEVER_JOINED,
            )
        return "Retell agent"

    async def _request(
        self, method: str, url: str, *, document: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10.0)) as session,
            session.request(
                method,
                url,
                json=document,
                headers={"Authorization": f"Bearer {self._settings.access_token}"},
            ) as response,
        ):
            raw = bytearray()
            async for chunk in response.content.iter_chunked(4096):
                raw.extend(chunk)
                if len(raw) > HTTP_RESPONSE_BYTES:
                    raise MediaBackendError("Retell gateway response exceeded 128 KiB")
            if response.status // 100 != 2:
                text = self._secrets.redact(raw.decode(errors="replace"))[:200]
                raise MediaBackendError(
                    f"Retell gateway {method} answered {response.status}: {text}"
                )
            if method == "DELETE":
                return {}
            try:
                value = json.loads(raw)
            except ValueError as unreadable:
                raise MediaBackendError(
                    "Retell gateway answered invalid JSON"
                ) from unreadable
            if not isinstance(value, dict):
                raise MediaBackendError("Retell gateway answered no JSON object")
            return value

    async def _read_audio(self, track: Any) -> None:
        input_transport = self._input
        assert input_transport is not None
        try:
            await input_transport.ready.wait()
            resampler = AudioResampler("s16", "mono", input_transport.sample_rate)
            while not self._closing:
                received = await track.recv()
                for decoded in resampler.resample(received):
                    frame = InputAudioRawFrame(
                        audio=decoded.to_ndarray().tobytes(),
                        sample_rate=input_transport.sample_rate,
                        num_channels=1,
                    )
                    arrived_now(frame)
                    await input_transport.push_audio_frame(frame)
                    if not self._audio.is_set():
                        self._event("first_audio", "Retell agent audio received")
                        self._audio.set()
        except asyncio.CancelledError:
            raise
        except MediaStreamError:
            self._begin_remote_close()
        except Exception as fault:
            self._fail("Retell inbound audio failed", fault)

    def _begin_remote_close(self, *, confirmed: bool = False) -> None:
        if not self._closing and self._remote_close is None:
            self._remote_close = asyncio.create_task(
                self._finish_remote_close(confirmed=confirmed),
                name="retell-gateway-remote-close",
            )

    async def _monitor_end(self) -> None:
        assert self._poll_remote_end is not None
        while (
            not self._closing and not self.failed.is_set() and not self.ended.is_set()
        ):
            await asyncio.sleep(2.0)
            try:
                ended = await self._poll_remote_end()
            except MediaBackendError as fault:
                self._fail("Retell call status failed", fault)
                return
            except Exception:
                ended = False
            if ended:
                self._begin_remote_close(confirmed=True)
                return

    async def _finish_remote_close(self, *, confirmed: bool = False) -> None:
        try:
            if not confirmed:
                confirmed = (
                    self._audio.is_set()
                    and self._confirm_remote_end is not None
                    and await self._confirm_remote_end()
                )
            if self._closing or self.failed.is_set():
                return
            if not confirmed:
                self._fail("Retell gateway media ended without a normal call ending")
                return
            # The gateway can keep sending silence after the call ended.
            # Give final RTP audio time to arrive without waiting for silence to stop.
            await asyncio.sleep(FINAL_AUDIO_GRACE_SECONDS)
            if self._reader is not None and not self._reader.done():
                self._reader.cancel()
                await asyncio.gather(self._reader, return_exceptions=True)
            input_transport = self._input
            assert input_transport is not None
            async with asyncio.timeout(FINAL_AUDIO_SECONDS):
                await input_transport.drain()
                completed = asyncio.Event()
                await input_transport.push_frame(RemoteParticipantLeftFrame(completed))
                await completed.wait()
            if not self._closing and not self.failed.is_set():
                self.ended.set()
                self._event("remote_ended", "Retell call ended normally")
        except asyncio.CancelledError:
            raise
        except Exception as fault:
            self._fail("Retell final audio could not be drained", fault)

    async def teardown(self) -> None:
        if self._cleanup_task is None:
            self._closing = True
            self._cleanup_task = asyncio.create_task(
                self._cleanup(), name="retell-gateway-cleanup"
            )
        await asyncio.shield(self._cleanup_task)

    async def _cleanup(self) -> None:
        for task in (self._monitor, self._remote_close, self._reader):
            if (
                task is not None
                and task is not asyncio.current_task()
                and not task.done()
            ):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self._outbound.stop()
        peer, self._peer = self._peer, None
        if peer is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(3.0):
                    await peer.close()
        session_id, self._session_id = self._session_id, None
        if session_id is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(3.0):
                    await self._request(
                        "DELETE", f"{self._session_url}/{quote(session_id, safe='')}"
                    )
        self._event("closed", "Retell gateway session closed")
