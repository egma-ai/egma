"""CI's Retell text mode: a local HTTP server shaped like the completion API.

The one endpoint the text-mode plug speaks — Retell's agent-text-mode
completion — answering with Retell's own field names, status codes and
bearer-key auth, from a script. Real HTTP on a loopback port, because a
plug's whole job is speaking a platform's wire protocol and a mock of that
protocol would prove the mock instead.

It is a **stateless** counterpart, exactly as the API it stands in for is:
it keeps no conversation. Every request carries the whole history, the
mocks to serve, and where the engine had got to; every reply carries only
what is new. So this server holds a script and a log, and nothing that
would let the plug get away with sending less than it must.

Two behaviours here are the platform's rather than the script's, and they
are what the plug is really proved against:

- **The mocks are matched and served here.** A scripted tool call is
  answered with the request's own mock for that name where one rode along,
  and with the script's real return value where none did. A plug that
  forgot to send the mocks would therefore see real answers come back, and
  the record would say so.
- **The version is never defaulted.** The request's ``agent_version`` is
  logged verbatim, absent included, so a test can say what the plug asked
  for and — just as much — what it did not.

Its refusals are the platform's too: a request without the exact bearer key
is refused 401, a request naming no agent is refused 422, and the scripted
``refusals`` play a throttle or a billing wall in front of a working
account. Those are what the plug's failure paths are tested against.

**Every field name here is a guess where Retell's documentation was not in
reach**, marked in :mod:`egma_simulator.plugs.retell_text_mode` where the
plug names the same field. The two are wrong together or right together,
which is the point: one live run against the real platform corrects both.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import unquote

from aiohttp import web

COMPLETION_ROUTE = "/agent-playground-completion/{agent_id}"
"""Where the completion answers, in aiohttp's own routing spelling."""


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class ToolTurn:
    """One tool the scripted agent calls while producing an answer."""

    name: str
    arguments: str | None = None
    real_result: str = '{"ok":true,"from":"the real backend"}'
    """What comes back when **no** mock rode the request for this name —
    the customer's own implementation running, which is what an uncovered
    tool does on this lane."""


@dataclass(frozen=True)
class Reply:
    """One scripted exchange: what the agent does with one request."""

    words: str | Sequence[str] | None = None
    """What it says. A list is several messages in one reply, the way an
    agent that sends two bubbles for one turn does."""

    tools: Sequence[ToolTurn] = ()
    """The tools it calls while producing the words."""

    node: str | None = None
    """The conversation-flow node it moved to, if it moved."""

    component: str | None = None
    """The flow component it moved into, where the flow names one."""

    state: str | None = None
    """The Retell-LLM state it moved to, if it moved."""

    variables: dict | None = None
    """The dynamic variables the reply names. Whether a real reply names
    all of them or only the ones that changed is not documented anywhere,
    so a script can play either."""

    variables_key: str = "retell_llm_dynamic_variables"
    """Which name the reply carries them under. The plug reads two, and
    this is how the second one is exercised."""

    ends: bool = False
    """Whether the agent ended the exchange with this answer."""

    extra: Sequence[dict] = ()
    """Messages in roles nobody here has to understand — a transition
    announcement, an SMS leg, whatever a newer platform grows. They ride
    the reply verbatim, which is what the plug's preservation rule is
    proved against."""

    seconds: float = 0.0
    """How long this exchange takes, the way a real agent takes time."""


@dataclass
class TextModeStub:
    """One scripted Retell account: an agent, a key, and what it does."""

    api_key: str = "stub-key-not-a-real-secret"

    replies: Sequence[Reply] = ()
    """The agent's exchanges, in order. The first is the **opening** — the
    request that carries an empty history — so a script whose first reply
    says nothing is an agent that lets the persona open."""

    refusals: Sequence[int] = ()
    """A status per leading request, consumed in order: 429 for a throttle,
    402 for a billing wall. A request past the end of this list is answered
    from the script, which is how "retries and then succeeds" is written."""

    echo_key_in_refusal: bool = False
    """When true, a refused request comes back quoting the key it was given.

    Careless platforms do this, and a plug quoting a platform's own words
    into a failure reason is how a secret reaches a log it was never meant
    to reach. Nothing here can stop a platform doing it; the plug is what
    has to survive it."""

    answers_without_messages: bool = False
    """A 2xx reply with no message list at all — the shape a plug must
    refuse rather than read as an agent that said nothing."""

    ignores_tool_mocks: bool = False
    """The failure the whole native-mock design rests on not happening: a
    platform that does not know the ``tool_mocks`` field, ignores it the
    way JSON APIs commonly do, and runs the customer's real tool instead.
    Nothing on the wire says it happened — the reply looks ordinary — so
    the only evidence is that the tool was given something else."""

    retry_after: str | None = None
    """What a throttling reply asks for in its ``Retry-After`` header."""

    requests: list[dict] = field(default_factory=list)
    """Every request served, in order, with its whole body — the exchange
    from the platform's own side."""

    _answered: int = 0
    """How many exchanges the script has really played, which is what walks
    it — a request this server refused is one the agent never saw."""

    def histories(self) -> list[list[dict]]:
        """The message history each request carried, in order."""
        return [request["body"].get("messages", []) for request in self.requests]

    def mocks(self) -> list[list[dict]]:
        """The native mocks each request carried, in order."""
        return [request["body"].get("tool_mocks", []) for request in self.requests]

    def delivered(self) -> list[str]:
        """What the persona said, read off the histories the way the
        platform sees it: the last message of each request that ends with
        one from the user."""
        spoken = []
        for history in self.histories():
            if history and history[-1].get("role") == "user":
                spoken.append(history[-1].get("content"))
        return spoken

    def _authorized(self, request: web.Request) -> None:
        offered = request.headers.get("Authorization", "")
        if offered != f"Bearer {self.api_key}":
            told = offered if self.echo_key_in_refusal else ""
            raise web.HTTPUnauthorized(
                text=json.dumps({"error_message": f"invalid api key {told}".strip()}),
                content_type="application/json",
            )

    def _message(self, role: str, content: str, index: int) -> dict:
        return {
            "message_id": f"msg_{len(self.requests)}_{index}_{role}",
            "role": role,
            "content": content,
            "created_timestamp": _now_ms(),
        }

    async def _completion(self, request: web.Request) -> web.Response:
        self._authorized(request)
        agent_id = unquote(request.match_info["agent_id"])
        body = await request.json()
        if not agent_id:
            raise web.HTTPUnprocessableEntity(text="agent_id is required")

        served = len(self.requests)
        # Recorded before any refusal, not after it: a request a platform
        # turned down is still a request it was asked, and a test that wants
        # to know whether egma really asked again has nowhere else to look.
        self.requests.append(
            {
                "agent_id": agent_id,
                "agent_version": body.get("agent_version"),
                "body": body,
            }
        )
        if served < len(self.refusals):
            told = f"key {self.api_key}" if self.echo_key_in_refusal else "no capacity"
            raise _refusal(self.refusals[served], told, self.retry_after)

        if body.get("messages") is None:
            raise web.HTTPUnprocessableEntity(text="messages is required")

        # The script is walked by the exchanges really conducted, not by the
        # requests made: a refused request is one the agent never saw, so a
        # throttle that lets up resumes the conversation rather than skipping
        # past the part of it nobody had yet.
        served = self._answered
        self._answered += 1
        reply = (
            self.replies[served]
            if served < len(self.replies)
            else Reply(words="Still here.")
        )
        if reply.seconds:
            await asyncio.sleep(reply.seconds)
        if self.answers_without_messages:
            return web.json_response({"agent_ended": False}, status=201)

        offered = (
            {}
            if self.ignores_tool_mocks
            else {
                mock.get("tool_name"): mock
                for mock in body.get("tool_mocks") or []
                if isinstance(mock, dict)
            }
        )
        messages: list[dict] = []
        for index, tool in enumerate(reply.tools):
            call_id = f"tool_call_{served}_{index}"
            messages.append(
                {
                    "message_id": f"msg_{served}_{index}_invocation",
                    "role": "tool_call_invocation",
                    "tool_call_id": call_id,
                    "name": tool.name,
                    "arguments": tool.arguments,
                    "created_timestamp": _now_ms(),
                }
            )
            # The whole point of the lane: a mock that rode the request is
            # matched by name and served, and anything else runs for real.
            mock = offered.get(tool.name)
            messages.append(
                {
                    "message_id": f"msg_{served}_{index}_result",
                    "role": "tool_call_result",
                    "tool_call_id": call_id,
                    "content": (
                        tool.real_result if mock is None else mock.get("output")
                    ),
                    "created_timestamp": _now_ms(),
                }
            )
        if reply.node or reply.state:
            moved = reply.node or reply.state
            messages.append(
                {
                    "message_id": f"msg_{served}_transition",
                    "role": "node_transition",
                    "content": f"moved to {moved}",
                    "created_timestamp": _now_ms(),
                }
            )
        messages.extend(reply.extra)
        if reply.words is not None:
            bubbles = (
                [reply.words] if isinstance(reply.words, str) else list(reply.words)
            )
            messages.extend(
                self._message("agent", bubble, index)
                for index, bubble in enumerate(bubbles)
            )

        answered: dict = {"messages": messages, "agent_ended": reply.ends}
        if reply.node is not None:
            answered["current_node_id"] = reply.node
        if reply.component is not None:
            answered["current_component_id"] = reply.component
        if reply.state is not None:
            answered["current_state"] = reply.state
        if reply.variables is not None:
            answered[reply.variables_key] = reply.variables
        return web.json_response(answered, status=201)

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_post(COMPLETION_ROUTE, self._completion)
        return app


def _refusal(
    status: int, told: str, retry_after: str | None = None
) -> web.HTTPException:
    """The platform saying no, in the status the script asked for."""
    body = json.dumps({"error_message": f"refused: {told}"})
    refusals = {
        402: web.HTTPPaymentRequired,
        429: web.HTTPTooManyRequests,
        500: web.HTTPInternalServerError,
    }
    return refusals.get(status, web.HTTPBadRequest)(
        text=body,
        content_type="application/json",
        headers=None if retry_after is None else {"Retry-After": retry_after},
    )


@dataclass
class RunningStub:
    """A stub on a loopback port, and the base URL a spec points at."""

    base_url: str
    stub: TextModeStub


@asynccontextmanager
async def serving(stub: TextModeStub) -> AsyncIterator[RunningStub]:
    """Serve one stub on an ephemeral loopback port for the test's life."""
    runner = web.AppRunner(stub.build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield RunningStub(f"http://127.0.0.1:{runner.addresses[0][1]}", stub)
    finally:
        await runner.cleanup()
