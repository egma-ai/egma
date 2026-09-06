"""The recorder puts each channel where the transport says it belongs.

One simulation leaves one recording, and every number egma reads off it —
how long the caller waited, where a transcript turn seeks to — is read as
a distance on that one timeline. So the timeline has to be time.

These tests feed the recorder by hand: frames whose audio says one thing
and whose transport clock says another. A recorder that counts samples
puts the agent's reply where the persona's buffer happened to end. A
recorder that reads the clock puts it where it arrived.
"""

from __future__ import annotations

import sys
from array import array
from fractions import Fraction

import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)

from egma_simulator import conductor as conductor_module
from egma_simulator.media import arrived_at, played_out_at

BAND = 24_000
"""The recording's band, and the band both sides are fed at, so nothing
below turns on a resampler's own rounding."""

FRAME_SECONDS = 0.02
LOUD = 8_000
"""One sample value nothing else writes, so a track's own audio can be
told apart from the quiet the recorder puts around it."""


def tone(seconds: float = FRAME_SECONDS) -> bytes:
    """Audio a listener can find, at the recording's own band."""
    return LOUD.to_bytes(2, "little", signed=True) * round(seconds * BAND)


def quiet(seconds: float = FRAME_SECONDS) -> bytes:
    """An open line with nobody speaking on it."""
    return bytes(2 * round(seconds * BAND))


async def recorder_started() -> conductor_module._EvidenceRecorder:
    """One recorder, recording, with nothing on either track yet."""
    made = conductor_module._EvidenceRecorder(
        num_channels=2, sample_rate=BAND, auto_start_recording=True
    )
    made._update_sample_rate(StartFrame(audio_out_sample_rate=BAND))
    await made.start_recording()
    return made


async def agent_said(
    recorder: conductor_module._EvidenceRecorder,
    *,
    arriving_at: float,
    source_from: float,
    audio: bytes,
) -> None:
    """One inbound frame, arriving at the transport when it says it did."""
    frame = InputAudioRawFrame(audio=audio, sample_rate=BAND, num_channels=1)
    seconds = Fraction(len(audio) // 2, BAND)
    frame.metadata[conductor_module._INPUT_SOURCE_RANGE] = (
        Fraction(source_from).limit_denominator(BAND),
        Fraction(source_from).limit_denominator(BAND) + seconds,
    )
    arrived_at(frame, arriving_at)
    await recorder._process_recording(frame)


async def persona_said(
    recorder: conductor_module._EvidenceRecorder,
    *,
    playing_at: float,
    audio: bytes,
) -> None:
    """One outbound frame, heard at the far end when it says it is."""
    frame = OutputAudioRawFrame(audio=audio, sample_rate=BAND, num_channels=1)
    played_out_at(frame, playing_at)
    await recorder._process_recording(frame)


def tracks(
    recorder: conductor_module._EvidenceRecorder,
) -> tuple[array, array]:
    """Both tracks, the persona first, as one recording holds them.

    The same two tracks the simulation's recording handler is handed, and
    the same final padding: Pipecat merges them only after both have been
    brought to one length, which is what makes the file one clock.
    """
    recorder._align_track_buffers()
    merged = array("h")
    merged.frombytes(recorder.merge_audio_buffers())
    if sys.byteorder != "little":
        merged.byteswap()
    return merged[1::2], merged[0::2]


def audible(track: array, apart: float = 0.2) -> list[tuple[float, float]]:
    """Every stretch of speech on one track, in seconds.

    Two stretches are one utterance while less than ``apart`` of quiet
    separates them, which is what lets a re-anchor put a tenth of a
    second of quiet inside one utterance without making it two.
    """
    loud = [at for at, sample in enumerate(track) if abs(sample) >= LOUD // 2]
    assert loud, "the track holds no audible audio at all"
    stretches: list[tuple[int, int]] = []
    began = loud[0]
    for before, at in zip(loud, loud[1:], strict=False):
        if at - before > apart * BAND:
            stretches.append((began, before + 1))
            began = at
    stretches.append((began, loud[-1] + 1))
    return [(began / BAND, ended / BAND) for began, ended in stretches]


def speaking(track: array) -> tuple[float, float]:
    """The first and last audible instant of one track, in seconds."""
    stretches = audible(track)
    return stretches[0][0], stretches[-1][1]


WIRE_SECONDS = 0.05
"""The known lag between the agent speaking and egma holding the audio."""


async def agent_held_the_line(
    recorder: conductor_module._EvidenceRecorder,
    *,
    source_from: float,
    seconds: float,
    speaking_up: bool,
) -> None:
    """The agent's inbound stream, which never stops while a call is up.

    A transport carries quiet as faithfully as speech, so the agent's
    source clock runs on whether or not anybody is talking.
    """
    for step in range(round(seconds / FRAME_SECONDS)):
        at = source_from + step * FRAME_SECONDS
        await agent_said(
            recorder,
            arriving_at=at + WIRE_SECONDS,
            source_from=at,
            audio=tone() if speaking_up else quiet(),
        )


async def test_each_channel_lands_where_its_transport_clock_says() -> None:
    """The persona at its playout, the agent at its arrival, one timeline.

    The shape of a real turn. The agent greets and then holds the line
    quiet. The speech leg makes the persona's whole answer in one burst,
    a second before the transport will play any of it. The agent replies
    half a second after the persona stops.

    Placed by buffer length the persona lands where its speech leg made
    it and the agent's reply is padded up to that, which puts the two of
    them a second closer together than the caller ever heard them.
    Placed by time each one sits where the conversation put it, and the
    half second between them is the half second that was waited.
    """
    recorder = await recorder_started()

    await agent_held_the_line(
        recorder, source_from=0.0, seconds=0.5, speaking_up=True
    )
    await agent_held_the_line(
        recorder, source_from=0.5, seconds=1.5, speaking_up=False
    )

    persona_from = 2.0
    for step in range(50):
        await persona_said(
            recorder,
            playing_at=persona_from + step * FRAME_SECONDS,
            audio=tone(),
        )

    await agent_held_the_line(
        recorder, source_from=2.0, seconds=1.5, speaking_up=False
    )
    await agent_held_the_line(
        recorder, source_from=3.5, seconds=0.5, speaking_up=True
    )

    # The recording's own zero is the first audio anybody put on it: the
    # agent's greeting as it reached the transport, one wire behind the
    # moment the agent spoke it. So the agent's audio reads back on its
    # own source clock, and the persona's reads back one wire early.
    def on_the_recording(stamped: float) -> float:
        return stamped - WIRE_SECONDS

    persona_track, agent_track = tracks(recorder)
    assert audible(persona_track) == [
        pytest.approx((on_the_recording(2.0), on_the_recording(3.0)), abs=0.01)
    ]
    greeted, replied = audible(agent_track)
    assert greeted == pytest.approx((0.0, 0.5), abs=0.01)
    assert replied == pytest.approx((3.5, 4.0), abs=0.01)

    # What the file says the caller waited: the half second the agent took
    # to answer, and the wire it took to bring the answer here. That is
    # the whole of the difference between this number and the agent's own,
    # and it is why the two clocks can be checked against each other.
    persona_stopped = audible(persona_track)[0][1]
    assert replied[0] - persona_stopped == pytest.approx(
        0.5 + WIRE_SECONDS, abs=0.01
    )


async def test_a_capture_clock_that_runs_slow_does_not_slide_the_recording(
) -> None:
    """A channel is re-anchored when its own clock drifts off the timeline.

    The agent sends twenty milliseconds of audio every twenty-one: a five
    per cent rate error, the shape of the drift measured on a real
    simulation. Counted out sample by sample the track falls a second
    behind over twenty seconds of call. Placed by arrival it never falls
    more than the re-anchor tolerance behind, whichever end of the call
    the reader seeks to.
    """
    recorder = await recorder_started()

    frames = 1_000
    lagging_frame = 0.021
    for step in range(frames):
        await agent_said(
            recorder,
            arriving_at=step * lagging_frame,
            source_from=step * FRAME_SECONDS,
            audio=tone(),
        )

    arrived_through = (frames - 1) * lagging_frame + FRAME_SECONDS
    _persona_track, agent_track = tracks(recorder)
    began, ended = speaking(agent_track)
    assert began == pytest.approx(0.0, abs=0.01)
    assert ended == pytest.approx(arrived_through, abs=0.1)


async def test_a_turn_seeks_to_the_place_its_audio_was_put() -> None:
    """The transcript's seek positions are read off the same timeline.

    A grader's reader opens the recording at the position the transcript
    names. That position comes from the recorder's own map of the agent's
    speech onto the recording, so the map has to agree with where the
    audio went — including after a re-anchor.
    """
    recorder = await recorder_started()

    frames = 500
    lagging_frame = 0.021
    for step in range(frames):
        await agent_said(
            recorder,
            arriving_at=step * lagging_frame,
            source_from=step * FRAME_SECONDS,
            audio=tone(),
        )
    await recorder.close_input_at(Fraction(frames * 20, 1_000))

    spoke_from = Fraction(frames - 25, 1) * Fraction(20, 1_000)
    spoke_through = Fraction(frames, 1) * Fraction(20, 1_000)
    began, ended = await recorder.agent_interval(
        spoke_from, spoke_through, observed_through=spoke_through
    )

    arrived_from = (frames - 25) * lagging_frame
    arrived_through = (frames - 1) * lagging_frame + FRAME_SECONDS
    assert float(began) == pytest.approx(arrived_from, abs=0.1)
    assert float(ended) == pytest.approx(arrived_through, abs=0.1)


async def test_audio_the_transport_threw_away_is_not_in_the_recording(
) -> None:
    """An interruption clears a queue, and what it held was never heard.

    The persona's last second sits in the transport waiting its turn when
    the agent talks over it. The transport drops it, so the caller never
    hears it — and a recording that keeps it would say the persona spoke
    for a second longer than it did, and start the next wait a second
    late.
    """
    recorder = await recorder_started()

    for step in range(50):
        await persona_said(
            recorder, playing_at=step * FRAME_SECONDS, audio=tone()
        )

    cleared = InterruptionFrame()
    played_out_at(cleared, 0.4)
    await recorder._process_recording(cleared)

    persona_track, _agent_track = tracks(recorder)
    assert speaking(persona_track) == pytest.approx((0.0, 0.4), abs=0.01)
