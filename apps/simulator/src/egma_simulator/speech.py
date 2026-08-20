"""The speech legs: words into sound, and sound back into words.

A voice simulation is a chat simulation with two more legs. The persona
brain still writes the words — it never learns that they are spoken — and
these are what carry them: a text-to-speech leg giving the persona a
voice, and a speech-to-text leg turning what comes back into the
transcript's ``agent`` turns. A third leg listens for *whether* anybody is
speaking rather than for words — the voice activity detector. It is an
internal simulator choice, not authored persona data.

Both legs are ordinary Pipecat frame processors, in the two places a
real provider's service sits — Cartesia or OpenAI speaking, and Deepgram
or OpenAI Realtime listening —
so the pipeline assembled around them is the same pipeline either way.
The listening leg goes further and is a Pipecat STT service, the very
class a real one subclasses; the speaking leg deliberately is not, and
:class:`ScriptedTTS` says why.

**Which pair is used comes only from the claimed models block.** The
scripted pair is an explicit unit-test injection. Runtime work orders never
fall back to it or combine it with one selected provider leg.

**The scripted codec.** Scripted speech is real PCM — 16-bit signed
little-endian mono, at whatever band the transport carries — and it is
exactly invertible: each UTF-8 byte of the text becomes one fixed-length
tone whose frequency names the byte. The STT reads nothing but the samples
handed to it, so the loopback proves the whole audio path rather than
smuggling the text past it, and a recording of the exchange can be read
back the same way — which is how a test tells which speaker is on which
channel.

The tones stay under 3 kHz so that the narrowest band a connection can
carry, 8 kHz telephony, still holds them.
"""

from __future__ import annotations

import asyncio
import logging
import math
import struct
import sys
from array import array
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from functools import cache

from pipecat.audio.vad.vad_analyzer import VADAnalyzer, VADParams
from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    StartFrame,
    TextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.utils.time import time_now_iso8601
from pipecat.utils.tracing.service_decorators import traced_stt

from .config import STT_PROVIDERS, TTS_PROVIDERS, VAD_PROVIDERS
from .spec import SelectedModels

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
    """The persona's voice, deterministically.

    Holds the voice the persona was authored with the way a real service
    holds a provider voice id — the exchange is what proves the leg was
    assembled from this simulation's own spec.

    **Why this one is not built on Pipecat's TTS service, when the
    listening leg is built on Pipecat's STT service.** That base class
    regroups whatever it is given back into sentences, and it does the
    grouping with NLTK, whose corpus is fetched from the internet the
    first time it is wanted. On a machine without that corpus the
    grouping raises, the turn's audio is dropped, and the recording
    quietly loses a persona turn while the transcript still shows it —
    found by starving a run of the corpus and reading the channels back.
    There is no way to hand that base class a different grouper.

    So this leg is a plain frame processor emitting exactly the frames the
    base class emits, in the same place in the chain. A real provider is
    still an ordinary Pipecat TTS service dropped into that same place —
    what it is not is *this* leg's base class, and CI needs no corpus and
    no network to speak.
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
    """What the agent said, read back out of the audio it arrived as.

    Segmented rather than streaming, because that is what this leg
    honestly is: it reads a whole stretch of speech at once. A full-duplex
    line hands its pipeline one small slice of audio at a time and never a
    turn, so a leg that transcribed each slice on its own would read every
    utterance as a string of fragments. The base class here is the one a
    local model subclasses: it buffers between the voice detector's start
    and stop and calls :meth:`run_stt` once with the whole utterance.
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
    """Hears the scripted codec exactly, and nothing else.

    A voice activity detector answers one question — is somebody speaking
    in this window of audio — and the scripted codec answers it without a
    model: a tone is loud and quiet is exactly zero samples. So this leg
    reads the samples and says so, which makes every speech boundary it
    reports a sample position rather than a probability.

    That exactness is what the record rests on. A window is one encoded
    byte wide, so a scripted utterance begins and ends on a window
    boundary at every band; the detector confirms speech one window in and
    silence :data:`QUIET_WINDOWS` windows later, and both are corrected
    back by exactly those windows — so the interval it hands over is the
    interval that was really spoken, to the sample.

    Silero is the leg a live simulation hears with; see :func:`build_vad`.
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
    voice conductor: the walk has no speech legs to hear one from.
    """


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

    @classmethod
    def from_models(cls, models: SelectedModels, *, vad: str) -> SpeechProviders:
        """Resolve the direct adapters from the required models block.

        OpenAI STT means its realtime socket. The segmented transcription
        endpoint is not a second interpretation of the same selection.
        """
        stt = "openai_realtime" if models.stt.provider == "openai" else "deepgram"
        return cls(
            stt=stt,
            tts=models.tts.provider,
            vad=vad,
            stt_key=models.stt.key,
            tts_key=models.tts.key,
            stt_model=models.stt.model,
            tts_model=models.tts.model,
        )

    def checked(self) -> SpeechProviders:
        """These legs, or the refusal an unrecognised provider earns.

        **Refused rather than quietly downgraded to the stand-in.** Every
        builder below accepts the scripted leg only for direct unit tests.
        A misspelled runtime provider must not turn into a canned robot: a
        typo on a settings page would otherwise produce a completed, green
        simulation conducted by a canned robot, which is worse than a
        failure because a failure tells the truth about what happened.

        Runtime speech names come from the validated work order. The
        additional scripted name exists only for explicit unit-test injection.

        Called where the legs are *built*, not where they are resolved: a
        chat simulation has no mouth and no ears, and must not fail over a
        speech provider it was never going to use.
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
    if providers.stt != "deepgram":
        return ScriptedSTT(), None

    from pipecat.services.deepgram.stt import DeepgramSTTService

    if not providers.stt_key:
        raise SpeechFault("the deepgram listening leg was chosen without a key")
    if not providers.stt_model:
        raise SpeechFault("the deepgram listening leg was chosen without a model")

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


def _cartesia_mouth(
    providers: SpeechProviders, voice: PersonaVoice
) -> tuple[FrameProcessor, PersonaVoice, tuple[Callable[[], Awaitable[None]], ...]]:
    """The persona's voice through Pipecat's stock Cartesia service.

    It is asked for raw 16-bit signed little-endian mono. Pipecat gives it
    the output rate from the start frame and the transport owns conversion.

    The voice and speed are the pinned TTS selection's own. This adapter
    neither substitutes nor clamps them.
    """
    from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
    from pipecat.services.tts_service import TextAggregationMode

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
    from pipecat.services.openai.tts import OpenAITTSService

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
    )
    return leg, spoken_with, ()


def _openai_realtime_ears(
    providers: SpeechProviders,
) -> tuple[FrameProcessor, Callable[[], Awaitable[None]] | None]:
    """What the agent said, transcribed while they are still saying it.

    This is the only OpenAI STT adapter in this release. It holds a socket
    open and transcribes as audio arrives. The segmented transcription
    endpoint is not another interpretation of the same model selection.

    **Turn boundaries stay egma's, not the provider's.** The service is
    built in its local-VAD mode, so the detector that decides where a turn
    ended is the same :class:`~egma_simulator.conductor._AgentEar` that
    stamps the record's sample positions — one reading of the line, used
    for both. Server-side detection would be a second opinion arriving on
    a different clock, and the transcript and the timings would then
    disagree about when the agent stopped talking. The ear sits directly
    in front of this leg in the pipeline and pushes the frame it commits
    on, so the two are wired together by the assembly order.

    The stock service owns the rate its socket requires and converts the
    pipeline audio itself.
    """
    from pipecat.services.openai.stt import OpenAIRealtimeSTTService

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

    opened = asyncio.Event()

    @leg.event_handler("on_connected")
    async def _opened(_leg: object) -> None:
        opened.set()

    async def connected() -> None:
        # **Two gates, because an open socket is not yet able to hear.**
        # The service opens the connection and only then asks the provider
        # to configure a transcription session; audio handed over in
        # between is sent to a session that does not exist yet, and
        # `run_stt` does not hold it back. The first thing a voice
        # simulation does is hand this leg the agent's greeting, so
        # without the second gate the first turn of a real call would
        # simply be missing — the failure LISTENING_READY_SECONDS exists
        # for, and the one the deepgram leg waits out the same way.
        #
        # The first gate is the service's own public event. The second reads
        # a private flag, exactly as the Deepgram leg does. Pipecat 1.7.0,
        # pinned in uv.lock, has no event for a configured realtime session;
        # a rename must fail loudly here rather than make first turns vanish.
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
