"""Retell chat: the first plug against a platform egma does not own.

It speaks Retell's public chat API over outbound HTTPS — ``create-chat`` to
open the exchange, ``create-chat-completion`` for each persona turn,
``end-chat`` to tear it down — with the connection's own key as a bearer
token. Everything it needs arrives in the claimed spec's connection block;
nothing about a Retell account lives in this process.

Its config keys, like every plug's, are its own:

- ``retellAgentId`` (string, required) — the chat agent the exchange is
  opened against, exactly as the control plane stores it.
- ``baseUrl`` (string, optional) — where the API answers, defaulting to
  Retell itself. What lets a test converse with a Retell-shaped server on
  loopback, and a proxy stand in front of the platform for a deployment
  that needs one.

Two facts about the simulation ride the same ``create-chat`` call when the
claimed spec carries them, and change nothing when it does not:

- the **agent version** to open the chat against, named explicitly so the
  exchange cannot land on a version somebody created since — which is how a
  run over a mocked world reaches that world's own draft;
- the **dynamic variables** this simulation is conducted with, handed to
  Retell as ``retell_llm_dynamic_variables`` for its own response engine to
  render, byte for byte.

A spec carrying neither produces exactly the request this plug has always
sent: the field is absent from the body, not present and empty, because an
empty one is a value Retell would render.

Credentials are shaped ``{"apiKey": ...}`` — the shape the control plane
seals — and are read for the ``Authorization`` header and nothing else.
They are never logged, never returned, and never put into an exception
message: a refusal names the status the platform answered with and the URL
it answered from, which is what a person needs, and neither is a secret.

A refusal also quotes the platform's own words about what was wrong, and
those are not this plug's to trust: a platform that echoes the key back in
its error body would otherwise put it in a failure reason and in the
traceback logged beneath it. Everything quoted from the platform is
therefore scrubbed of the key first, here, where the key is known.

**How the exchange ends.** A Retell chat agent ends its own exchange by
invoking its end tool; the invocation comes back among the completion's
messages, so the signal is in-band and free. The alternative — reading
``chat_status`` after every completion — would add a round trip to every
turn, inside the very call whose duration the simulator reports as the
agent's response latency.
"""

from __future__ import annotations

import contextlib
import json
from typing import Any

import aiohttp

from ..client import UNREACHABLE
from . import (
    AgentReply,
    PlugError,
    ToolCall,
    named_version,
    quotable,
    rendered_variables,
)

DEFAULT_BASE_URL = "https://api.retellai.com"
"""Retell's own API, where a connection with no base URL is reached."""

END_TOOL_NAMES = frozenset({"end_call"})
"""What a Retell agent's ending tool invokes under: the built-in one, named
for voice and kept as-is for chat. An agent carrying no such tool never ends
an exchange itself, and the simulation's limits end it instead —
deliberately, and never as the agent failing."""

TIMEOUT_SECONDS = 60.0
"""The most one Retell call may take. Generous because a completion waits
on the agent's own model, and anything past it is a platform that has
stopped answering rather than one thinking."""

_KNOWN_KEYS = {"retellAgentId", "baseUrl"}

CREDENTIAL_KEYS = {"apiKey"}
"""Exactly what the control plane seals for a retell connection, whichever
way a simulation reaches one. Refused strictly, and for the same reason it
is refused there: a secret handed over that nothing reads was handed over
by mistake."""


class RetellChat:
    """One Retell chat, opened and conducted and ended, per instance."""

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
        # Retell mints its own chat id and that is what a report joins on,
        # so this plug has nothing to tell it about the simulation. egma
        # is not in this agent's tool path either — a chat over somebody
        # else's platform has no room to stand in — so its record honestly
        # claims nothing about tools. Retell carries its own audio, so the
        # deployment's carrier is nothing to it either, and it dispatches
        # no worker, so a test's job dispatch metadata has nowhere to go.
        del simulation_id, mock_tools, media, job_dispatch_metadata

        if access_variant != "retell_chat_api.api_key":
            raise PlugError(
                "the retell chat adapter does not support access variant "
                f"{access_variant!r}"
            )

        if modality != "chat":
            raise PlugError(
                f"the retell chat plug speaks chat only; a {modality!r} "
                "simulation over retell needs the plug carrying the speech legs"
            )

        unknown = set(config) - _KNOWN_KEYS
        if unknown:
            raise PlugError(
                f"the retell plug does not know config key(s) {sorted(unknown)}; "
                f"it knows {sorted(_KNOWN_KEYS)}"
            )

        agent_id = config.get("retellAgentId")
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise PlugError(
                "retell config: retellAgentId must be a non-empty string"
            )

        base_url = config.get("baseUrl", DEFAULT_BASE_URL)
        if not isinstance(base_url, str) or not base_url.strip():
            raise PlugError("retell config: baseUrl must be a non-empty string")

        if not isinstance(credentials, dict):
            raise PlugError(
                "a retell connection needs credentials shaped {apiKey}"
            )
        stray = set(credentials) - CREDENTIAL_KEYS
        if stray:
            raise PlugError(
                f"retell credentials hold no key(s) {sorted(stray)}; they are "
                "shaped {apiKey}"
            )
        api_key = credentials.get("apiKey")
        if not isinstance(api_key, str) or not api_key.strip():
            raise PlugError("retell credentials: apiKey must be a non-empty string")

        self._agent_id = agent_id.strip()
        self._base_url = base_url.strip().rstrip("/")
        self._api_key = api_key.strip()
        self._agent_version = named_version(agent_version)
        self._dynamic_variables = rendered_variables(dynamic_variables)
        self._timeout = aiohttp.ClientTimeout(total=TIMEOUT_SECONDS)
        self._session: aiohttp.ClientSession | None = None
        self._chat_id: str | None = None

    @property
    def base_url(self) -> str:
        """Where this exchange is conducted — the URL every refusal names."""
        return self._base_url

    @property
    def provider_reference(self) -> str | None:
        """Retell's own id for this chat, once there is one to hold it by."""
        return self._chat_id

    async def open(self) -> str | None:
        self._session = aiohttp.ClientSession()
        opened = await self._call("POST", "/create-chat", self._opening())
        chat_id = opened.get("chat_id")
        if not isinstance(chat_id, str) or not chat_id:
            raise PlugError("retell opened a chat with no chat_id to hold it by")
        self._chat_id = chat_id
        # Retell answers create-chat with the chat as it stands, so an agent
        # configured to speak first has already spoken by then.
        return _agent_words(opened.get("message_with_tool_calls"))

    async def deliver(self, text: str) -> AgentReply:
        if self._chat_id is None:
            raise PlugError("a turn reached the retell plug before the chat opened")
        completion = await self._call(
            "POST",
            "/create-chat-completion",
            {"chat_id": self._chat_id, "content": text},
        )
        messages = completion.get("messages")
        if not isinstance(messages, list):
            raise PlugError("retell answered a completion with no messages list")
        return AgentReply(
            text=_agent_words(messages),
            ended=_ended(messages),
            tool_calls=_tool_calls(messages),
        )

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is None:
            return
        try:
            if self._chat_id is not None:
                # The exchange is over either way: a chat the agent already
                # ended refuses this, and a platform that cannot be reached
                # to be told has nothing left to be told. Neither is worth
                # raising over teardown.
                with contextlib.suppress(*UNREACHABLE):
                    async with session.patch(
                        f"{self._base_url}/end-chat/{self._chat_id}",
                        headers=self._headers(),
                        timeout=self._timeout,
                    ):
                        pass
        finally:
            await session.close()

    def _opening(self) -> dict[str, Any]:
        """The one request that opens the exchange.

        Which agent, and — only where the spec said so — which version of it
        and what this simulation is conducted with. Absent stays absent: a
        version Retell was not asked for is a version it chooses itself, and
        an empty variable block is not the same as none, because Retell
        renders what it is given.
        """
        opening: dict = {"agent_id": self._agent_id}
        if self._agent_version is not None:
            opening["agent_version"] = self._agent_version
        if self._dynamic_variables:
            opening["retell_llm_dynamic_variables"] = self._dynamic_variables
        return opening

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._api_key}"}

    async def _call(self, method: str, path: str, payload: dict) -> dict:
        """One Retell call, or a refusal saying what happened without the key."""
        session = self._session
        if session is None:
            raise PlugError("the retell plug was used outside its own lifecycle")

        url = f"{self._base_url}{path}"
        try:
            async with session.request(
                method,
                url,
                json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            ) as response:
                status = response.status
                body = await response.text()
        except UNREACHABLE as unreachable:
            raise PlugError(
                f"retell was unreachable at {url}: "
                f"{quotable(repr(unreachable), self._api_key)}"
            ) from unreachable

        if status // 100 != 2:
            raise PlugError(
                f"retell answered {status} to {path} at {self._base_url}: "
                f"{quotable(body, self._api_key)}"
            )
        try:
            document = json.loads(body)
        except ValueError as unreadable:
            raise PlugError(
                f"retell answered {path} with something that is not JSON"
            ) from unreadable
        if not isinstance(document, dict):
            raise PlugError(
                f"retell answered {path} with {type(document).__name__}, "
                "not an object"
            )
        return document


def _agent_words(messages: object) -> str | None:
    """What the agent said, out of everything one answer carried.

    An answer holds the agent's messages and its tool traffic together, so
    the words are the ``agent`` role's contents in order; two bubbles for
    one turn stay one turn. ``None`` when the agent produced no words at
    all, which the conversation loop records as an answer without words rather than as
    silence in the transcript.
    """
    if not isinstance(messages, list):
        return None
    spoken = [
        message["content"].strip()
        for message in messages
        if isinstance(message, dict)
        and message.get("role") == "agent"
        and isinstance(message.get("content"), str)
        and message["content"].strip()
    ]
    return "\n".join(spoken) or None


def _ended(messages: list) -> bool:
    """Whether the agent ended the exchange with this answer."""
    return any(
        _invocation(message) is not None
        and message.get("name") in END_TOOL_NAMES
        for message in messages
    )


def _tool_calls(messages: list) -> tuple[ToolCall, ...]:
    """The tools the agent called while producing this answer.

    Retell reports its invocations inline with the agent's words, which
    makes it one of the few platforms where a tool call is observable from
    egma's side at all. What is kept is exactly what it said — the name,
    and the arguments as the bytes they arrived as — and never the return,
    which Retell reports separately and this plug does not read: the
    conversation is what egma observes, and inventing the other half of a
    call would poison every comparison across platforms.

    The ending tool is not filtered out. It is a tool the agent called, and
    the record of the conversation says so; that it *also* ends the
    exchange is a separate reading of the same fact.
    """
    return tuple(
        ToolCall(name=name, arguments=_arguments(message))
        for message in messages
        if _invocation(message) is not None
        and isinstance(name := message.get("name"), str)
        and name
    )


def _invocation(message: object) -> dict | None:
    """One message, if it is Retell reporting a tool being called."""
    if isinstance(message, dict) and message.get("role") == "tool_call_invocation":
        return message
    return None


def _arguments(message: dict) -> str | None:
    """The arguments as observed: Retell sends them JSON-encoded already."""
    arguments = message.get("arguments")
    return arguments if isinstance(arguments, str) and arguments else None
