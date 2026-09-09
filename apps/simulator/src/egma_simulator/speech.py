"""Pipecat speech processors selected by the claimed persona models.
STT produces agent transcript text; TTS speaks persona output. VAD is an
internal simulator choice. Runtime work never falls back to scripted providers.

The test codec maps each UTF-8 byte to a fixed-duration tone in signed
16-bit little-endian mono PCM. Tones stay below 3 kHz for 8 kHz telephony.
Scripted STT decodes samples, so tests verify the audio path and recording channels.
"""

from __future__ import annotations

import asyncio
import logging
import math
import struct
import sys
import urllib.parse
from array import array
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from functools import cache
from typing import Any

from pipecat.audio.vad.vad_analyzer import VADAnalyzer, VADParams
from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    MetricsFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.metrics.metrics import MetricsData
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.utils.time import time_now_iso8601
from pipecat.utils.tracing.service_decorators import traced_stt

from .config import STT_PROVIDERS, TTS_PROVIDERS, VAD_PROVIDERS
from .provider_keys import ProviderKeyUnavailable, authentication_rejected
from .spec import SelectedModels
from .usage import ProviderUsage, realtime_transcription_usage

logger = logging.getLogger(__name__)

SAMPLE_WIDTH_BYTES = 2
"""16-bit signed little-endian, the one sample format the simulator carries."""

SAMPLES_PER_BYTE = 240
"""How many samples one encoded byte occupies — 30 ms at 8 kHz, 5 ms at 48 kHz."""

SPEECH_LEVEL = 500
"""The sample level, out of 32767, above which audio is somebody talking.

A line is never digitally silent — it carries comfort noise, and a
threshold is what tells that apart from speech. Set low enough to hear a
quiet talker and high enough to ignore a line's own hiss.
"""

TONE_BASE_HZ = 200
TONE_STEP_HZ = 10
TONE_AMPLITUDE = 8000

CARTESIA_SPEED_RANGE = (0.6, 1.5)
"""What the cartesia mouth accepts as a speed multiplier, its own numbers.

A speed outside this range is refused. The adapter never changes the value
selected by the pinned TTS model."""

LISTENING_READY_SECONDS = 15.0
"""How long a listening leg may take to become able to hear.

A streaming transcriber opens its connection in the background and
*silently drops* audio handed to it before that connection is up. The
first thing a voice exchange does is hand it the agent's greeting, so
without this wait the first turn of a real call would vanish."""


@dataclass(frozen=True)
class PersonaVoice:
    """The technical voice owned by the pinned TTS selection."""

    voice_id: str
    provider: str | None
    speed: float | None


def voice_from_models(models: SelectedModels) -> PersonaVoice:
    """Read the technical voice from its one owner."""
    return PersonaVoice(
        voice_id=models.tts.voice_id,
        provider=models.tts.provider,
        speed=models.tts.speed,
    )


# -- The scripted codec ------------------------------------------------------


@cache
def _tones(sample_rate_hz: int) -> tuple[dict[int, bytes], dict[bytes, int]]:
    """The tone for every byte at one band, and the way back.

    A cosine rather than a sine so no tone opens on a zero sample: silence
    is then exactly the samples nobody spoke into, which is what makes the
    leading quiet before an answer measurable.
    """
    forward: dict[int, bytes] = {}
    for value in range(256):
        hertz = TONE_BASE_HZ + value * TONE_STEP_HZ
        forward[value] = b"".join(
            struct.pack(
                "<h",
                int(
                    TONE_AMPLITUDE * math.cos(2 * math.pi * hertz * n / sample_rate_hz)
                ),
            )
            for n in range(SAMPLES_PER_BYTE)
        )
    return forward, {tone: value for value, tone in forward.items()}


def encode_speech(text: str, sample_rate_hz: int) -> bytes:
    """One utterance, spoken: PCM at the band the transport carries."""
    forward, _ = _tones(sample_rate_hz)
    return b"".join(forward[byte] for byte in text.encode())


def silence(seconds: float, sample_rate_hz: int) -> bytes:
    """Quiet of a given length, in the same sample format as speech."""
    samples = int(round(seconds * sample_rate_hz))
    return bytes(max(samples, 0) * SAMPLE_WIDTH_BYTES)


def leading_silence_seconds(pcm: bytes, sample_rate_hz: int) -> float:
    """How long nobody spoke at the start of one stretch of audio."""
    quiet = 0
    for offset in range(0, len(pcm) - 1, SAMPLE_WIDTH_BYTES):
        if pcm[offset] or pcm[offset + 1]:
            break
        quiet += 1
    return quiet / sample_rate_hz


def duration_seconds(pcm: bytes, sample_rate_hz: int) -> float:
    """How long one stretch of audio lasts, from the samples themselves."""
    return len(pcm) / SAMPLE_WIDTH_BYTES / sample_rate_hz


def spoken_seconds(pcm: bytes, sample_rate_hz: int) -> float:
    """How long the speaking part of one stretch of audio lasts.

    The quiet before a speaker starts is measured on its own, as
    time-to-first-word, so the two measures add up to the whole rather
    than counting the same silence twice.
    """
    return duration_seconds(pcm, sample_rate_hz) - leading_silence_seconds(
        pcm, sample_rate_hz
    )


def peak_level(pcm: bytes) -> int:
    """The loudest sample in one stretch of audio.

    PCM is always little-endian and ``array`` holds samples in this
    machine's byte order, so the two agree only on a little-endian
    machine and a swap is what makes them agree anywhere else.
    """
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) // SAMPLE_WIDTH_BYTES * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    return max((abs(sample) for sample in samples), default=0)


def carries_speech(pcm: bytes) -> bool:
    """Whether somebody is talking in this stretch of audio."""
    return peak_level(pcm) >= SPEECH_LEVEL


def decode_speech(pcm: bytes, sample_rate_hz: int) -> str:
    """What was said, read out of the samples and nothing else.

    Alignment is not assumed. An utterance handed straight from the TTS
    starts on a tone boundary, but the same audio inside a recording sits
    after however much quiet the two speakers left between them, so the
    reader slides a sample at a time until a tone lands and then runs
    tone by tone until one does not.
    """
    _, backward = _tones(sample_rate_hz)
    width = SAMPLES_PER_BYTE * SAMPLE_WIDTH_BYTES
    said = bytearray()
    offset = 0
    while offset + width <= len(pcm):
        value = backward.get(pcm[offset : offset + width])
        if value is None:
            offset += SAMPLE_WIDTH_BYTES
            continue
        said.append(value)
        offset += width
    return said.decode("utf-8", errors="replace")


# -- The legs ----------------------------------------------------------------


class ScriptedTTS(FrameProcessor):
    """Deterministic persona speech using the scripted codec and selected voice.
    Use a plain frame processor to avoid Pipecat TTS sentence grouping and its
    NLTK corpus dependency in offline tests. Emit the same pipeline frame types.
    """

    def __init__(self, *, voice: PersonaVoice) -> None:
        super().__init__()
        self.voice = voice
        self.sample_rate_hz = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        # A transcription is a text frame travelling the other way — the
        # agent's words on their way to the persona, never something to
        # speak. The service base class draws the same line.
        if isinstance(frame, StartFrame):
            self.sample_rate_hz = frame.audio_out_sample_rate
        if isinstance(frame, TextFrame) and not isinstance(
            frame, TranscriptionFrame | InterimTranscriptionFrame
        ):
            await self._speak(frame.text)
        await self.push_frame(frame, direction)

    async def _speak(self, text: str) -> None:
        if not text:
            return
        await self.push_frame(TTSStartedFrame())
        await self.push_frame(
            TTSAudioRawFrame(
                audio=encode_speech(text, self.sample_rate_hz),
                sample_rate=self.sample_rate_hz,
                num_channels=1,
            )
        )
        await self.push_frame(TTSStoppedFrame())


class ScriptedSTT(SegmentedSTTService):
    """Decode one complete scripted utterance. The segmented STT base buffers audio
    between VAD boundaries before calling run_stt(), avoiding partial-byte fragments.
    """

    def __init__(self) -> None:
        super().__init__(
            sample_rate=None,
            settings=STTSettings(model=None, language=None),
            ttfs_p99_latency=1.0,
        )

    @property
    def wants_wav_segments(self) -> bool:
        """Raw PCM, not a WAV file: the codec reads samples, not headers."""
        return False

    def can_generate_metrics(self) -> bool:
        return False

    @traced_stt
    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        yield TranscriptionFrame(
            text=decode_speech(audio, self.sample_rate),
            user_id="",
            timestamp=time_now_iso8601(),
        )


class ScriptedVAD(VADAnalyzer):
    """Detect scripted tones using byte-sized windows and exact zero-sample silence.
    Correct the speech and silence confirmation delays back to sample boundaries.
    Live simulations use Silero through build_vad().
    """

    SPEAKING_WINDOWS = 1
    """How many windows of speech confirm that somebody started talking."""

    QUIET_WINDOWS = 4
    """How many windows of silence confirm that they stopped. Long enough
    to sit through a gap between words, short enough that the persona is
    not left waiting on somebody who has finished."""

    def __init__(self) -> None:
        self._window_samples = SAMPLES_PER_BYTE
        super().__init__(
            sample_rate=None,
            params=VADParams(
                confidence=0.5,
                # Loudness is already the whole of this leg's answer, so a
                # second loudness gate could only disagree with it.
                min_volume=0.0,
                start_secs=0.0,
                stop_secs=0.0,
            ),
        )

    def set_sample_rate(self, sample_rate: int) -> None:
        """Learn the input rate from Pipecat's start frame."""
        self.params.start_secs = (
            self.SPEAKING_WINDOWS * self._window_samples / sample_rate
        )
        self.params.stop_secs = self.QUIET_WINDOWS * self._window_samples / sample_rate
        super().set_sample_rate(sample_rate)

    def num_frames_required(self) -> int:
        return self._window_samples

    def voice_confidence(self, buffer: bytes) -> float:
        return 1.0 if carries_speech(buffer) else 0.0


# -- Choosing a pair ---------------------------------------------------------


class SpeechFault(RuntimeError):
    """A speech leg could not be built, or could not be made able to hear.

    Deliberately not a ``PlugError``: that word names a platform refusing,
    and this is the persona's own mouth or ears. Either way the simulation
    is reported failed, and the reason on the record is what tells a
    reader which of the two happened. Voice only, and raised out of the
    voice conductor: the conversation loop has no speech legs to hear one from.
    """


class ProviderUsageMetricsData(MetricsData):
    """What one provider request cost, on Pipecat's own metrics bus.

    Pipecat already carries client-measured usage — seconds of audio sent,
    characters handed over — and one collector at the end of the pipeline sees
    every one of them. Where Egma holds the provider's *own* numbers instead,
    they have to reach that same collector or they would need a second path
    with a second set of ordering problems. So they ride the bus as one more
    kind of metrics datum, and the collector reads all of them the same way.
    """

    usage: ProviderUsage


@dataclass(frozen=True)
class SpeechProviders:
    """The speech adapters resolved from one pinned persona version."""

    stt: str = "scripted"
    tts: str = "scripted"
    vad: str = "scripted"
    """Which leg hears *whether* the far end is speaking. ``scripted``
    reads the test codec exactly and needs no model; ``silero`` is the
    production detector, and it ships inside the pinned pipecat wheel, so
    choosing it downloads nothing."""

    stt_key: str | None = field(default=None, repr=False)
    tts_key: str | None = field(default=None, repr=False)
    """The direct credential for each selected leg."""

    stt_model: str | None = None
    tts_model: str | None = None
    """The exact pinned models. Runtime code supplies no default."""

    stt_customer_funded: bool = False
    tts_customer_funded: bool = False

    use_environment_proxy: bool = False
    """Whether provider sockets must honor the runtime's proxy settings."""

    stt_provider: str | None = None
    tts_provider: str | None = None
    """Who bills for each leg.

    The adapter above says which protocol is spoken; this says whose account
    the request lands on, and a usage record needs both — one model name can be
    reached over two protocols, and one protocol serves more than one provider.
    """

    @classmethod
    def from_models(cls, models: SelectedModels, *, vad: str) -> SpeechProviders:
        """Resolve the direct adapters from the required models block.

        The catalog already resolved provider/model into one implementation.
        This boundary reads that decision; it does not infer an endpoint from
        the provider name.
        """
        return cls(
            stt=models.stt.adapter,
            tts=models.tts.adapter,
            vad=vad,
            stt_key=models.stt.key,
            tts_key=models.tts.key,
            stt_model=models.stt.model,
            tts_model=models.tts.model,
            stt_provider=models.stt.provider,
            stt_customer_funded=models.stt.funding_receipt is not None,
            tts_customer_funded=models.tts.funding_receipt is not None,
            tts_provider=models.tts.provider,
        )

    def checked(self) -> SpeechProviders:
        """Reject unknown providers when building speech services.
        Scripted providers are explicit unit-test inputs, never runtime fallbacks.
        Chat does not build speech services and does not use this validation.
        """
        for owner, setting, chosen, allowed in (
            ("persona", "STT selection", self.stt, STT_PROVIDERS),
            ("persona", "TTS selection", self.tts, TTS_PROVIDERS),
            ("deployment", "VAD adapter", self.vad, VAD_PROVIDERS),
        ):
            if chosen not in allowed:
                raise SpeechFault(
                    f"the {owner}'s {setting} is {chosen!r}, which is not a "
                    "speech leg this simulator has; it speaks and listens "
                    f"with {', '.join(allowed)}"
                )
        return self


SCRIPTED_PAIR = SpeechProviders()
"""The deterministic pair used only by direct unit-test assembly."""


@dataclass
class SpeechLegs:
    """One simulation's mouth and ears, and how to finish with them."""

    stt: FrameProcessor
    tts: FrameProcessor

    voice: PersonaVoice
    """The exact voice pinned by this work order's TTS selection."""

    listening: Callable[[], Awaitable[None]] | None = None
    """Waits until the listening leg can hear, for a leg that connects."""

    closers: tuple[Callable[[], Awaitable[None]], ...] = ()
    """What a leg holds open beyond the pipeline's own teardown."""

    async def ready(self) -> None:
        """Block until a turn handed to these legs would really be carried."""
        if self.listening is None:
            return
        try:
            await asyncio.wait_for(self.listening(), timeout=LISTENING_READY_SECONDS)
        except TimeoutError as never_ready:
            raise SpeechFault(
                "the listening leg did not connect within "
                f"{LISTENING_READY_SECONDS:.0f}s; nothing said would have been "
                "heard"
            ) from never_ready

    async def aclose(self) -> None:
        """Release whatever the legs hold. Safe from every state, always
        called — a pipeline that was never opened still built its legs."""
        for close in self.closers:
            try:
                await close()
            except Exception:
                logger.exception("a speech leg did not close cleanly")


def build_legs(providers: SpeechProviders, *, voice: PersonaVoice) -> SpeechLegs:
    """The pair this simulation speaks and listens with.

    Building is not connecting: a real leg constructs its client here and
    reaches the provider only once the exchange opens, so assembling a
    pipeline stays the validation step it has always been.
    """
    providers = providers.checked()
    speaking, spoken_with, closers = _mouth(providers, voice)
    listening_leg, listening = _ears(providers)
    return SpeechLegs(
        stt=listening_leg,
        tts=speaking,
        voice=spoken_with,
        listening=listening,
        closers=closers,
    )


CONVERSATION_VAD = VADParams(
    # Pipecat's own default is 0.2, and their documentation is explicit that
    # 0.2 is the value to use **when a turn analyzer is doing the real work**
    # and this is only its fallback. With nothing above it, 0.2 ends a turn at
    # every pause between sentences — a real call proved it, chopping one
    # three-sentence greeting into four turns and handing the floor back after
    # each. Their recommendation for conversation without an analyzer is 0.8,
    # and that is what this is.
    stop_secs=0.8,
    # Both remaining defaults are tuned for a clean headset. Voice-agent
    # connections are often quieter and compressed, so the same thresholds
    # are harsher here than where they were chosen.
    confidence=0.6,
    min_volume=0.3,
    # Left at Pipecat's default. This one says how much speech must arrive
    # before the far end counts as speaking, and 200 ms of real words is a
    # sound threshold on any channel.
    start_secs=0.2,
)
"""How the persona detects speech on a voice-agent connection."""


def build_vad(providers: SpeechProviders) -> VADAnalyzer:
    """The leg this simulation hears speech *starting and stopping* with.

    Chosen at assembly and nowhere else, exactly like the mouth and the
    ears: the scripted detector reads the test codec's samples, so CI's
    every speech boundary is a sample position and the same one every
    run; Silero is what a live simulation listens with, and it is asked
    for by name because loading a model is a cost only a deployment that
    wants it should pay.
    """
    providers = providers.checked()
    if providers.vad != "silero":
        return ScriptedVAD()

    # Imported here and not at the top of the file, for the reason every
    # provider in this module is: an unconfigured simulator must not load
    # a model it will never run. The quarantine suite holds this.
    from pipecat.audio.vad.silero import SileroVADAnalyzer

    detector = SileroVADAnalyzer(params=CONVERSATION_VAD)
    if getattr(detector, "_last_reset_time", None) != 0:
        raise SpeechFault(
            "the pinned pipecat release changed the silero state-reset seam"
        )
    # Pipecat 1.7 resets Silero's recurrent state every five wall-clock
    # seconds. On telephone line noise that can create speech which is not
    # there. A fresh detector is built for every simulation, so its model is
    # already clean at the stream boundary and must keep that state until the
    # simulation ends.
    detector._last_reset_time = math.inf
    return detector


def _mouth(
    providers: SpeechProviders, voice: PersonaVoice
) -> tuple[FrameProcessor, PersonaVoice, tuple[Callable[[], Awaitable[None]], ...]]:
    if providers.tts == "openai":
        return _openai_mouth(providers, voice)
    if providers.tts == "cartesia":
        return _cartesia_mouth(providers, voice)
    if providers.tts == "scripted":
        return ScriptedTTS(voice=voice), voice, ()
    raise SpeechFault(f"no speaking leg for {providers.tts!r}")


def _ears(
    providers: SpeechProviders,
) -> tuple[FrameProcessor, Callable[[], Awaitable[None]] | None]:
    if providers.stt == "openai_realtime":
        return _openai_realtime_ears(providers)
    if providers.stt == "cartesia_manual":
        return _cartesia_ears(providers)
    if providers.stt != "deepgram":
        return ScriptedSTT(), None

    from pipecat.services.deepgram.stt import DeepgramSTTService

    if not providers.stt_key:
        raise SpeechFault("the deepgram listening leg was chosen without a key")
    if not providers.stt_model:
        raise SpeechFault("the deepgram listening leg was chosen without a model")

    if providers.use_environment_proxy:
        # Deepgram's pinned async client still uses the legacy websockets
        # connector, which ignores Daytona's HTTPS_PROXY. A Daytona sandbox
        # runs one claim, so selecting the current connector here is scoped to
        # that dedicated runtime process.
        from deepgram.listen.v1 import client as deepgram_listen_client

        deepgram_listen_client.websockets_client_connect = _daytona_deepgram_connect

    leg = DeepgramSTTService(
        api_key=providers.stt_key,
        settings=DeepgramSTTService.Settings(model=providers.stt_model),
    )

    async def connected() -> None:
        # The service opens its websocket in a background task and drops
        # audio handed to it before that finishes, saying nothing. The
        # flag it sets when the connection can accept audio is the one
        # the service waits on itself when it reconnects. Pipecat 1.7.0,
        # pinned in uv.lock and exercised by the live Deepgram test, has no
        # public readiness seam. A rename must fail loudly here rather than
        # make first turns go missing.
        connection_ready = getattr(leg, "_connection_ready", None)
        if connection_ready is None:
            raise SpeechFault(
                "this pipecat release no longer says when the deepgram leg "
                "is connected; a turn spoken before it is would be lost"
            )
        await connection_ready.wait()

    return leg, connected


def _daytona_deepgram_connect(
    url: str, extra_headers: dict[str, str] | None = None
) -> Any:
    """Open Deepgram through Daytona's proxy with credentials in headers."""
    from websockets.asyncio.client import connect

    return connect(
        url,
        additional_headers=extra_headers,
        proxy=True,
    )


def _connection_opened_by(leg: FrameProcessor) -> asyncio.Event:
    """The public signal shared by websocket services once they accept audio."""
    opened = asyncio.Event()

    @leg.event_handler("on_connected")
    async def _opened(_leg: object) -> None:
        opened.set()

    return opened


def _cartesia_ears(
    providers: SpeechProviders,
) -> tuple[FrameProcessor, Callable[[], Awaitable[None]]]:
    """What the agent said, streamed through Cartesia's stock STT service.

    Pipecat sends Cartesia a ``finalize`` command when Egma's local VAD emits
    ``VADUserStoppedSpeakingFrame``. This keeps the transcript and Egma's turn
    timing on the same boundary instead of asking Cartesia to decide when the
    agent stopped talking.
    """
    from pipecat.services.cartesia.stt import CartesiaSTTService

    if not providers.stt_key:
        raise SpeechFault("the cartesia_manual listening leg was chosen without a key")
    if not providers.stt_model:
        raise SpeechFault(
            "the cartesia_manual listening leg was chosen without a model"
        )

    leg = CartesiaSTTService(
        api_key=providers.stt_key,
        settings=CartesiaSTTService.Settings(model=providers.stt_model),
    )
    opened = _connection_opened_by(leg)

    async def connected() -> None:
        # Cartesia needs no separate session-configuration message. Its public
        # event fires only after the websocket is open and can accept audio.
        await opened.wait()

    return leg, connected


def _cartesia_mouth(
    providers: SpeechProviders, voice: PersonaVoice
) -> tuple[FrameProcessor, PersonaVoice, tuple[Callable[[], Awaitable[None]], ...]]:
    """The persona's voice through Pipecat's stock Cartesia service.

    It is asked for raw 16-bit signed little-endian mono. Pipecat gives it
    the output rate from the start frame and the transport owns conversion.

    The voice and speed are the pinned TTS selection's own. This adapter
    neither substitutes nor clamps them.
    """
    from pipecat.services.cartesia.tts import (
        CartesiaTTSService as StockCartesiaTTSService,
    )
    from pipecat.services.cartesia.tts import GenerationConfig
    from pipecat.services.tts_service import TextAggregationMode

    class CartesiaTTSService(StockCartesiaTTSService):
        async def _websocket_connect(self, uri: str, **kwargs: Any):
            parsed = urllib.parse.urlsplit(uri)
            query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            safe_uri = urllib.parse.urlunsplit(
                parsed._replace(
                    query=urllib.parse.urlencode(
                        [(name, value) for name, value in query if name != "api_key"]
                    )
                )
            )
            headers = dict(kwargs.pop("additional_headers", {}) or {})
            headers["X-API-Key"] = self._api_key
            return await super()._websocket_connect(
                safe_uri,
                additional_headers=headers,
                **kwargs,
            )

    if not providers.tts_key:
        raise SpeechFault("the cartesia speaking leg was chosen without a key")
    if not providers.tts_model:
        raise SpeechFault("the cartesia speaking leg was chosen without a model")
    if voice.provider != "cartesia":
        raise SpeechFault("the cartesia speaking leg received a non-cartesia voice")
    if voice.speed is None or not (
        CARTESIA_SPEED_RANGE[0] <= voice.speed <= CARTESIA_SPEED_RANGE[1]
    ):
        raise SpeechFault(
            "the cartesia speaking leg received a speed outside its supported "
            f"range {CARTESIA_SPEED_RANGE[0]}–{CARTESIA_SPEED_RANGE[1]}"
        )
    spoken_with = voice
    settings = CartesiaTTSService.Settings(
        model=providers.tts_model,
        voice=spoken_with.voice_id,
    )
    settings.generation_config = GenerationConfig(speed=spoken_with.speed)

    leg = CartesiaTTSService(
        api_key=providers.tts_key,
        encoding="pcm_s16le",
        container="raw",
        settings=settings,
        # One persona turn is one whole thing to say, so it goes over in
        # one piece rather than a sentence at a time: the default waits for
        # sentence-ending punctuation and adds that wait to
        # every sentence of every turn.
        text_aggregation_mode=TextAggregationMode.TOKEN,
    )
    return leg, spoken_with, ()


# -- The OpenAI pair ----------------------------------------------------------


def _openai_mouth(
    providers: SpeechProviders, voice: PersonaVoice
) -> tuple[FrameProcessor, PersonaVoice, tuple[Callable[[], Awaitable[None]], ...]]:
    """The persona's voice through Pipecat's stock OpenAI service."""
    from pipecat.services.openai.tts import OpenAITTSService as StockOpenAITTSService

    class OpenAITTSService(StockOpenAITTSService):
        async def run_tts(
            self, text: str, context_id: str
        ) -> AsyncGenerator[Frame, None]:
            from pipecat.frames.frames import ErrorFrame

            spoke = False
            try:
                async for frame in super().run_tts(text, context_id):
                    if isinstance(frame, ErrorFrame):
                        yield frame
                        await self.remove_audio_context(context_id)
                        return
                    spoke = spoke or isinstance(frame, TTSAudioRawFrame)
                    yield frame
            except asyncio.CancelledError:
                await self.remove_audio_context(context_id)
                raise
            except Exception as fault:
                if providers.tts_customer_funded and authentication_rejected(fault):
                    failure = ProviderKeyUnavailable("openai")
                    yield ErrorFrame(error=str(failure), exception=fault)
                    await self.remove_audio_context(context_id)
                    return
                else:
                    await self.remove_audio_context(context_id)
                    raise
            if not spoke:
                await self.remove_audio_context(context_id)
                raise SpeechFault("the openai speaking leg returned no audio")

    if not providers.tts_key:
        raise SpeechFault("the openai speaking leg was chosen without a key")
    if not providers.tts_model:
        raise SpeechFault("the openai speaking leg was chosen without a model")
    if voice.provider != "openai":
        raise SpeechFault("the openai speaking leg received a non-openai voice")
    spoken_with = voice
    settings = OpenAITTSService.Settings(
        model=providers.tts_model, voice=spoken_with.voice_id
    )
    if spoken_with.speed is not None:
        settings.speed = spoken_with.speed
    leg = OpenAITTSService(
        api_key=providers.tts_key,
        settings=settings,
        # OpenAI returns finite HTTP streams. Pipecat closes the turn after they
        # finish; an idle timer can stop it while a response is still in flight.
        stop_frame_timeout_s=None,
    )
    return leg, spoken_with, ()


def _openai_realtime_ears(
    providers: SpeechProviders,
) -> tuple[FrameProcessor, Callable[[], Awaitable[None]] | None]:
    """Streaming OpenAI transcription using local VAD boundaries from _AgentEar.
    The same boundaries drive transcript commits and recorded timing.
    The stock service converts audio to its required rate. For gpt-live-transcribe,
    replace Pipecat 1.7's singular language field with the required languages field.
    """
    from pipecat.services.openai._constants import OPENAI_SAMPLE_RATE
    from pipecat.services.openai.stt import (
        OpenAIRealtimeSTTService as PipecatOpenAIRealtimeSTTService,
    )

    class OpenAIRealtimeSTTService(PipecatOpenAIRealtimeSTTService):
        """Pipecat's realtime service with the live model's current wire shape."""

        async def _handle_transcription_completed(self, evt: dict) -> None:
            """Keep what the provider says the transcription cost.

            The completed event is the only place OpenAI states it, and Pipecat
            reads the transcript out of that event and drops the rest. Two
            shapes arrive — seconds of committed audio, or audio and text
            tokens — and which one a model uses is said on the event itself, so
            both are read rather than assumed.

            Pushed before ``super()``, so the bill is on the bus ahead of the
            transcription frame the turn is built from — the same ordering
            Pipecat's own usage report has, and the one that puts the record
            ahead of the terminal report.
            """
            usage = realtime_transcription_usage(
                evt, selection_model=self._settings.model
            )
            if usage is not None:
                await self.push_frame(
                    MetricsFrame(
                        data=[
                            ProviderUsageMetricsData(
                                processor=self.name,
                                model=self._settings.model,
                                usage=usage,
                            )
                        ]
                    )
                )
            await super()._handle_transcription_completed(evt)

        async def emit_stt_usage_metrics(self) -> None:
            """Say nothing about the seconds Egma sent.

            Pipecat counts the audio submitted to a listening leg and reports
            it, which is the right answer for a provider that says nothing.
            This one says something: the completed event carries the figure
            OpenAI actually bills, and it is read above. Reporting Egma's own
            count beside it would put two numbers for one request on the bus,
            and whichever the platform used, one of them would be wrong.
            """
            return None

        async def _send_session_update(self) -> None:
            if self._settings.model != "gpt-live-transcribe":
                await super()._send_session_update()
                return

            transcription: dict[str, object] = {
                "model": self._settings.model,
                # Egma does not yet carry persona language into speech legs.
                # Preserve the existing English behavior in the field this
                # model accepts. Language capability is separate catalog work.
                "languages": ["en"],
            }
            if self._settings.prompt:
                transcription["prompt"] = self._settings.prompt

            audio_input: dict[str, object] = {
                "format": {"type": "audio/pcm", "rate": OPENAI_SAMPLE_RATE},
                "transcription": transcription,
            }
            if self._turn_detection is False:
                audio_input["turn_detection"] = None
            elif self._turn_detection is not None:
                audio_input["turn_detection"] = self._turn_detection
            if self._settings.noise_reduction:
                audio_input["noise_reduction"] = {
                    "type": self._settings.noise_reduction
                }

            await self._ws_send(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {"input": audio_input},
                    },
                }
            )

    if not providers.stt_key:
        raise SpeechFault("the openai_realtime listening leg was chosen without a key")
    if not providers.stt_model:
        raise SpeechFault(
            "the openai_realtime listening leg was chosen without a model"
        )

    leg = OpenAIRealtimeSTTService(
        api_key=providers.stt_key,
        # False is this service's word for "the detector is in the
        # pipeline, not on the server". Named rather than left to the
        # default, because a release changing it would move where a turn
        # ends without moving anything in this repository.
        turn_detection=False,
        settings=OpenAIRealtimeSTTService.Settings(model=providers.stt_model),
    )

    opened = _connection_opened_by(leg)

    async def connected() -> None:
        # Wait for both socket connection and configured transcription session before
        # audio.
        # Pipecat 1.7.0 exposes the second state only through a private flag; a renamed
        # flag must fail visibly rather than lose the agent's greeting.
        await opened.wait()
        if not hasattr(leg, "_session_ready"):
            raise SpeechFault(
                "this pipecat release no longer says when the openai "
                "realtime leg's transcription session is ready; a turn "
                "spoken before it is would be lost"
            )
        # Polled rather than awaited, and the linter is right that an event
        # would be better: the service registers `on_connected`,
        # `on_disconnected` and `on_connection_error`, and none of them
        # fires when the transcription session becomes configured. A flag
        # is all this release offers, so a flag is what this reads. The
        # caller bounds the whole wait — see LISTENING_READY_SECONDS — so a
        # session that never becomes ready is a refusal rather than a hang.
        while not leg._session_ready:  # noqa: ASYNC110
            await asyncio.sleep(0.05)

    return leg, connected
