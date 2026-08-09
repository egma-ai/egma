"""The loopback counterpart: CI's voice platform, on this machine.

A fake platform that answers in audio, so a whole voice simulation — the
persona speaking through a real text-to-speech leg, a real recording, real
measurements — conducts with no telephony, no account, and no network. It
is the scripted counterpart's twin one modality over, and deliberately so:
the same script, the same endings, the same refusal of config it does not
know, exchanged as sound instead of text.

It is not a shortcut around the seam. It implements the same full-duplex
line surface a phone or a browser transport will, which is what makes the
acceptance suite's voice simulations representative of the ones that
follow: it is driven one slice of audio at a time, it hears the caller
only as samples, and it decides for itself when the caller has stopped.

Its config keys, like every plug's, are its own:

- ``greeting`` (string, optional) — spoken by the agent the moment the
  exchange opens. Absent: the persona speaks first.
- ``replies`` (list of strings, default empty) — the agent's answers, in
  order, one per stretch of caller speech.
- ``ends_after_replies`` (bool, default false) — when true, the last
  scripted reply ends the exchange (with no replies at all, the exchange
  ends silently once the caller has spoken once). When false, a spent
  script falls back to a fixed holding line forever.
- ``echoes_what_it_hears`` (bool, default false) — the telephone company's
  own echo test line: instead of reading a script, the counterpart answers
  with the caller's own audio. It replaces the script, so it cannot be
  combined with ``replies`` or ``ends_after_replies``. What it buys is a
  whole exchange whose agent side is real speech rather than the scripted
  codec — the only way, short of dialling somebody, to hear real speech
  legs work end to end: what a real voice speaks, real ears read back.
- ``answer_delay_seconds`` (number ≥ 0, default 0) — how long the agent is
  quiet before it starts speaking. It is spent as quiet on the line, where
  a live exchange spends it and where time-to-first-word is measured from,
  rather than slept through: CI then measures the same quantity a live
  exchange would without waiting for it.
- ``sample_rate_hz`` (integer, default 16000) — the band the connection
  asks for. The counterpart carries the nearest band it supports at or
  below it, exactly as a real platform negotiates down to what it can
  actually do, and reports that one. What the simulation stamps is the
  band that flowed, never this number.
- ``provider_reference`` (string, optional) — offered as the platform's
  own identifier for the exchange, the way a real plug offers a leg id.

## How it decides the caller has stopped

The same way a real far end does: by listening. Every slice the caller
sends is either speech or quiet — :func:`egma_simulator.speech.carries_speech`
answers that from the samples — and once the caller has spoken and then
been quiet long enough, the counterpart says its next line. Nothing tells
it where a turn ended, because nothing tells a real platform either.
"""

from __future__ import annotations

from typing import Any

from ..speech import (
    SAMPLE_WIDTH_BYTES,
    carries_speech,
    encode_speech,
    silence,
)
from . import PlugError

FALLBACK_REPLY = "Is there anything else I can help you with?"
"""What the agent says once its script is spent but the exchange holds."""

CALLER_FINISHED_SECONDS = 0.2
"""How much quiet the counterpart hears before it takes the caller's turn
to be over.

Every far end has a number like this, because hearing somebody stop is the
only way to know they have. It is a floor rather than an addition: a
counterpart told to wait longer than this waits exactly as long as it was
told, so ``answer_delay_seconds`` still names the whole of the quiet
before the answer and time-to-first-word still measures exactly it.
"""

SUPPORTED_BANDS_HZ = (8000, 16000, 48000)
"""Telephony, wideband, and full-band WebRTC — what this platform can carry."""

DEFAULT_BAND_HZ = 16000

_KNOWN_KEYS = {
    "greeting",
    "replies",
    "ends_after_replies",
    "answer_delay_seconds",
    "echoes_what_it_hears",
    "sample_rate_hz",
    "provider_reference",
}


def negotiated_band(asked_for: int) -> int:
    """The band this platform will actually carry for an asked-for one."""
    supported = [band for band in SUPPORTED_BANDS_HZ if band <= asked_for]
    return max(supported) if supported else min(SUPPORTED_BANDS_HZ)


class LoopbackCounterpart:
    """The scripted voice counterpart, one exchange per instance."""

    def __init__(
        self, *, modality: str, config: dict[str, Any], credentials: object
    ) -> None:
        # The loopback counterpart takes no credentials; anything handed
        # over is ignored unread, the way a sentinel-planting test expects.
        del credentials

        if modality != "voice":
            raise PlugError(
                f"the loopback counterpart speaks voice only; a {modality!r} "
                "simulation needs a plug with the matching legs"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                "the loopback counterpart does not know config "
                f"key(s) {sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        greeting = config.get("greeting")
        if greeting is not None and not isinstance(greeting, str):
            raise PlugError("loopback config: greeting must be a string")

        replies = config.get("replies", [])
        if not isinstance(replies, list) or not all(
            isinstance(reply, str) for reply in replies
        ):
            raise PlugError("loopback config: replies must be a list of strings")

        ends_after_replies = config.get("ends_after_replies", False)
        if not isinstance(ends_after_replies, bool):
            raise PlugError("loopback config: ends_after_replies must be a bool")

        echoes = config.get("echoes_what_it_hears", False)
        if not isinstance(echoes, bool):
            raise PlugError(
                "loopback config: echoes_what_it_hears must be a bool"
            )
        if echoes and ("replies" in config or ends_after_replies):
            raise PlugError(
                "loopback config: a counterpart that echoes has no script, so "
                "echoes_what_it_hears cannot be combined with replies or "
                "ends_after_replies"
            )

        delay = config.get("answer_delay_seconds", 0)
        if isinstance(delay, bool) or not isinstance(delay, int | float):
            raise PlugError("loopback config: answer_delay_seconds must be a number")
        if delay < 0:
            raise PlugError(
                "loopback config: answer_delay_seconds must be zero or more"
            )

        asked_for = config.get("sample_rate_hz", DEFAULT_BAND_HZ)
        if isinstance(asked_for, bool) or not isinstance(asked_for, int):
            raise PlugError("loopback config: sample_rate_hz must be an integer")
        if asked_for < 1:
            raise PlugError("loopback config: sample_rate_hz must be more than zero")

        reference = config.get("provider_reference")
        if reference is not None and not isinstance(reference, str):
            raise PlugError("loopback config: provider_reference must be a string")

        self._greeting = greeting
        self._replies = list(replies)
        self._ends_after_replies = ends_after_replies
        self._echoes = echoes
        self._answer_delay_seconds = float(delay)
        self._band_hz = negotiated_band(asked_for)
        self._provider_reference = reference

        self._delivered = 0
        self._saying = b""
        self._heard_the_caller = False
        self._quiet_samples = 0
        self._echoed_back = bytearray()
        self._ends_when_said = False
        self._left = False

    @property
    def provider_reference(self) -> str | None:
        return self._provider_reference

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    @property
    def far_end_left(self) -> bool:
        return self._left

    async def open(self) -> None:
        """Come on the line, and start the greeting if there is one."""
        if self._greeting is not None:
            # The delay is quiet on the line before the first word, which
            # is exactly where a live platform's own is.
            self._saying = self._quiet(self._answer_delay_seconds) + encode_speech(
                self._greeting, self._band_hz
            )

    async def exchange(self, outgoing: bytes) -> bytes:
        """One slice of the line: say what is due, and hear the caller.

        Answering is decided on everything heard *before* this slice,
        because that is all a far end can have heard by the time it puts
        this slice on the line. Hearing this one afterwards is what makes
        the quiet the counterpart spends exactly the quiet it was told to
        spend, to the sample.
        """
        if self._due_to_speak():
            self._say_the_next_thing()
        spoken = self._next_slice(len(outgoing))
        self._hear(outgoing)
        return spoken

    async def close(self) -> None:
        return None

    # -- Listening ----------------------------------------------------------

    def _hear(self, outgoing: bytes) -> None:
        """What the far end makes of the slice the caller just sent."""
        if carries_speech(outgoing):
            self._heard_the_caller = True
            self._quiet_samples = 0
            if self._echoes:
                self._echoed_back += outgoing
            return
        self._quiet_samples += len(outgoing) // SAMPLE_WIDTH_BYTES

    def _due_to_speak(self) -> bool:
        """Whether the caller has finished and the answer delay is spent."""
        if self._left or self._saying or not self._heard_the_caller:
            return False
        return self._quiet_samples >= self._quiet_before_answering()

    def _quiet_before_answering(self) -> int:
        """How many samples of quiet the counterpart waits out, in all.

        The configured delay, and never less than what it takes to hear a
        caller stop — see :data:`CALLER_FINISHED_SECONDS`.
        """
        return round(
            max(self._answer_delay_seconds, CALLER_FINISHED_SECONDS) * self._band_hz
        )

    # -- Speaking -----------------------------------------------------------

    def _say_the_next_thing(self) -> None:
        self._heard_the_caller = False

        if self._echoes:
            # Whatever arrived, sent straight back — after the same quiet
            # a scripted answer waits, so time-to-first-word is measured
            # here exactly as it is everywhere else.
            self._saying = bytes(self._echoed_back)
            self._echoed_back.clear()
            return

        position = self._delivered
        self._delivered += 1

        if position < len(self._replies):
            self._saying = encode_speech(self._replies[position], self._band_hz)
            self._ends_when_said = self._ends_after_replies and (
                position == len(self._replies) - 1
            )
            return
        if self._ends_after_replies:
            self._left = True
            return
        self._saying = encode_speech(FALLBACK_REPLY, self._band_hz)

    def _next_slice(self, slice_bytes: int) -> bytes:
        """The far end's own slice: what it is saying, or quiet."""
        if not self._saying:
            return bytes(slice_bytes)
        spoken, self._saying = self._saying[:slice_bytes], self._saying[slice_bytes:]
        if not self._saying and self._ends_when_said:
            # The last scripted line is said and the far end goes: on a
            # phone that is the hang-up, and here it is the same thing.
            self._left = True
        return spoken.ljust(slice_bytes, b"\x00")

    def _quiet(self, seconds: float) -> bytes:
        return silence(seconds, self._band_hz)
