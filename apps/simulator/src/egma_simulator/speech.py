"""The speech legs: words into sound, and sound back into words.

A voice simulation is a chat simulation with two more legs. The persona
brain still writes the words — it never learns that they are spoken — and
these are what carry them: a text-to-speech leg giving the persona a
voice, and a speech-to-text leg turning what comes back into the
transcript's ``agent`` turns.

Both legs sit behind Pipecat's own service base classes, which is the
whole point of them being here: a real provider — Cartesia or ElevenLabs
speaking, Deepgram or Whisper listening — is another subclass of the same
two classes, selected by configuration, and nothing above this file
changes when one arrives. What CI runs on instead is the scripted pair
below: no model, no network, and the same words out of the STT that went
into the TTS, every time.

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
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService
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


class ScriptedTTS(TTSService):
    """The persona's voice, deterministically.

    Holds the voice the persona was authored with the way a real service
    holds a provider voice id — the exchange is what proves the leg was
    assembled from this simulation's own spec.
    """

    def __init__(self, *, voice: PersonaVoice, sample_rate_hz: int) -> None:
        super().__init__(
            sample_rate=sample_rate_hz,
            settings=TTSSettings(model=None, voice=voice.voice_id, language=None),
        )
        self.voice = voice

    def can_generate_metrics(self) -> bool:
        return False

    async def run_tts(
        self, text: str, context_id: str
    ) -> AsyncGenerator[Frame | None, None]:
        del context_id
        yield TTSStartedFrame()
        yield TTSAudioRawFrame(
            audio=encode_speech(text, self.sample_rate),
            sample_rate=self.sample_rate,
            num_channels=1,
        )
        yield TTSStoppedFrame()


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
