"""Feed audio frames with controlled transport timestamps.
Verify channel placement follows transport time rather than the other channel's
buffer length, preserving recording latency and transcript seek positions.
"""

from __future__ import annotations

import sys
import time
from array import array
from fractions import Fraction

import pytest
from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from egma_simulator import conductor as conductor_module
from egma_simulator.media import (
    _TRANSPORT_PLAYOUT_GENERATION,
    TRANSPORT_ARRIVAL,
    PlayoutClearAcknowledger,
    PlayoutClearedFrame,
    PlayoutStamp,
    arrived_at,
    arrived_now,
    played_out_at,
    transport_time,
)

BAND = 24_000
"""The recording's band, and the band both sides are fed at, so nothing
below turns on a resampler's own rounding."""

FRAME_SECONDS = 0.02
RESYNC_TOLERANCE = conductor_module.RESYNC_TOLERANCE_SECONDS
LOUD = 8_000
"""One sample value nothing else writes, so a track's own audio can be
told apart from the quiet the recorder puts around it."""


def tone(seconds: float = FRAME_SECONDS) -> bytes:
    """Audio a listener can find, at the recording's own band."""
    return LOUD.to_bytes(2, "little", signed=True) * round(seconds * BAND)


def quiet(seconds: float = FRAME_SECONDS) -> bytes:
    """An open line with nobody speaking on it."""
    return bytes(2 * round(seconds * BAND))


async def recorder_started(
    *, real_time: bool = True
) -> conductor_module._EvidenceRecorder:
    """One recorder, recording, with nothing on either track yet."""
    made = conductor_module._EvidenceRecorder(
        num_channels=2,
        sample_rate=BAND,
        auto_start_recording=True,
        real_time=real_time,
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
    """Place persona audio at playout and agent audio at arrival.
    Audio synthesized a second early must not shorten the recorded half-second
    wait between the persona ending and the agent replying.
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


async def test_clear_overtaking_queued_audio_discards_only_the_unheard_generation(
) -> None:
    """A system clear can reach the recorder before older queued audio."""
    recorder = await recorder_started()
    cleared = InterruptionFrame()
    cleared.metadata[_TRANSPORT_PLAYOUT_GENERATION] = 0
    played_out_at(cleared, 0.01)
    await recorder._process_recording(cleared)

    partly_heard = OutputAudioRawFrame(
        audio=tone(), sample_rate=BAND, num_channels=1
    )
    partly_heard.metadata[_TRANSPORT_PLAYOUT_GENERATION] = 0
    played_out_at(partly_heard, 0.0)
    await recorder._process_recording(partly_heard)

    unheard = OutputAudioRawFrame(audio=tone(), sample_rate=BAND, num_channels=1)
    unheard.metadata[_TRANSPORT_PLAYOUT_GENERATION] = 0
    played_out_at(unheard, 0.1)
    await recorder._process_recording(unheard)

    fresh = OutputAudioRawFrame(audio=tone(), sample_rate=BAND, num_channels=1)
    fresh.metadata[_TRANSPORT_PLAYOUT_GENERATION] = 1
    played_out_at(fresh, 0.2)
    await recorder._process_recording(fresh)

    accepted_after_clear = OutputAudioRawFrame(
        audio=tone(), sample_rate=BAND, num_channels=1
    )
    accepted_after_clear.metadata[_TRANSPORT_PLAYOUT_GENERATION] = 1
    played_out_at(accepted_after_clear, 0.3)
    await recorder._process_recording(accepted_after_clear)

    persona_track, _agent_track = tracks(recorder)
    assert audible(persona_track, apart=0.05) == pytest.approx(
        [(0.0, 0.01), (0.2, 0.24)], abs=0.01
    )


@pytest.mark.parametrize("direction", list(FrameDirection))
async def test_playout_clear_is_acknowledged_after_native_clear(
    direction, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both pipeline directions acknowledge one completed native queue clear."""

    acknowledger = PlayoutClearAcknowledger()
    stamp = PlayoutStamp(acknowledged_clears=True)
    cleared = False
    clears = 0
    acks = 0

    async def no_base_processing(*_args) -> None:
        return None

    async def native(frame: Frame, direction: FrameDirection) -> None:
        nonlocal cleared, clears
        if direction == FrameDirection.DOWNSTREAM:
            await stamp.process_frame(frame, direction)
        else:
            await acknowledger.process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            cleared = True
            clears += 1

    async def from_acknowledger(frame: Frame, direction: FrameDirection) -> None:
        if direction == FrameDirection.DOWNSTREAM:
            await native(frame, direction)

    async def from_stamp(frame: Frame, direction: FrameDirection) -> None:
        nonlocal acks
        if direction == FrameDirection.UPSTREAM:
            await native(frame, direction)
        elif isinstance(frame, PlayoutClearedFrame):
            assert cleared
            acks += 1

    monkeypatch.setattr(FrameProcessor, "process_frame", no_base_processing)
    monkeypatch.setattr(acknowledger, "push_frame", from_acknowledger)
    monkeypatch.setattr(stamp, "push_frame", from_stamp)

    start = acknowledger if direction == FrameDirection.DOWNSTREAM else stamp
    await start.process_frame(InterruptionFrame(), direction)

    assert clears == 1
    assert acks == 1


async def test_a_delivery_that_stalls_and_catches_up_stays_on_time() -> None:
    """A delivery burst after a scheduling stall must reclaim inserted silence.
    Preserve the audio and restore channel timing instead of retaining a false gap.
    """
    recorder = await recorder_started()

    frames = 50
    for step in range(frames):
        await agent_said(
            recorder,
            arriving_at=step * FRAME_SECONDS,
            source_from=step * FRAME_SECONDS,
            audio=tone(),
        )

    # A second of nothing running, then a second of frames at once.
    woke_at = frames * FRAME_SECONDS + 1.0
    for step in range(frames):
        await agent_said(
            recorder,
            arriving_at=woke_at + step * 0.0002,
            source_from=(frames + step) * FRAME_SECONDS,
            audio=tone(),
        )

    # Delivery back to its senses.
    for step in range(frames):
        await agent_said(
            recorder,
            arriving_at=woke_at + FRAME_SECONDS * (step + 1),
            source_from=(2 * frames + step) * FRAME_SECONDS,
            audio=tone(),
        )

    _persona_track, agent_track = tracks(recorder)
    assert len(audible(agent_track)) == 1, "the recording opened a hole in speech"
    arrived_through = woke_at + FRAME_SECONDS * frames
    assert speaking(agent_track)[1] == pytest.approx(
        arrived_through, abs=RESYNC_TOLERANCE
    )


async def test_the_recordings_zero_outlives_the_recording() -> None:
    """Whoever files the audio reads the zero after the pipeline stops.

    Pipecat empties its buffers at both ends of a recording. If the
    timeline went with them, the file would be filed with the moment the
    line opened as its zero, and every transcript position — measured
    from the first sample — would seek past the words it names by the
    whole of the wait for the first frame.
    """
    recorder = await recorder_started()
    await agent_said(
        recorder, arriving_at=1.0, source_from=0.0, audio=tone()
    )

    zero = recorder.started_unix_nano
    assert zero

    await recorder.stop_recording()
    assert recorder.started_unix_nano == zero


def test_a_real_time_transport_stamps_the_frames_first_sample(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clock read when a frame is whole has already run its length.

    The stamp names the frame's first sample, because that is what the
    recorder places. Reading the clock and writing it down unchanged
    charges the recording one frame per frame, and every latency read off
    it carries the charge.
    """
    monkeypatch.setattr(time, "monotonic", lambda: 1000.0)
    frame = InputAudioRawFrame(audio=tone(), sample_rate=BAND, num_channels=1)

    arrived_now(frame)

    assert transport_time(frame, TRANSPORT_ARRIVAL) == pytest.approx(
        1000.0 - FRAME_SECONDS
    )


async def test_the_wall_clock_zero_is_when_the_first_sample_arrived(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The zero is derived from the stamp, not from when work got done.

    A frame can wait in the pipeline before the recorder sees it. Reading
    the wall clock at that moment would move the recording's zero by the
    wait, and with it every span the transcript stamps — against an
    agent's own spans, which waited for nothing.
    """
    filed_at = 1_800_000_000_000_000_000
    monkeypatch.setattr(conductor_module, "_now", lambda: filed_at)
    monkeypatch.setattr(conductor_module, "_monotonic", lambda: 1005.0)

    recorder = await recorder_started()
    await agent_said(
        recorder, arriving_at=1000.0, source_from=0.0, audio=tone()
    )

    assert recorder.started_unix_nano == filed_at - 5_000_000_000


async def test_a_media_clock_has_no_wall_clock_instant_to_give(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A scripted far end counts audio, not seconds.

    Its stamps are positions in a stream nobody lived through, so no
    instant can be derived from them and the moment of filing is the only
    honest answer.
    """
    filed_at = 1_800_000_000_000_000_000
    monkeypatch.setattr(conductor_module, "_now", lambda: filed_at)
    monkeypatch.setattr(conductor_module, "_monotonic", lambda: 1005.0)

    recorder = await recorder_started(real_time=False)
    await agent_said(
        recorder, arriving_at=1000.0, source_from=0.0, audio=tone()
    )

    assert recorder.started_unix_nano == filed_at


async def test_an_interruption_settles_the_quiet_the_recorder_owes() -> None:
    """When interruption cuts through inserted silence, update the owed-silence ledger.
    Later catch-up must not reclaim removed silence and overwrite the first utterance.
    """
    recorder = await recorder_started()

    for step in range(10):
        await persona_said(
            recorder, playing_at=step * FRAME_SECONDS, audio=tone()
        )

    # A pause long enough to re-anchor, then audio the transport queues.
    for step in range(10):
        await persona_said(
            recorder, playing_at=1.0 + step * FRAME_SECONDS, audio=tone()
        )

    cleared = InterruptionFrame()
    played_out_at(cleared, 0.5)
    await recorder._process_recording(cleared)
    cut_at = recorder.bot_position

    # The persona answers, and the transport plays it from the top: a
    # burst of frames stamped behind where the channel has been written.
    for step in range(10):
        await persona_said(
            recorder, playing_at=0.1 + step * 0.0002, audio=tone()
        )

    assert recorder.bot_position >= cut_at
    persona_track, _agent_track = tracks(recorder)
    assert audible(persona_track)[0] == pytest.approx((0.0, 0.2), abs=0.01)


async def test_two_stalls_before_one_catch_up_both_close() -> None:
    """A channel can fall behind twice before it catches up at all.

    The line stalls, one frame gets through, and the line stalls again.
    Only then does the burst arrive, carrying everything both stalls held
    back. A recorder that remembered only the newer stall would give that
    quiet back and leave the older gap in the file for good — and every
    position after it, audio and transcript alike, would sit that far
    away from the transport clock for the rest of the call.
    """
    recorder = await recorder_started()

    # A fifth of a second of speech, delivered as it is spoken.
    for step in range(10):
        await agent_said(
            recorder,
            arriving_at=step * FRAME_SECONDS,
            source_from=step * FRAME_SECONDS,
            audio=tone(),
        )

    # Half a second of nothing running, then one frame gets through.
    await agent_said(
        recorder, arriving_at=0.70, source_from=0.20, audio=tone()
    )

    # Half a second more, then a whole second of frames at once.
    for step in range(50):
        await agent_said(
            recorder,
            arriving_at=1.22 + step * 0.0002,
            source_from=0.22 + step * FRAME_SECONDS,
            audio=tone(),
        )

    # Delivery back to its senses.
    for step in range(10):
        await agent_said(
            recorder,
            arriving_at=1.24 + step * FRAME_SECONDS,
            source_from=1.22 + step * FRAME_SECONDS,
            audio=tone(),
        )

    _persona_track, agent_track = tracks(recorder)
    assert len(audible(agent_track)) == 1, "a stall stayed in the recording"
    arrived_through = 1.24 + 10 * FRAME_SECONDS
    assert speaking(agent_track)[1] == pytest.approx(
        arrived_through, abs=RESYNC_TOLERANCE
    )
