"""The phone band: converted, not relabelled — and measured, not assumed.

Two claims, and each of them is a way a phone simulation can be quietly
worthless.

**The conversion.** OpenAI's speech endpoint returns 24 kHz audio whatever
is asked of it — there is no parameter that changes it — and Pipecat's own
service stamps every chunk with the band the *pipeline* was assembled at
without converting anything. Assembled on a phone line, that is a 24 kHz
recording labelled 8 kHz: the persona speaks at a third of the rate, three
times too deep, for three times as long. Nothing fails. The agent under
test hears a voice no caller has, every latency is wrong by a factor of
three, and the only sign is a warning in a log.

**The measurement.** A record that stamped the band the pipeline was
*configured* at would say 8 kHz whether the audio was 8 kHz or not, which
is exactly the thing a measurement must never do. So the band on the record
is read back off the frames that really arrived.
"""

from __future__ import annotations

import math
import struct

import pytest
from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection

from egma_simulator.plugs.phone import TELEPHONY_BAND_HZ
from egma_simulator.speech import (
    OPENAI_TTS_BAND_HZ,
    SAMPLE_WIDTH_BYTES,
    SpeechProviders,
    _BandCorrection,
    _mouth,
    voice_from_traits,
)

A_KEY = "sk-only-this-test-holds-this-one"


def a_tone(hertz: float, seconds: float, band_hz: int) -> bytes:
    """One pure tone, as the PCM a provider would hand over."""
    samples = int(round(seconds * band_hz))
    return b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * hertz * n / band_hz)))
        for n in range(samples)
    )


def seconds_of(pcm: bytes, band_hz: int) -> float:
    return len(pcm) / SAMPLE_WIDTH_BYTES / band_hz


async def carried(correction: _BandCorrection, frames: list[TTSAudioRawFrame]) -> bytes:
    """Everything the correction let through, as one stretch of audio."""
    got = bytearray()

    async def collect(frame, direction=FrameDirection.DOWNSTREAM):  # noqa: ANN001
        if isinstance(frame, TTSAudioRawFrame):
            assert frame.sample_rate == correction.carried_at_hz, (
                "a converted frame carries the band it was converted to; a frame "
                "still carrying the provider's band means nothing was converted"
            )
            got.extend(frame.audio)

    correction.push_frame = collect  # type: ignore[method-assign]
    for frame in frames:
        await correction.process_frame(frame, FrameDirection.DOWNSTREAM)
    return bytes(got)


async def test_a_provider_second_stays_a_second_at_the_phone_band():
    """The whole point, in one measurement.

    One second of 24 kHz audio is one second of 8 kHz audio. Relabelling it
    would make it three, and three seconds of a voice a third too low is
    what a phone simulation would have been carrying with nobody noticing.
    """
    correction = _BandCorrection(
        spoken_at_hz=OPENAI_TTS_BAND_HZ, carried_at_hz=TELEPHONY_BAND_HZ
    )
    spoken = a_tone(440.0, 1.0, OPENAI_TTS_BAND_HZ)
    assert seconds_of(spoken, OPENAI_TTS_BAND_HZ) == pytest.approx(1.0, abs=0.001)

    out = await carried(
        correction,
        [
            TTSAudioRawFrame(
                audio=spoken, sample_rate=OPENAI_TTS_BAND_HZ, num_channels=1
            )
        ],
    )

    # The tolerance is for the streaming resampler's own tail — it holds back
    # the last few milliseconds until the next chunk arrives, which is what
    # makes it seamless across chunks. It is nowhere near the factor of three
    # this test exists to catch.
    assert seconds_of(out, TELEPHONY_BAND_HZ) == pytest.approx(1.0, abs=0.05), (
        "the audio was relabelled rather than converted: at the phone band it "
        f"lasts {seconds_of(out, TELEPHONY_BAND_HZ):.2f}s instead of 1.00s"
    )
    # And it really is about a third of the samples, which is what conversion
    # means and what relabelling would never do.
    assert len(out) == pytest.approx(len(spoken) / 3, rel=0.05)


async def test_a_stream_cut_on_an_odd_byte_is_still_carried_whole():
    """A sample is two bytes and a provider's stream is cut wherever its HTTP
    chunking fell. Resampling half a sample shifts every sample after it by a
    byte, which is white noise on the line and a transcript of nothing."""
    correction = _BandCorrection(
        spoken_at_hz=OPENAI_TTS_BAND_HZ, carried_at_hz=TELEPHONY_BAND_HZ
    )
    spoken = a_tone(440.0, 0.6, OPENAI_TTS_BAND_HZ)
    # Deliberately odd-length pieces, so every boundary but the last splits a
    # sample down the middle.
    pieces = [spoken[at : at + 999] for at in range(0, len(spoken), 999)]
    assert any(len(piece) % 2 == 1 for piece in pieces)

    out = await carried(
        correction,
        [
            TTSAudioRawFrame(
                audio=piece, sample_rate=OPENAI_TTS_BAND_HZ, num_channels=1
            )
            for piece in pieces
        ],
    )

    assert seconds_of(out, TELEPHONY_BAND_HZ) == pytest.approx(0.6, abs=0.05)


async def test_a_line_already_at_the_provider_band_is_left_alone():
    """Nothing is resampled for the sake of it: a wideband room carries the
    provider's own audio untouched."""
    correction = _BandCorrection(
        spoken_at_hz=OPENAI_TTS_BAND_HZ, carried_at_hz=OPENAI_TTS_BAND_HZ
    )
    spoken = a_tone(440.0, 0.2, OPENAI_TTS_BAND_HZ)

    out = await carried(
        correction,
        [
            TTSAudioRawFrame(
                audio=spoken, sample_rate=OPENAI_TTS_BAND_HZ, num_channels=1
            )
        ],
    )

    assert out == spoken


def test_the_openai_mouth_is_built_at_the_provider_band_and_converted_after():
    """Where the two halves meet.

    The provider's own service is built at the band it really speaks at —
    telling it the line's band is precisely what makes it mislabel — and the
    conversion to the line's band sits after it.
    """
    leg, spoken_with, closers = _mouth(
        SpeechProviders(tts="openai", openai_api_key=A_KEY),
        voice_from_traits({}),
        TELEPHONY_BAND_HZ,
    )

    # A nested pipeline puts its own source first and its own sink last, so
    # the two legs are what is between them.
    speaking, correction = leg.processors[1], leg.processors[2]  # type: ignore[attr-defined]
    # The band it was *built* with, which is what matters: a service told no
    # band takes the pipeline's at start, and taking the pipeline's is exactly
    # the mislabelling this whole arrangement exists to prevent. Read from the
    # field the service keeps it in, because it is not public — a pipecat
    # release that renames it must fail here, loudly, rather than by every
    # phone call quietly going out three times too slow.
    assert speaking._init_sample_rate == OPENAI_TTS_BAND_HZ
    assert isinstance(correction, _BandCorrection)
    assert correction.spoken_at_hz == OPENAI_TTS_BAND_HZ
    assert correction.carried_at_hz == TELEPHONY_BAND_HZ
    # A persona that named no voice speaks with one the provider accepts —
    # another provider's voice id is an error frame at the first turn.
    assert spoken_with.voice_id == "alloy"
    assert closers == ()


def test_the_openai_mouth_refuses_without_a_key_rather_than_at_the_first_turn():
    from egma_simulator.speech import SpeechFault

    with pytest.raises(SpeechFault, match="without a key"):
        _mouth(
            SpeechProviders(tts="openai"),
            voice_from_traits({}),
            TELEPHONY_BAND_HZ,
        )


# -- What the record stamps ---------------------------------------------------


class _LineThatCarriesAnotherBand:
    """A line driven at one band whose audio really arrives at another.

    Impossible on a working deployment and the whole point of testing it: the
    two agree while the bridge resamples what arrives to the band the pipeline
    was assembled at, and a record that *copied* the assembled band would say
    8 kHz whether that stayed true or not.
    """

    def __init__(self, *, driven_at_hz: int, arrived_at_hz: int | None) -> None:
        self._driven_at_hz = driven_at_hz
        self._arrived_at_hz = arrived_at_hz
        self._carried = False
        self._slices = 0

    @property
    def provider_reference(self) -> str | None:
        return "a-call"

    @property
    def sample_rate_hz(self) -> int:
        return self._driven_at_hz

    @property
    def measured_band_hz(self) -> int | None:
        return self._arrived_at_hz if self._carried else None

    @property
    def far_end_left(self) -> bool:
        return self._slices > 40

    async def open(self) -> None:
        return None

    async def exchange(self, outgoing: bytes) -> bytes:
        self._carried = True
        self._slices += 1
        return bytes(len(outgoing))

    async def close(self) -> None:
        return None


async def _stamped_band(
    tmp_path, *, driven_at_hz: int, arrived_at_hz: int | None
) -> int:
    from test_voice import Assembled, observe, spec_for

    from egma_simulator.blob import FilesystemBlobStore
    from egma_simulator.conductor import VoiceConductor
    from egma_simulator.walk import WalkControls

    spec = spec_for(scenario="First point.")
    conductor = VoiceConductor(
        line=_LineThatCarriesAnotherBand(
            driven_at_hz=driven_at_hz, arrived_at_hz=arrived_at_hz
        ),
        voice=voice_from_traits(spec.persona_traits),
        blobs=FilesystemBlobStore(tmp_path),
        recording_key=f"{spec.simulation_id}/dual-channel.wav",
    )
    await observe(
        conductor, Assembled(conductor=conductor), spec, controls=WalkControls()
    )
    assert conductor.audio is not None
    return conductor.audio.measured_sample_rate_hz


async def test_the_record_stamps_the_band_the_audio_arrived_at(tmp_path):
    """Measured, not assumed.

    A line driven at the phone band whose audio really arrived wideband is a
    misconfiguration — and the record's job is to make it visible rather than
    to hide it behind the band somebody configured.
    """
    stamped = await _stamped_band(
        tmp_path, driven_at_hz=TELEPHONY_BAND_HZ, arrived_at_hz=16000
    )
    assert stamped == 16000, (
        "the record copied the band the line was driven at; a measured band "
        "that can only ever be the configured one measures nothing"
    )


async def test_the_record_falls_back_to_the_driven_band_when_nothing_arrived(tmp_path):
    """A line that carried nothing has nothing to measure, and then the band it
    was driven at is the only honest thing left to say."""
    stamped = await _stamped_band(
        tmp_path, driven_at_hz=TELEPHONY_BAND_HZ, arrived_at_hz=None
    )
    assert stamped == TELEPHONY_BAND_HZ
