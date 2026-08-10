"""The speech legs: words into sound, and sound back into words.

A voice simulation is a chat simulation with two more legs. The persona
brain still writes the words — it never learns that they are spoken — and
these are what carry them: a text-to-speech leg giving the persona a
voice, and a speech-to-text leg turning what comes back into the
transcript's ``agent`` turns. A third leg listens for *whether* anybody is
speaking rather than for words — the voice activity detector — and it is
chosen here on the same terms as the other two.

Both legs are ordinary Pipecat frame processors, in the two places a
real provider's service sits — ElevenLabs speaking, Deepgram listening —
so the pipeline assembled around them is the same pipeline either way.
The listening leg goes further and is a Pipecat STT service, the very
class a real one subclasses; the speaking leg deliberately is not, and
:class:`ScriptedTTS` says why.

**Which pair is used is configuration, read at pipeline assembly and
nowhere else** — see :class:`SpeechProviders`. Each leg is chosen on its
own, because a real mouth with scripted ears is a configuration somebody
will want. Nothing else in the simulator learns which pair it got: a plug
still exchanges audio, and the persona brain still writes text.

What CI runs on, and any deployment that sets nothing, is the scripted
pair: no account, no network, no corpus to download, and the same words
out of the listening leg that went into the speaking one.

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
from typing import TYPE_CHECKING, Any

from pipecat.audio.vad.vad_analyzer import VADAnalyzer, VADParams
from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
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

if TYPE_CHECKING:
    from .config import SimulatorConfig

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

DEFAULT_VOICE_ID = "egma-scripted-voice"
"""What a persona authored with no voice block speaks with."""

DEFAULT_ENGLISH_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"
"""The English voice a persona speaks with when its traits name none.

Sarah, one of ElevenLabs' *premade* voices — the set every account is
given, on every plan. Deliberately not one of the shared-library voices,
which read as defaults in the documentation and which a free account is
refused with ``paid_plan_required``: a default that only works once
somebody has paid is not a default. A persona is authored for its
behavior far more often than for its timbre, and one that named no voice
must still be able to call."""

LISTENING_READY_SECONDS = 15.0
"""How long a listening leg may take to become able to hear.

A streaming transcriber opens its connection in the background and
*silently drops* audio handed to it before that connection is up. The
first thing a voice exchange does is hand it the agent's greeting, so
without this wait the first turn of a real call would vanish."""


@dataclass(frozen=True)
class PersonaVoice:
    """Which voice the persona speaks with, read from its authored traits.

    Traits are otherwise opaque — the persona brain composes the whole
    block into its prompt without picking favourites — and this is the one
    key a leg reads out of them, defensively: a persona authored with no
    voice, or a voice of some shape this code has never seen, still speaks.
    """

    voice_id: str
    provider: str | None
    speed: float | None


def voice_from_traits(traits: dict[str, Any]) -> PersonaVoice:
    """The persona's voice, or the default one where authoring said nothing."""
    block = traits.get("voice")
    if not isinstance(block, dict):
        return PersonaVoice(voice_id=DEFAULT_VOICE_ID, provider=None, speed=None)
    voice_id = block.get("voiceId")
    provider = block.get("provider")
    speed = block.get("speed")
    return PersonaVoice(
        voice_id=voice_id if isinstance(voice_id, str) else DEFAULT_VOICE_ID,
        provider=provider if isinstance(provider, str) else None,
        speed=float(speed) if isinstance(speed, int | float) else None,
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
                    TONE_AMPLITUDE
                    * math.cos(2 * math.pi * hertz * n / sample_rate_hz)
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

    def __init__(self, *, voice: PersonaVoice, sample_rate_hz: int) -> None:
        super().__init__()
        self.voice = voice
        self.sample_rate_hz = sample_rate_hz

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        # A transcription is a text frame travelling the other way — the
        # agent's words on their way to the persona, never something to
        # speak. The service base class draws the same line.
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

    def __init__(self, *, sample_rate_hz: int) -> None:
        super().__init__(
            sample_rate=sample_rate_hz,
            settings=STTSettings(model=None, language=None),
            ttfs_p99_latency=1.0,
        )

    @property
    def wants_wav_segments(self) -> bool:
        """Raw PCM, not a WAV file: the codec reads samples, not headers."""
        return False

    def can_generate_metrics(self) -> bool:
        return False

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

    def __init__(self, *, sample_rate_hz: int, window_samples: int) -> None:
        self._window_samples = window_samples
        super().__init__(
            sample_rate=sample_rate_hz,
            params=VADParams(
                confidence=0.5,
                # Loudness is already the whole of this leg's answer, so a
                # second loudness gate could only disagree with it.
                min_volume=0.0,
                start_secs=self.SPEAKING_WINDOWS * window_samples / sample_rate_hz,
                stop_secs=self.QUIET_WINDOWS * window_samples / sample_rate_hz,
            ),
        )

    def num_frames_required(self) -> int:
        return self._window_samples

    def voice_confidence(self, buffer: bytes) -> float:
        return 1.0 if carries_speech(buffer) else 0.0


# -- Choosing a pair ---------------------------------------------------------


class SpeechFault(RuntimeError):
    """A speech leg could not be built, or could not be made able to hear.

    Deliberately not a ``PlugError``: that word names a platform refusing,
    and this is the persona's own mouth or ears. Either way the walk
    reports a failed simulation, and the reason on the record is what
    tells a reader which of the two happened.
    """


@dataclass(frozen=True)
class SpeechProviders:
    """Which pair of legs a voice pipeline is assembled with.

    Configuration, and the whole of it: everything that differs between a
    scripted exchange and one carried by real providers is in these four
    values, they are read once at assembly, and nothing above assembly
    ever sees them. The default is the scripted pair, which is what makes
    "a deployment that sets nothing behaves exactly as it did" true by
    construction rather than by remembering.
    """

    stt: str = "scripted"
    tts: str = "scripted"
    vad: str = "scripted"
    """Which leg hears *whether* the far end is speaking. ``scripted``
    reads the test codec exactly and needs no model; ``silero`` is the
    production detector, and it ships inside the pinned pipecat wheel, so
    choosing it downloads nothing."""

    deepgram_api_key: str | None = field(default=None, repr=False)
    elevenlabs_api_key: str | None = field(default=None, repr=False)

    @classmethod
    def from_config(cls, config: SimulatorConfig) -> SpeechProviders:
        return cls(
            stt=config.stt_provider,
            tts=config.tts_provider,
            vad=config.vad_provider,
            deepgram_api_key=config.deepgram_api_key,
            elevenlabs_api_key=config.elevenlabs_api_key,
        )


SCRIPTED_PAIR = SpeechProviders()
"""The pair a pipeline is assembled with when nothing is configured."""


@dataclass
class SpeechLegs:
    """One simulation's mouth and ears, and how to finish with them."""

    stt: FrameProcessor
    tts: FrameProcessor

    voice: PersonaVoice
    """The voice the speaking leg was really built with — the authored one
    where it could be honored, the default English one where it could
    not. What this says is what the persona speaks with."""

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


def build_legs(
    providers: SpeechProviders, *, voice: PersonaVoice, sample_rate_hz: int
) -> SpeechLegs:
    """The pair this simulation speaks and listens with.

    Building is not connecting: a real leg constructs its client here and
    reaches the provider only once the exchange opens, so assembling a
    pipeline stays the validation step it has always been.
    """
    speaking, spoken_with, closers = _mouth(providers, voice, sample_rate_hz)
    listening_leg, listening = _ears(providers, sample_rate_hz)
    return SpeechLegs(
        stt=listening_leg,
        tts=speaking,
        voice=spoken_with,
        listening=listening,
        closers=closers,
    )


def build_vad(
    providers: SpeechProviders, *, sample_rate_hz: int, window_samples: int
) -> VADAnalyzer:
    """The leg this simulation hears speech *starting and stopping* with.

    Chosen at assembly and nowhere else, exactly like the mouth and the
    ears: the scripted detector reads the test codec's samples, so CI's
    every speech boundary is a sample position and the same one every
    run; Silero is what a live simulation listens with, and it is asked
    for by name because loading a model is a cost only a deployment that
    wants it should pay.
    """
    if providers.vad != "silero":
        return ScriptedVAD(
            sample_rate_hz=sample_rate_hz, window_samples=window_samples
        )

    # Imported here and not at the top of the file, for the reason every
    # provider in this module is: an unconfigured simulator must not load
    # a model it will never run. The quarantine suite holds this.
    from pipecat.audio.vad.silero import SileroVADAnalyzer

    return SileroVADAnalyzer(sample_rate=sample_rate_hz)


def _mouth(
    providers: SpeechProviders, voice: PersonaVoice, sample_rate_hz: int
) -> tuple[FrameProcessor, PersonaVoice, tuple[Callable[[], Awaitable[None]], ...]]:
    if providers.tts != "elevenlabs":
        return ScriptedTTS(voice=voice, sample_rate_hz=sample_rate_hz), voice, ()

    # Imported here and not at the top of the file: an unconfigured
    # simulator must not pay for a provider it will not use, and a
    # dependency that is never imported is a dependency that cannot
    # reach the network on its own. The quarantine suite holds this.
    import aiohttp
    from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService
    from pipecat.services.tts_service import TextAggregationMode

    if not providers.elevenlabs_api_key:
        raise SpeechFault("the elevenlabs speaking leg was chosen without a key")

    spoken_with = _voice_from(voice, provider="elevenlabs")
    settings = ElevenLabsHttpTTSService.Settings(voice=spoken_with.voice_id)
    if spoken_with.speed is not None:
        settings.speed = spoken_with.speed
    session = aiohttp.ClientSession()
    leg = ElevenLabsHttpTTSService(
        api_key=providers.elevenlabs_api_key,
        aiohttp_session=session,
        sample_rate=sample_rate_hz,
        settings=settings,
        # One persona turn is one whole thing to say, so it goes to the
        # provider in one piece rather than a sentence at a time, which
        # is what the default mode would do and what would add its
        # latency to every sentence.
        #
        # This does not avoid the sentence tokenizer, and it once was
        # thought to: the service pairs this mode with a sequencer that
        # regroups the streamed tokens back into sentences, to attribute
        # spoken words to the transcript. That regrouping reads the
        # tokenizer corpus, which is why the image ships one.
        text_aggregation_mode=TextAggregationMode.TOKEN,
    )
    return leg, spoken_with, (session.close,)


def _ears(
    providers: SpeechProviders, sample_rate_hz: int
) -> tuple[FrameProcessor, Callable[[], Awaitable[None]] | None]:
    if providers.stt != "deepgram":
        return ScriptedSTT(sample_rate_hz=sample_rate_hz), None

    from pipecat.services.deepgram.stt import DeepgramSTTService

    if not providers.deepgram_api_key:
        raise SpeechFault("the deepgram listening leg was chosen without a key")

    leg = DeepgramSTTService(
        api_key=providers.deepgram_api_key, sample_rate=sample_rate_hz
    )

    async def connected() -> None:
        # The service opens its websocket in a background task and drops
        # audio handed to it before that finishes, saying nothing. The
        # flag it sets when the connection can accept audio is the one
        # the service waits on itself when it reconnects; there is no
        # public way to ask. A pipecat release that renames it must be
        # noticed here, loudly, rather than by first turns going missing.
        connection_ready = getattr(leg, "_connection_ready", None)
        if connection_ready is None:
            raise SpeechFault(
                "this pipecat release no longer says when the deepgram leg "
                "is connected; a turn spoken before it is would be lost"
            )
        await connection_ready.wait()

    return leg, connected


def _voice_from(voice: PersonaVoice, *, provider: str) -> PersonaVoice:
    """The voice one provider can really speak with.

    A voice id belongs to the provider it was authored for. A persona
    naming this provider's voice — or naming a voice without saying whose
    it is — is honored. One naming another provider's voice is authoring
    for a deployment this is not, and the sensible default speaks instead:
    the alternative is a simulation that fails on a timbre.
    """
    authored = voice.provider
    if voice.voice_id != DEFAULT_VOICE_ID and authored in (None, provider):
        return PersonaVoice(
            voice_id=voice.voice_id, provider=provider, speed=voice.speed
        )
    if authored not in (None, provider):
        logger.info(
            "the persona's voice was authored for %s and this simulation "
            "speaks through %s; the default English voice speaks",
            authored,
            provider,
        )
    return PersonaVoice(
        voice_id=DEFAULT_ENGLISH_VOICE_ID, provider=provider, speed=voice.speed
    )
