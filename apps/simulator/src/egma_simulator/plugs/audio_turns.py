"""Where a turn begins and ends, on a line carrying a live voice.

The plug seam is turn-shaped and a live line is not. Nobody hands over a
whole utterance on a phone call or in a room: audio simply arrives, and
there is no end-of-turn signal anywhere in it. So a plug over a live line
reads turn boundaries out of the audio itself, and every plug over a live
line reads them the same way — which is why the reading lives here rather
than in any one of them.

The far end is speaking while the samples carry speech, and its turn is
over once the line has been quiet for :data:`END_OF_TURN_QUIET_SECONDS`.
A far end that says nothing at all for :data:`NOTHING_SAID_SECONDS` has
answered without words, which the walk records as a turn that carried
none rather than waiting out the simulation's duration limit — hold
music, a line left open, and an agent that simply did not speak all end
up honest and cheap.

**Every one of those budgets is spent in audio, not on a clock.** Quiet
counts when quiet arrives, so a real exchange spends twelve seconds
waiting out a silent far end and CI spends none, through the same code.

The quiet before the far end's first word is handed up as true quiet of
the same length. That is what it was — nobody was speaking — and it is
where time-to-first-word is read from; a line's own comfort noise would
otherwise read as speech that started immediately.
"""

from __future__ import annotations

import sys
from array import array

from ..media import MediaSession
from ..speech import SAMPLE_WIDTH_BYTES, silence
from . import AgentSpeech, Utterance

FAR_END_SLICE_SECONDS = 0.2
"""How long one read waits for audio from the far end. Only ever a bound
on waiting: what is measured is the audio that arrives."""

END_OF_TURN_QUIET_SECONDS = 0.8
"""How much quiet ends the far end's turn. Long enough to sit through the
pause inside a sentence, short enough that the persona does not talk over
somebody who has finished."""

NOTHING_SAID_SECONDS = 12.0
"""How much quiet means the far end answered this turn without words."""

SPEECH_LEVEL = 500
"""The sample level, out of 32767, above which audio is somebody talking.

A line is never digitally silent — it carries comfort noise, and a
threshold is what tells that apart from speech. Set low enough to hear a
quiet talker and high enough to ignore a line's own hiss.
"""


def carries_speech(pcm: bytes) -> bool:
    """Whether somebody is talking in this stretch of audio."""
    return peak_level(pcm) >= SPEECH_LEVEL


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


async def next_turn(session: MediaSession, band_hz: int) -> AgentSpeech:
    """One turn of the far end's speech, as the line delivered it.

    Speech is kept, and so is any pause inside it; the quiet before the
    first word is counted rather than kept, and handed back as quiet of
    the same length; the quiet after the last word is dropped, because it
    belongs to the next turn rather than to this one's measured duration.
    """
    spoken = bytearray()
    pause = bytearray()
    before_first_word = 0.0
    quiet_seconds = 0.0
    heard_speech = False

    while True:
        arrived = await session.receive(FAR_END_SLICE_SECONDS)
        if not arrived:
            # Nothing arrived, or a frame with nothing in it — which are
            # the same thing to a listener, and reading them the same way
            # is what stops an empty frame from being a loop that makes no
            # progress and never ends.
            if session.far_end_left:
                # The far end is off the line and nothing more is coming.
                # Whatever was said before that is the turn, and the
                # exchange is over — see the module docstring.
                return _turn(before_first_word, spoken, band_hz, ended=True)
            quiet_seconds += FAR_END_SLICE_SECONDS
            if not heard_speech:
                before_first_word += FAR_END_SLICE_SECONDS
        elif carries_speech(arrived):
            heard_speech = True
            quiet_seconds = 0.0
            spoken += pause + arrived
            pause.clear()
        else:
            seconds = len(arrived) / SAMPLE_WIDTH_BYTES / band_hz
            quiet_seconds += seconds
            if heard_speech:
                pause += arrived
            else:
                before_first_word += seconds

        if heard_speech and quiet_seconds >= END_OF_TURN_QUIET_SECONDS:
            return _turn(before_first_word, spoken, band_hz)
        if not heard_speech and before_first_word >= NOTHING_SAID_SECONDS:
            return AgentSpeech(audio=None, ended=session.far_end_left)


def _turn(
    before_first_word: float,
    spoken: bytearray,
    band_hz: int,
    *,
    ended: bool = False,
) -> AgentSpeech:
    if not spoken:
        return AgentSpeech(audio=None, ended=ended)
    return AgentSpeech(
        audio=Utterance(
            pcm=silence(before_first_word, band_hz) + bytes(spoken),
            sample_rate_hz=band_hz,
        ),
        ended=ended,
    )
