"""The local Pipecat voice counterpart used by deterministic simulations."""

from __future__ import annotations

from typing import Any

from ..media import VoiceMedia
from ..media.scripted_transport import ScriptedTransport
from . import PlugError

FALLBACK_REPLY = "Is there anything else I can help you with?"

_KNOWN_KEYS = {
    "greeting",
    "replies",
    "ends_after_replies",
    "answer_delay_seconds",
    "echoes_what_it_hears",
    "goes_quiet_after_replies",
    "provider_reference",
}


class LoopbackCounterpart:
    """One scripted far end on the same Pipecat path as live voice."""

    def __init__(
        self,
        *,
        modality: str,
        access_variant: str,
        config: dict[str, Any],
        credentials: object,
        simulation_id: str | None = None,
        agent_version: object = None,
        dynamic_variables: object = None,
        mock_tools: object = None,
        media: object = None,
    ) -> None:
        # There is no platform here to keep versions or render variables:
        # the counterpart is this process talking to itself.
        del access_variant, credentials, simulation_id, mock_tools, media
        del agent_version, dynamic_variables
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
            raise PlugError("loopback config: echoes_what_it_hears must be a bool")
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
        goes_quiet = config.get("goes_quiet_after_replies", False)
        if not isinstance(goes_quiet, bool):
            raise PlugError(
                "loopback config: goes_quiet_after_replies must be a bool"
            )
        if goes_quiet and ends_after_replies:
            raise PlugError(
                "loopback config: a counterpart that goes quiet stays in the "
                "room, so goes_quiet_after_replies cannot be combined with "
                "ends_after_replies"
            )
        reference = config.get("provider_reference")
        if reference is not None and not isinstance(reference, str):
            raise PlugError("loopback config: provider_reference must be a string")

        self._provider_reference = reference
        self._transport = ScriptedTransport(
            greeting=greeting,
            replies=list(replies),
            answer_delay_seconds=float(delay),
            ends_after_replies=ends_after_replies,
            # The counterpart's default is to keep the conversation going
            # once its script runs out, because most tests want a far end
            # that stays available. ``goes_quiet_after_replies`` is the
            # other real agent: one that is in the room, publishing, and
            # saying nothing — which is what a broken worker looks like,
            # and the case the silent-agent rule exists for.
            fallback_reply=(
                None if ends_after_replies or goes_quiet else FALLBACK_REPLY
            ),
            echoes_what_it_hears=echoes,
        )

    @property
    def provider_reference(self) -> str | None:
        return self._provider_reference

    @property
    def far_end_left(self) -> bool:
        return self._transport.ended.is_set()

    @property
    def transport(self) -> ScriptedTransport:
        """The local transport, exposed for focused transport tests."""
        return self._transport

    async def prepare(self) -> VoiceMedia:
        return self._transport.media

    async def open(self) -> None:
        await self._transport.activate()

    async def close(self) -> None:
        self._transport.stop()
