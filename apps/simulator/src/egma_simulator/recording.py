"""One voice simulation's canonical two-channel recording.

Every voice simulation leaves the same evidence behind, whoever conducted
it: a dual-channel WAV with one speaker to a channel and a storage
reference. The WAV header is the recording's only sample-rate fact.

The channel order is the transcript's own: the persona first, the agent
under test second, so the file needs no legend to be read.
"""

from __future__ import annotations

import io
import logging
import sys
import wave
from array import array
from dataclasses import dataclass

from .speech import SAMPLE_WIDTH_BYTES

logger = logging.getLogger(__name__)

RECORDING_NAME = "dual-channel.wav"
"""What one simulation's recording is called inside its own blob key."""

PERSONA_CHANNEL = 0
AGENT_CHANNEL = 1
"""Who is on which channel of a recording. The transcript's two labels in
the transcript's own order."""

WAVEFORM_BINS = 360
"""How many peaks one channel's waveform holds: one per drawn column."""

FULL_SCALE = 32768
"""The magnitude a signed 16-bit sample is measured against."""


@dataclass(frozen=True)
class AudioFacts:
    """The stored recording produced by a voice simulation."""

    recording: str
    started_unix_nano: int
    """The shared origin of the recording and every transcript span.

    VoiceConductor stamps turns as offsets from this instant. The simulator
    emits it as recording trace evidence before the trace is sealed.
    """
    waveform: dict[str, list[float]] | None = None
    """The recording drawn as peaks, measured while the WAV was written.

    A reader gets the graph from this rather than by fetching and decoding
    the whole file. None when nothing measured the recording.
    """

    def as_report(self) -> dict:
        """The contract's audio block, exactly."""
        report: dict = {"recording": self.recording}
        if self.waveform is not None:
            report["waveform"] = self.waveform
        return report


def dual_channel_wav(
    persona_audio: bytes, agent_audio: bytes, sample_rate_hz: int
) -> bytes:
    """Encode aligned audio with persona on channel 0 and agent on channel 1.
    Pad the shorter channel with silence, preserving overlap and recorder timing.
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


def waveform_of(
    persona_audio: bytes, agent_audio: bytes, bins: int = WAVEFORM_BINS
) -> dict[str, list[float]]:
    """The recording's loudness per equal slice, one list per channel.

    The slices span the padded frame count ``dual_channel_wav`` writes, so
    both channels are cut on one grid and a padded tail reads as silence.
    Each value is the loudest sample of its slice over full scale: 0.0 for
    quiet, 1.0 at most, rounded to three decimals.
    """
    frames = max(len(persona_audio), len(agent_audio)) // SAMPLE_WIDTH_BYTES
    return {
        "human": _peaks(persona_audio, frames, bins),
        "agent": _peaks(agent_audio, frames, bins),
    }


def measured_waveform(
    persona_audio: bytes, agent_audio: bytes
) -> dict[str, list[float]] | None:
    """``waveform_of``, or None when measuring fails.

    The recording is the evidence and its graph is a convenience, so a fault
    in measuring costs the graph and never the recording it describes.
    """
    try:
        return waveform_of(persona_audio, agent_audio)
    except Exception:
        logger.warning("the recording could not be measured for drawing", exc_info=True)
        return None


def _peaks(pcm: bytes, frames: int, bins: int) -> list[float]:
    """One channel's peak per slice, padded with quiet to ``frames``."""
    if frames == 0:
        return [0.0] * bins
    samples = _samples(pcm, frames)
    size = -(-frames // bins)
    peaks: list[float] = []
    for start in range(0, bins * size, size):
        window = samples[start : start + size]
        # Signed 16-bit holds no positive 32768, so the negative extreme is
        # read as its own magnitude instead of through abs(). A slice past
        # the last frame is quiet.
        loudest = 0 if len(window) == 0 else max(max(window), -min(window))
        peaks.append(round(loudest / FULL_SCALE, 3))
    return peaks


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
