"""Deterministic chat adapter for offline simulation tests.

Config: greeting is optional; replies supplies one string or None per persona turn.
ends_after_replies ends on the last reply, or first turn when the list is empty;
otherwise exhausted replies use a fixed holding line. turn_seconds delays each
reply for cancellation tests. provider_reference is optional. tool_calls supplies
name and optional argument text for calls reported with the first reply.
"""

from __future__ import annotations

import asyncio
from typing import Any

from . import AgentReply, PlugError, ToolCall

FALLBACK_REPLY = "Is there anything else I can help you with?"
"""What the agent says once its script is spent but the exchange holds."""

_KNOWN_KEYS = {
    "greeting",
    "replies",
    "ends_after_replies",
    "turn_seconds",
    "provider_reference",
    "tool_calls",
}


class ScriptedCounterpart:
    """The scripted counterpart, one exchange per instance."""

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
        job_dispatch_metadata: object = None,
        mock_tools: object = None,
        media: object = None,
    ) -> None:
        # The scripted counterpart takes no credentials; anything handed
        # over is ignored unread, the way a sentinel-planting test expects.
        # It has nobody to tell which simulation this is, either, nobody's
        # tools to stand in front of, no telephone network to reach, no
        # worker to dispatch, and no platform keeping versions or rendering
        # variables.
        del access_variant, credentials, simulation_id, mock_tools, media
        del agent_version, dynamic_variables, job_dispatch_metadata

        if modality != "chat":
            raise PlugError(
                f"the scripted counterpart speaks chat only; a {modality!r} "
                "simulation needs a plug with the matching legs"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                "the scripted counterpart does not know config "
                f"key(s) {sorted(unknown)}; it knows {sorted(_KNOWN_KEYS)}"
            )

        greeting = config.get("greeting")
        if greeting is not None and not isinstance(greeting, str):
            raise PlugError("scripted config: greeting must be a string")

        replies = config.get("replies", [])
        if not isinstance(replies, list) or not all(
            reply is None or isinstance(reply, str) for reply in replies
        ):
            raise PlugError(
                "scripted config: replies must be a list of strings, with "
                "null for an answer that carried no words"
            )

        ends_after_replies = config.get("ends_after_replies", False)
        if not isinstance(ends_after_replies, bool):
            raise PlugError("scripted config: ends_after_replies must be a bool")

        turn_seconds = config.get("turn_seconds", 0)
        if isinstance(turn_seconds, bool) or not isinstance(
            turn_seconds, int | float
        ):
            raise PlugError("scripted config: turn_seconds must be a number")
        if turn_seconds < 0:
            raise PlugError("scripted config: turn_seconds must be zero or more")

        reference = config.get("provider_reference")
        if reference is not None and not isinstance(reference, str):
            raise PlugError("scripted config: provider_reference must be a string")

        self._greeting = greeting
        self._replies = list(replies)
        self._ends_after_replies = ends_after_replies
        self._turn_seconds = float(turn_seconds)
        self._provider_reference = reference
        self._tool_calls = _scripted_tool_calls(config.get("tool_calls", []))
        self._delivered = 0

    @property
    def provider_reference(self) -> str | None:
        return self._provider_reference

    async def open(self) -> str | None:
        return self._greeting

    async def deliver(self, text: str) -> AgentReply:
        del text  # A script answers on cue, not on content.
        if self._turn_seconds:
            await asyncio.sleep(self._turn_seconds)

        position = self._delivered
        self._delivered += 1
        called = self._tool_calls if position == 0 else ()

        if position < len(self._replies):
            is_last = position == len(self._replies) - 1
            return AgentReply(
                text=self._replies[position],
                ended=self._ends_after_replies and is_last,
                tool_calls=called,
            )
        if self._ends_after_replies:
            return AgentReply(text=None, ended=True, tool_calls=called)
        return AgentReply(text=FALLBACK_REPLY, ended=False, tool_calls=called)

    async def close(self) -> None:
        return None


def _scripted_tool_calls(configured: object) -> tuple[ToolCall, ...]:
    """The tool calls a script says its agent makes, held to the same shape
    a real platform's would be read into."""
    if not isinstance(configured, list):
        raise PlugError("scripted config: tool_calls must be a list of objects")
    calls = []
    for entry in configured:
        if not isinstance(entry, dict) or set(entry) - {"name", "arguments"}:
            raise PlugError(
                "scripted config: each tool call is an object with a name "
                "and an optional arguments string"
            )
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise PlugError("scripted config: a tool call needs a name")
        arguments = entry.get("arguments")
        if arguments is not None and not isinstance(arguments, str):
            raise PlugError("scripted config: tool call arguments must be a string")
        calls.append(ToolCall(name=name, arguments=arguments))
    return tuple(calls)
