"""The loopback counterpart: CI's voice platform, on this machine.

A fake platform that answers in audio, so a whole voice simulation — the
persona speaking through a real text-to-speech leg, a real recording, real
measurements — conducts with no telephony, no account, and no network. It
is the scripted counterpart's twin one modality over, and deliberately so:
the same script, the same endings, the same refusal of config it does not
know, exchanged as sound instead of text.

It is not a shortcut around the seam. It implements the same voice plug
surface a phone or a browser transport will, which is what makes the
acceptance suite's voice walks representative of the ones that follow.

Its config keys, like every plug's, are its own:

- ``greeting`` (string, optional) — spoken by the agent the moment the
  exchange opens. Absent: the persona speaks first.
- ``replies`` (list of strings, default empty) — the agent's answers, in
  order, one per persona turn.
- ``ends_after_replies`` (bool, default false) — when true, the last
  scripted reply ends the exchange (with no replies at all, the exchange
  ends silently on the first persona turn). When false, a spent script
  falls back to a fixed holding line forever.
- ``echoes_what_it_hears`` (bool, default false) — the telephone company's
  own echo test line: instead of reading a script, the counterpart answers
  with the caller's own audio. It replaces the script, so it cannot be
  combined with ``replies`` or ``ends_after_replies``. What it buys is a
  whole exchange whose agent side is real speech rather than the scripted
  codec — the only way, short of dialling somebody, to hear real speech
  legs work end to end: what a real voice speaks, real ears read back.
- ``answer_delay_seconds`` (number ≥ 0, default 0) — how long the agent is
  quiet before it starts speaking. It is rendered into the answer's own
  audio, where a live exchange carries it and where time-to-first-word
  is measured from, rather than slept through: CI then measures the
  same quantity a live exchange would without waiting for it.
- ``sample_rate_hz`` (integer, default 16000) — the band the connection
  asks for. The counterpart carries the nearest band it supports at or
  below it, exactly as a real platform negotiates down to what it can
  actually do, and reports that one. What the simulation stamps is the
  band that flowed, never this number.
- ``provider_reference`` (string, optional) — offered as the platform's
  own identifier for the exchange, the way a real plug offers a leg id.
"""

from __future__ import annotations

from typing import Any

from ..speech import encode_speech, silence
from . import AgentSpeech, PlugError, Utterance

FALLBACK_REPLY = "Is there anything else I can help you with?"
"""What the agent says once its script is spent but the exchange holds."""

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

    @property
    def provider_reference(self) -> str | None:
        return self._provider_reference

    @property
    def sample_rate_hz(self) -> int:
        return self._band_hz

    async def open(self) -> AgentSpeech | None:
        if self._greeting is None:
            return None
        return AgentSpeech(audio=self._say(self._greeting))

    async def deliver(self, speech: Utterance) -> AgentSpeech:
        if self._echoes:
            # Whatever arrived, sent straight back — after the same quiet
            # a scripted answer waits, so time-to-first-word is measured
            # here exactly as it is everywhere else.
            return AgentSpeech(
                audio=Utterance(
                    pcm=silence(self._answer_delay_seconds, self._band_hz)
                    + speech.pcm,
                    sample_rate_hz=self._band_hz,
                )
            )

        # A script answers on cue, not on content — the persona's audio is
        # heard and then answered from the script, the way the scripted
        # chat counterpart answers text.
        del speech

        position = self._delivered
        self._delivered += 1

        if position < len(self._replies):
            is_last = position == len(self._replies) - 1
            return AgentSpeech(
                audio=self._say(self._replies[position]),
                ended=self._ends_after_replies and is_last,
            )
        if self._ends_after_replies:
            return AgentSpeech(audio=None, ended=True)
        return AgentSpeech(audio=self._say(FALLBACK_REPLY), ended=False)

    async def close(self) -> None:
        return None

    def _say(self, words: str) -> Utterance:
        return Utterance(
            pcm=silence(self._answer_delay_seconds, self._band_hz)
            + encode_speech(words, self._band_hz),
            sample_rate_hz=self._band_hz,
        )
