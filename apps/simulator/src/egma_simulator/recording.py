"""One voice simulation's canonical two-channel recording.

Every voice simulation leaves the same evidence behind, whoever conducted
it: a dual-channel WAV with one speaker to a channel and a storage
reference. The WAV header is the recording's only sample-rate fact.

The channel order is the transcript's own: the persona first, the agent
under test second, so the file needs no legend to be read.
"""

from __future__ import annotations

import io
import sys
import wave
from array import array
from dataclasses import dataclass
from datetime import UTC, datetime

from .speech import SAMPLE_WIDTH_BYTES

RECORDING_NAME = "dual-channel.wav"
"""What one simulation's recording is called inside its own blob key."""

PERSONA_CHANNEL = 0
AGENT_CHANNEL = 1
"""Who is on which channel of a recording. The transcript's two labels in
the transcript's own order."""


@dataclass(frozen=True)
class AudioFacts:
    """The stored recording produced by a voice simulation."""

    recording: str
    started_unix_nano: int
    """The shared origin of the recording and every transcript span.

    VoiceConductor stamps turns as offsets from this instant. Keeping the
    same origin beside the recording lets a reader place those turns on the
    WAV timeline without guessing from a provider event or the first span.
    """

    def as_report(self) -> dict:
        """The contract's audio block, exactly."""
        seconds, nanos = divmod(self.started_unix_nano, 1_000_000_000)
        instant = datetime.fromtimestamp(seconds, UTC)
        return {
            "recording": self.recording,
            "started_at": f"{instant:%Y-%m-%dT%H:%M:%S}.{nanos:09d}Z",
        }


def dual_channel_wav(
    persona_audio: bytes, agent_audio: bytes, sample_rate_hz: int
) -> bytes:
    """Both sides of one exchange, one speaker to a channel.

    The persona on channel 0 and the agent on channel 1, in the order the
    transcript labels them, so each side can be heard alone when a
    transcript looks wrong. The shorter track is padded with quiet so a
    file never runs out halfway through the exchange.

    Pipecat's recorder aligns and pads the two tracks on one timeline, so
    two speakers talking over each other remain audible as exactly that.
    """
    frames = max(len(persona_audio), len(agent_audio)) // SAMPLE_WIDTH_BYTES
    interleaved = array("h", bytes(frames * 2 * SAMPLE_WIDTH_BYTES))
    interleaved[PERSONA_CHANNEL::2] = _samples(persona_audio, frames)
    interleaved[AGENT_CHANNEL::2] = _samples(agent_audio, frames)

    written = io.BytesIO()
    with wave.open(written, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(SAMPLE_WIDTH_BYTES)
        out.setframerate(sample_rate_hz)
        out.writeframes(_as_pcm(interleaved))
    return written.getvalue()


def channels_of(wav_bytes: bytes) -> tuple[bytes, bytes, int]:
    """One recording, taken apart: persona, agent, and the band it holds."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as recording:
        if recording.getnchannels() != 2:
            raise ValueError("the recording is not dual-channel")
        sample_rate_hz = recording.getframerate()
        interleaved = _samples(
            recording.readframes(recording.getnframes()), recording.getnframes() * 2
        )
    return (
        _as_pcm(interleaved[PERSONA_CHANNEL::2]),
        _as_pcm(interleaved[AGENT_CHANNEL::2]),
        sample_rate_hz,
    )


def _samples(pcm: bytes, frames: int) -> array:
    """PCM read as signed 16-bit samples, padded with quiet to ``frames``.

    ``array`` holds samples in this machine's byte order while PCM is
    always little-endian, so the two agree only on a little-endian
    machine and a swap is what makes them agree anywhere else.
    """
    samples = array("h")
    samples.frombytes(pcm[: frames * SAMPLE_WIDTH_BYTES])
    if sys.byteorder != "little":
        samples.byteswap()
    samples.extend([0] * (frames - len(samples)))
    return samples


def _as_pcm(samples: array) -> bytes:
    """Signed 16-bit samples written back out as little-endian PCM."""
    if sys.byteorder == "little":
        return samples.tobytes()
    little_endian = array("h", samples)
    little_endian.byteswap()
    return little_endian.tobytes()
