"""The speech legs: words into sound, and sound back into words.

A voice simulation is a chat simulation with two more legs. The persona
brain still writes the words — it never learns that they are spoken — and
these are what carry them: a text-to-speech leg giving the persona a
voice, and a speech-to-text leg turning what comes back into the
transcript's ``agent`` turns.

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
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from functools import cache
from typing import TYPE_CHECKING, Any

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
from pipecat.services.stt_service import STTService
from pipecat.utils.time import time_now_iso8601

if TYPE_CHECKING:
    from .config import SimulatorConfig

logger = logging.getLogger(__name__)

SAMPLE_WIDTH_BYTES = 2
"""16-bit signed little-endian, the one sample format the simulator carries."""

SAMPLES_PER_BYTE = 240
"""How many samples one encoded byte occupies — 30 ms at 8 kHz, 5 ms at 48 kHz."""

TONE_BASE_HZ = 200
TONE_STEP_HZ = 10
TONE_AMPLITUDE = 8000

DEFAULT_VOICE_ID = "egma-scripted-voice"
"""What a persona authored with no voice block speaks with."""

DEFAULT_ENGLISH_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"
"""The English voice a persona speaks with when its traits name none.

ElevenLabs' own long-standing default from their shared library, so every
account has it. A persona is authored for its behavior far more often
than for its timbre, and one that named no voice must still be able to
call: silence is not a sensible default."""

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


class ScriptedSTT(STTService):
    """What the agent said, read back out of the audio it arrived as."""

    def __init__(self, *, sample_rate_hz: int) -> None:
        super().__init__(
            sample_rate=sample_rate_hz,
            settings=STTSettings(model=None, language=None),
            ttfs_p99_latency=1.0,
        )

    def can_generate_metrics(self) -> bool:
        return False

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        yield TranscriptionFrame(
            text=decode_speech(audio, self.sample_rate),
            user_id="",
            timestamp=time_now_iso8601(),
        )


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
    deepgram_api_key: str | None = field(default=None, repr=False)
    elevenlabs_api_key: str | None = field(default=None, repr=False)

    @classmethod
    def from_config(cls, config: SimulatorConfig) -> SpeechProviders:
        return cls(
            stt=config.stt_provider,
            tts=config.tts_provider,
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
        # One persona turn is one whole thing to say. The default is to
        # regroup text into sentences, which is done with a tokenizer
        # corpus fetched from the internet — the download this package
        # disarms — and a turn is already the unit here, so there is
        # nothing to regroup and nothing to fetch.
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
