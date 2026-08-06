"""CI's Retell: a local HTTP server shaped like Retell's chat API.

Three endpoints, the ones the plug speaks — ``create-chat``,
``create-chat-completion``, ``end-chat`` — answering with Retell's own
field names, status codes and bearer-key auth, from a script. Real HTTP on
a loopback port, because the plug's whole job is speaking a platform's wire
protocol and a mock of that protocol would prove the mock instead.

The stub is deliberately strict where the real platform is: a request
without the exact bearer key is refused 401, a completion for a chat that
was never opened is refused 422, and a chat that has ended refuses further
completions. Those refusals are what the plug's failure paths are tested
against.

It also records every call it served, so a test can assert the plug drove
the whole session lifecycle — opened once, delivered in order, ended at the
platform — rather than only that a transcript came out.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from aiohttp import web

END_TOOL = "end_call"
"""The tool a Retell chat agent invokes to end its own exchange."""


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class RetellStub:
    """One scripted Retell account: an agent, a key, and what it says."""

    api_key: str = "stub-key-not-a-real-secret"
    greeting: str | None = None
    """Spoken on ``create-chat``, the way a chat agent with a begin message
    has already spoken by the time the answer arrives."""

    replies: Sequence[str | Sequence[str]] = ()
    """The agent's answers, in order, one per delivered turn. An answer
    written as a list of strings comes back as several messages in one
    completion, the way an agent that sends two bubbles for one turn does."""

    ends_after_replies: bool = False
    """When true the last scripted reply carries the end-tool invocation,
    the way an agent ending its own exchange does."""

    turn_seconds: float = 0.0
    """How long a completion takes, the way a real agent takes time."""

    echo_key_in_refusal: bool = False
    """When true, a refused request comes back quoting the key it was given.

    Careless platforms do this, and a plug quoting a platform's own words
    into a failure reason is how a secret reaches a log it was never meant
    to reach. Nothing here can stop a platform doing it; the plug is what
    has to survive it."""

    calls: list[dict] = field(default_factory=list)
    """Every request served, in order — the session lifecycle on the record."""

    chats: dict[str, dict] = field(default_factory=dict)

    def delivered(self) -> list[str]:
        return [
            call["content"]
            for call in self.calls
            if call["endpoint"] == "create-chat-completion"
        ]

    def ended(self) -> list[str]:
        return [
            call["chat_id"] for call in self.calls if call["endpoint"] == "end-chat"
        ]

    def chat_ids(self) -> list[str]:
        return list(self.chats)

    def _authorized(self, request: web.Request) -> None:
        offered = request.headers.get("Authorization", "")
        if offered != f"Bearer {self.api_key}":
            told = offered if self.echo_key_in_refusal else ""
            raise web.HTTPUnauthorized(
                text=json.dumps({"error_message": f"invalid api key {told}".strip()}),
                content_type="application/json",
            )

    def _message(self, role: str, content: str) -> dict:
        return {
            "message_id": f"msg_{len(self.calls)}_{role}",
            "role": role,
            "content": content,
            "created_timestamp": _now_ms(),
        }

    async def _create_chat(self, request: web.Request) -> web.Response:
        self._authorized(request)
        body = await request.json()
        agent_id = body.get("agent_id")
        if not isinstance(agent_id, str) or not agent_id:
            raise web.HTTPUnprocessableEntity(text="agent_id is required")

        chat_id = f"chat_{len(self.chats) + 1:04d}"
        self.chats[chat_id] = {"agent_id": agent_id, "delivered": 0, "ended": False}
        self.calls.append(
            {"endpoint": "create-chat", "agent_id": agent_id, "chat_id": chat_id}
        )
        opening = [self._message("agent", self.greeting)] if self.greeting else []
        return web.json_response(
            {
                "chat_id": chat_id,
                "agent_id": agent_id,
                "chat_status": "ongoing",
                "chat_type": "api_chat",
                "start_timestamp": _now_ms(),
                "transcript": self.greeting or "",
                "message_with_tool_calls": opening,
            },
            status=201,
        )

    async def _create_chat_completion(self, request: web.Request) -> web.Response:
        self._authorized(request)
        body = await request.json()
        chat_id = body.get("chat_id")
        content = body.get("content")
        chat = self.chats.get(chat_id) if isinstance(chat_id, str) else None
        if chat is None:
            raise web.HTTPUnprocessableEntity(text="chat not found")
        if chat["ended"]:
            raise web.HTTPUnprocessableEntity(text="chat is not ongoing")
        if not isinstance(content, str) or not content:
            raise web.HTTPUnprocessableEntity(text="content is required")

        self.calls.append(
            {
                "endpoint": "create-chat-completion",
                "chat_id": chat_id,
                "content": content,
            }
        )
        if self.turn_seconds:
            await asyncio.sleep(self.turn_seconds)

        position = chat["delivered"]
        chat["delivered"] += 1
        messages: list[dict] = []
        if position < len(self.replies):
            answer = self.replies[position]
            bubbles = [answer] if isinstance(answer, str) else list(answer)
            messages.extend(self._message("agent", bubble) for bubble in bubbles)
            last = position == len(self.replies) - 1
            if last and self.ends_after_replies:
                messages.append(
                    {
                        "message_id": f"msg_{len(self.calls)}_tool",
                        "role": "tool_call_invocation",
                        "tool_call_id": f"tool_{position}",
                        "name": END_TOOL,
                        "arguments": "{}",
                        "created_timestamp": _now_ms(),
                    }
                )
                chat["ended"] = True
        else:
            messages.append(self._message("agent", "Still here."))
        return web.json_response({"messages": messages}, status=201)

    async def _get_chat(self, request: web.Request) -> web.Response:
        """Not a path the plug takes — the plug reads endings in-band — but
        the one the live test uses to ask the platform whether the chat was
        really ended, so that test can be rehearsed against this stub before
        it is pointed at a real account."""
        self._authorized(request)
        chat_id = request.match_info["chat_id"]
        chat = self.chats.get(chat_id)
        if chat is None:
            raise web.HTTPUnprocessableEntity(text="chat not found")
        return web.json_response(
            {
                "chat_id": chat_id,
                "agent_id": chat["agent_id"],
                "chat_status": "ended" if chat["ended"] else "ongoing",
                "chat_type": "api_chat",
            }
        )

    async def _end_chat(self, request: web.Request) -> web.Response:
        self._authorized(request)
        chat_id = request.match_info["chat_id"]
        if chat_id not in self.chats:
            raise web.HTTPUnprocessableEntity(text="chat not found")
        self.chats[chat_id]["ended"] = True
        self.calls.append({"endpoint": "end-chat", "chat_id": chat_id})
        return web.Response(status=204)

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_post("/create-chat", self._create_chat)
        app.router.add_post("/create-chat-completion", self._create_chat_completion)
        app.router.add_get("/get-chat/{chat_id}", self._get_chat)
        app.router.add_patch("/end-chat/{chat_id}", self._end_chat)
        return app


@dataclass
class RunningStub:
    """A stub on a loopback port, and the base URL a spec points at."""

    base_url: str
    stub: RetellStub


@asynccontextmanager
async def serving(stub: RetellStub) -> AsyncIterator[RunningStub]:
    """Serve one stub on an ephemeral loopback port for the test's life."""
    runner = web.AppRunner(stub.build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield RunningStub(f"http://127.0.0.1:{runner.addresses[0][1]}", stub)
    finally:
        await runner.cleanup()
