"""The scripted media backend: CI's phone network, on this machine.

A fake bridge that answers a call, says what it was told to say, hears
what the persona says back, and hangs up when the script says so — with
no LiveKit server, no trunk, no carrier and no network. It is the
loopback counterpart's twin one layer down: the same script, the same
endings, the same refusal of config it does not know, exchanged as
frames of audio on a call rather than as whole turns.

It is not a shortcut around the seam. It implements the same media
backend a real bridge does, which is what makes the phone plug's
behavior in CI the behavior it will have on a real call.

**It answers in no time at all, and that is deliberate.** Everything the
record measures — how long the far end was quiet before it spoke, when a
turn was over — is measured out of the audio rather than off a clock, so
this backend hands over the same *quiet* a real line would and hands it
over immediately. A twelve-second wait for a far end that never speaks
therefore costs a real call twelve seconds and costs CI nothing, with no
second code path anywhere.

**How it decides the persona has stopped.** The same way a real far end
does: by listening. Every slice the persona sends is either speech or
quiet, and once the persona has spoken and then been quiet long enough,
the script says its next line. Nothing tells it where a turn ended,
because nothing tells a real bridge either.

Its config keys, like every driver's, are its own, and they arrive in the
phone connection's ``scripted`` block:

- ``greeting`` (string, optional) — what the far end says the moment it
  picks up. Absent: it answers and says nothing, and the persona speaks
  first, the way a silent line really behaves.
- ``replies`` (list of strings, default empty) — the far end's answers,
  in order, one per stretch of persona speech. A spent script answers with
  quiet.
- ``answer_delay_seconds`` (number ≥ 0, default 0) — how long the far end
  is quiet before each answer. Rendered into the call's own audio, where
  a live call carries it and where time-to-first-word is read from. It is
  a floor rather than an addition: a backend told to wait less than it
  takes to hear a persona stop still waits that long, and one told to wait
  longer waits exactly as long as it was told.
- ``hangs_up_after_replies`` (bool, default false) — when true the far
  end leaves the call once its last reply has been carried, which is what
  the agent hanging up looks like from the plug's seat.
- ``outcome`` (string, default ``answered``) — what the dial does, named
  for what the carrier does: ``busy``, ``no_answer``, ``declined``,
  ``carrier_failure``, and ``trunk_rejected`` — a trunk whose credentials
  the carrier will not accept, which is a refusal at the dial and not
  before it, because only the carrier can say so. (Trunk configuration
  that is *missing* is refused at startup, where the real driver refuses
  it, and this fake models no path the real one does not have.)
- ``provider_reference`` (string, optional) — offered as the bridge's own
  identifier for the call, the way the LiveKit driver offers the SIP
  participant's identity.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from typing import Any

from ..config import MediaSettings
from ..speech import SAMPLE_WIDTH_BYTES, carries_speech, encode_speech, silence
from . import MediaBackendError, sip_refusal

FRAME_SECONDS = 0.02
"""How much audio one carried frame holds — twenty milliseconds, the size
a real call's frames arrive in. Quiet and speech never share a frame, so
what is measured off the boundary between them is exact."""

PERSONA_FINISHED_SECONDS = 0.2
"""How much quiet this bridge hears before it takes the persona's turn to
be over.

Every far end has a number like this, because hearing somebody stop is the
only way to know they have — it is the loopback counterpart's own floor,
one layer down, and it is the same number for the same reason.
"""

DEFAULT_REFERENCE = "scripted-sip-participant-1"
"""What the bridge calls this call when the script names nothing."""

REFUSALS = {
    "busy": (486, "Busy Here"),
    "no_answer": (480, "Temporarily Unavailable"),
    "declined": (603, "Decline"),
    "carrier_failure": (503, "Service Unavailable"),
    "trunk_rejected": (403, "Forbidden"),
}
"""The carrier statuses this backend can be told to answer with. Each one
goes through the same table a real carrier's refusal goes through, so what
CI proves about an ending is proved about the real path — see
:func:`egma_simulator.media.sip_refusal`."""

_KNOWN_KEYS = {
    "greeting",
    "replies",
    "answer_delay_seconds",
    "hangs_up_after_replies",
    "outcome",
    "provider_reference",
}

_OUTCOMES = {"answered", *REFUSALS}


class ScriptedSession:
    """The audio of one scripted call: frames out, frames in, at once."""

    def __init__(
        self,
        *,
        band_hz: int,
        delay_seconds: float,
        answered_by: Callable[[], None] | None = None,
    ) -> None:
        self._band_hz = band_hz
        self._delay_seconds = delay_seconds
        self._answered_by = answered_by
        self._pending: deque[bytes] = deque()
        self._left = False
        self._hang_up_when_drained = False
        self._speaking = bytearray()
        self._heard_the_persona = False
        self._quiet_samples = 0
        self.heard: list[bytes] = []
        """Every stretch of persona speech this call carried, in order —
        what a test asks when it wants the far end's side of the story.
        A stretch closes when the persona has been quiet long enough to
        have finished, which is the only moment a far end could know."""

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def far_end_left(self) -> bool:
        return self._left

    def greet(self, words: str, *, then_hang_up: bool = False) -> None:
        """The first thing on the line: the quiet before it, then the words.

        Nobody has spoken yet, so there is no persona to hear stop and the
        quiet the far end takes before its first word is queued here
        rather than waited out.
        """
        self._queue(silence(self._delay_seconds, self._band_hz))
        self.say(words, then_hang_up=then_hang_up)

    def say(self, words: str, *, then_hang_up: bool = False) -> None:
        """Queue one answer, starting now.

        No quiet in front of it: an answer is only ever queued once the
        persona has been heard to stop, and that listening is where the
        whole of the wait was spent — see :meth:`_quiet_before_answering`.
        """
        self._queue(encode_speech(words, self._band_hz))
        if then_hang_up:
            self._hang_up_when_drained = True
            if not self._pending:
                # Nothing to carry and nothing to wait for: a far end that
                # hangs up without a goodbye has already gone.
                self._left = True

    def hang_up(self) -> None:
        self._left = True

    async def send(self, pcm: bytes) -> None:
        """One slice of the persona's own voice, onto the line.

        Answering is decided on everything heard *before* this slice,
        because that is all a far end can have heard by the time this one
        reaches it. Hearing this one afterwards is what makes the quiet
        the bridge spends exactly the quiet it was told to spend, to the
        sample.
        """
        self._answer_if_the_persona_has_finished()
        self._hear(pcm)

    async def receive(self, seconds: float) -> bytes | None:
        if self._pending:
            frame = self._pending.popleft()
            if not self._pending and self._hang_up_when_drained:
                self._left = True
            return frame
        if self._left:
            # The line is down; nothing more will ever arrive on it.
            return None
        # A line with nobody speaking on it still carries quiet, and both
        # speakers are on one clock only because it does.
        return silence(seconds, self._band_hz)

    # -- Listening -----------------------------------------------------------

    def _hear(self, pcm: bytes) -> None:
        """What the far end makes of the slice the persona just sent."""
        if carries_speech(pcm):
            self._heard_the_persona = True
            self._quiet_samples = 0
            self._speaking += pcm
            return
        self._quiet_samples += len(pcm) // SAMPLE_WIDTH_BYTES

    def _answer_if_the_persona_has_finished(self) -> None:
        if self._left or self._pending or not self._heard_the_persona:
            return
        if self._quiet_samples < self._quiet_before_answering():
            return
        self.heard.append(bytes(self._speaking))
        self._speaking.clear()
        self._heard_the_persona = False
        if self._answered_by is not None:
            self._answered_by()

    def _quiet_before_answering(self) -> int:
        """How many samples of quiet the far end waits out, in all.

        The configured delay, and never less than what it takes to hear a
        persona stop — see :data:`PERSONA_FINISHED_SECONDS`.
        """
        return round(
            max(self._delay_seconds, PERSONA_FINISHED_SECONDS) * self._band_hz
        )

    def _queue(self, pcm: bytes) -> None:
        """Slice one stretch of audio into the frames a call carries it in."""
        step = int(round(FRAME_SECONDS * self._band_hz)) * SAMPLE_WIDTH_BYTES
        for offset in range(0, len(pcm), step):
            self._pending.append(pcm[offset : offset + step])


class ScriptedBackend:
    """One scripted call, dialled and conducted and ended, per instance."""

    def __init__(
        self,
        *,
        settings: MediaSettings,
        config: dict[str, Any],
        band_hz: int,
        caller_id: str | None,
    ) -> None:
        # The scripted bridge places no real call, so neither the number it
        # would appear to come from nor a trunk to place it over is
        # anything to it.
        del caller_id, settings

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise MediaBackendError(
                "the scripted media backend does not know config "
                f"key(s) {sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        greeting = config.get("greeting")
        if greeting is not None and not isinstance(greeting, str):
            raise MediaBackendError("scripted backend: greeting must be a string")

        replies = config.get("replies", [])
        if not isinstance(replies, list) or not all(
            isinstance(reply, str) for reply in replies
        ):
            raise MediaBackendError(
                "scripted backend: replies must be a list of strings"
            )

        delay = config.get("answer_delay_seconds", 0)
        if isinstance(delay, bool) or not isinstance(delay, int | float):
            raise MediaBackendError(
                "scripted backend: answer_delay_seconds must be a number"
            )
        if delay < 0:
            raise MediaBackendError(
                "scripted backend: answer_delay_seconds must be zero or more"
            )

        hangs_up = config.get("hangs_up_after_replies", False)
        if not isinstance(hangs_up, bool):
            raise MediaBackendError(
                "scripted backend: hangs_up_after_replies must be a bool"
            )

        outcome = config.get("outcome", "answered")
        if outcome not in _OUTCOMES:
            raise MediaBackendError(
                f"scripted backend: outcome must be one of {sorted(_OUTCOMES)}; "
                f"got {outcome!r}"
            )
        reference = config.get("provider_reference", DEFAULT_REFERENCE)
        if not isinstance(reference, str) or not reference:
            raise MediaBackendError(
                "scripted backend: provider_reference must be a non-empty string"
            )

        self._greeting = greeting
        self._replies = list(replies)
        self._delay_seconds = float(delay)
        self._hangs_up = hangs_up
        self._outcome = outcome
        self._reference = reference
        self._band_hz = band_hz
        self._session: ScriptedSession | None = None
        self._delivered = 0
        self.dialled: list[str] = []
        """Every number this backend was asked to dial, in order."""

    @property
    def session(self) -> ScriptedSession | None:
        """The call's audio, once there is a call. What a test listens to."""
        return self._session

    async def create_session(self) -> ScriptedSession:
        self._session = ScriptedSession(
            band_hz=self._band_hz,
            delay_seconds=self._delay_seconds,
            answered_by=self._answer_to,
        )
        return self._session

    async def dial(self, number: str) -> None:
        self.dialled.append(number)

    async def wait_answered(self, seconds: float) -> str:
        # Nothing here waits: a scripted carrier answers or refuses at once,
        # and how long a real one may ring is the plug's budget to hold.
        del seconds
        if self._outcome in REFUSALS:
            raise sip_refusal(*REFUSALS[self._outcome])
        if self._session is None:
            raise MediaBackendError(
                "the scripted backend was asked for an answer before a session"
            )
        if self._greeting is not None:
            self._session.greet(
                self._greeting,
                then_hang_up=self._hangs_up and not self._replies,
            )
        return self._reference

    async def teardown(self) -> None:
        if self._session is not None:
            self._session.hang_up()

    def _answer_to(self) -> None:
        """Queue the answer to one stretch of persona speech.

        A spent script answers with quiet rather than with a holding line:
        a phone call that has run out of things to say is a call where
        nobody is talking, and the conductor reads exactly that.
        """
        session = self._session
        if session is None:
            return
        position = self._delivered
        self._delivered += 1
        if position >= len(self._replies):
            return
        session.say(
            self._replies[position],
            then_hang_up=self._hangs_up and position == len(self._replies) - 1,
        )
