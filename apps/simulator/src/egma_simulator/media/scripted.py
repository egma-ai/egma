"""The scripted phone backend used by deterministic simulations."""

from __future__ import annotations

from typing import Any

from ..config import MediaSettings
from . import MediaBackendError, VoiceMedia, sip_refusal
from .scripted_transport import ScriptedTransport

DEFAULT_REFERENCE = "scripted-sip-participant-1"

REFUSALS = {
    "busy": (486, "Busy Here"),
    "no_answer": (480, "Temporarily Unavailable"),
    "declined": (603, "Decline"),
    "carrier_failure": (503, "Service Unavailable"),
    "trunk_rejected": (403, "Forbidden"),
}

_KNOWN_KEYS = {
    "greeting",
    "replies",
    "answer_delay_seconds",
    "hangs_up_after_replies",
    "outcome",
    "provider_reference",
}
_OUTCOMES = {"answered", *REFUSALS}


class ScriptedBackend:
    """One scripted outbound call expressed as a Pipecat transport."""

    def __init__(
        self,
        *,
        settings: MediaSettings,
        config: dict[str, Any],
        caller_id: str | None,
    ) -> None:
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

        self._outcome = outcome
        self._reference = reference
        self._transport = ScriptedTransport(
            greeting=greeting,
            replies=list(replies),
            answer_delay_seconds=float(delay),
            ends_after_replies=hangs_up,
        )
        self.dialled: list[str] = []

    @property
    def transport(self) -> ScriptedTransport:
        return self._transport

    async def create_transport(self) -> VoiceMedia:
        return self._transport.media

    async def dial(self, number: str) -> None:
        self.dialled.append(number)

    async def wait_answered(self, seconds: float) -> str:
        del seconds
        if self._outcome in REFUSALS:
            raise sip_refusal(*REFUSALS[self._outcome])
        await self._transport.activate()
        return self._reference

    async def teardown(self) -> None:
        self._transport.stop()
