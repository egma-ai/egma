"""The speech legs: words into sound, and sound back into words.

A voice simulation is a chat simulation with two more legs. The persona
brain still writes the words — it never learns that they are spoken — and
these are what carry them: a text-to-speech leg giving the persona a
voice, and a speech-to-text leg turning what comes back into the
transcript's ``agent`` turns.

Both legs are ordinary Pipecat frame processors, in the two places a
real provider's service would sit — Cartesia or ElevenLabs speaking,
Deepgram or Whisper listening — so the shape a provider must fit is
already settled, and the pipeline that is assembled around them does not
change when one arrives. The listening leg goes further and is a Pipecat
STT service, the very class a real one subclasses; the speaking leg
deliberately is not, and :class:`ScriptedTTS` says why.

**There is no way to select a real provider today**: the assembly builds
the scripted pair below, and nothing chooses between them. The switch
lands with the first real provider, together with the extra that installs
it and a way to test it; writing it now would be a code path nobody could
exercise.

What CI runs on is the scripted pair: no model, no network, no corpus
to download, and the same words out of the listening leg that went into
the speaking one.

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

import math
import struct
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from functools import cache
from typing import Any

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

SAMPLE_WIDTH_BYTES = 2
"""16-bit signed little-endian, the one sample format the simulator carries."""

SAMPLES_PER_BYTE = 240
"""How many samples one encoded byte occupies — 30 ms at 8 kHz, 5 ms at 48 kHz."""

TONE_BASE_HZ = 200
TONE_STEP_HZ = 10
TONE_AMPLITUDE = 8000

DEFAULT_VOICE_ID = "egma-scripted-voice"
"""What a persona authored with no voice block speaks with."""


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
