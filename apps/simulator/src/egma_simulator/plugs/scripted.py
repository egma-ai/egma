"""The scripted counterpart: CI's platform, and honestly the first plug.

A fake platform whose agent answers from a script, so a whole simulation
conducts with no account, no network, and no model on the other side —
deterministically. It is not a shortcut around the seam: it implements the
same plug surface a real platform does, which is what makes the acceptance
suite's conversations representative.

Its config keys, like every plug's, are its own:

- ``greeting`` (string, optional) — spoken by the agent the moment the
  exchange opens. Absent: the persona speaks first.
- ``replies`` (list, default empty) — the agent's answers, in order, one
  per persona turn. An entry may be ``null`` instead of a string, which
  is an answer that carried no words — what a real platform hands back
  when its agent called a tool and said nothing.
- ``ends_after_replies`` (bool, default false) — when true, the last
  scripted reply ends the exchange (with no replies at all, the exchange
  ends silently on the first persona turn). When false, a spent script
  falls back to a fixed holding line forever.
- ``turn_seconds`` (number ≥ 0, default 0) — how long the agent takes to
  answer, the way a real platform takes time. What makes mid-exchange
  cancellation testable.
- ``provider_reference`` (string, optional) — offered as the platform's
  own identifier for the exchange, the way a real plug offers a chat id.
- ``tool_calls`` (list of objects, default empty) — tools the scripted
  agent calls while producing its first answer, each ``{"name": …}`` with
  an optional ``"arguments"`` string, the way a platform that exposes its
  agent's tool traffic reports it alongside the words. One position is
  enough: what a script has to be able to produce is the shape, and where
  in an exchange it lands is the real platform's business.
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
        mock_tools: object = None,
        media: object = None,
    ) -> None:
        # The scripted counterpart takes no credentials; anything handed
        # over is ignored unread, the way a sentinel-planting test expects.
        # It has nobody to tell which simulation this is, either, nobody's
        # tools to stand in front of, and no telephone network to reach.
        del access_variant, credentials, simulation_id, mock_tools, media

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
