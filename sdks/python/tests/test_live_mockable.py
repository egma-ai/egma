"""One real interception, in a real room — opt-in.

Everything else about this SDK is proved against a room-shaped stand-in,
which says the SDK's own reasoning is right and nothing at all about
whether the substitution still *works*. This file is the other half, and
it is the reason the dependency is pinned.

The mechanism is LiveKit's own ``mock_tools``, which sits in the
framework's testing namespace with no stability promise. A minor release
could move it, rename it, or change where the tool executor looks — and
every one of those failures is silent from the outside: the agent would
simply run its real tool during a simulation, book the real appointment,
and nothing would say so. So the pin holds the version still, and this
test is what says the mechanism is still there before the pin is raised.

## What is real here

The room, the session, the wire, and the interception. A room is made in
a real LiveKit project; a participant joins it under egma's name and
registers the two methods of the exchange; the agent joins it, is made
mockable, and is started with a real ``session.start(room=…)``; a real
model is asked a question and calls the tool.

What is asserted is exactly what cannot be asserted offline:

- the census really travelled the wire and was answered,
- a real tool call reached the courier and went out as ``egma.tool``,
- and **the real implementation never ran**. That last one is the whole
  test: it is the assertion that fails, loudly, the day the framework
  stops honouring the side table.

It is opt-in because CI holds no LiveKit project, and it skips —
visibly, never failing, never waiting on anybody::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_MODEL_API_KEY=... \\
    uv run pytest tests/test_live_mockable.py -v

Each name falls back to the plain one LiveKit's and OpenAI's own tooling
reads — ``LIVEKIT_URL``, ``LIVEKIT_API_KEY``, ``LIVEKIT_API_SECRET``,
``OPENAI_API_KEY`` — so one environment serves this and the agent it is
run beside, and nobody keeps two copies of a project's coordinates.

The model is asked with tool calling forced, because what is under test
is the interception rather than a model's willingness to reach for a
tool. A run that failed because a model chose to chat would say nothing
about the pin, which is the only question this file asks.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Coroutine

import pytest
from livekit import api, rtc
from livekit.agents import (
    Agent,
    AgentSession,
    RoomInputOptions,
    RoomOutputOptions,
    function_tool,
)
from livekit.plugins import openai

from egma import mockable, seam


def credential(*names: str) -> str:
    """The first of these environment variables that carries a value.

    The opt-in tests read a ``TEST_``-prefixed name first, so a machine
    can keep the credentials it tests with apart from the ones it works
    with, and fall back to the tool's own plain name.
    """
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "LIVEKIT_URL")
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")
MODEL_NAME = credential("TEST_MODEL_NAME") or "gpt-4o-mini"

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_MODEL_API_KEY": MODEL_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)

pytestmark = pytest.mark.skipif(
    bool(MISSING),
    reason=(
        "no live LiveKit project: set "
        + ", ".join(MISSING)
        + " to prove that LiveKit still honours the side table this SDK "
        "registers couriers in, on a real session in a real room"
    ),
)

EGMA_IDENTITY = "egma-persona"
AGENT_IDENTITY = "agent-under-test"
A_SIMULATION = "sim-sdk-live-0001"

MOCKED_ANSWER = "There is nothing free on Tuesday."

# A live run pays real seconds against a real server and a real model.
# This proves the path works, not that a model can talk all day.
WITHIN_SECONDS = 90

really_ran = False
"""Set by the real implementation if it ever runs, which it must not.

A module-level flag rather than a return value, because the point is not
what the model was told — it is whether the customer's own code was
executed at all. In a simulation, that difference is a real appointment.
"""


class ReceptionAgent(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are the front desk at a dental practice. When asked "
                "about availability, use your tools."
            )
        )

    @function_tool
    async def check_calendar(self, day: str) -> str:
        """Look up free slots on a day.

        Args:
            day: The day to look at.
        """
        global really_ran
        really_ran = True
        return "The real calendar was read, which must not happen in a test."


class EgmaInTheRoom:
    """egma's participant: the two methods, and what they were asked.

    Small on purpose. What this stands in for is a participant that
    registers the exchange and answers it — the same two method names
    and the same message shapes the real thing serves — so what this
    test proves about the wire is proved about the wire, not about a
    particular server.
    """

    def __init__(self) -> None:
        self.room = rtc.Room()
        self.asked: list[tuple[str, dict]] = []

    async def join(self, room_name: str) -> None:
        # Connected first, then the methods. A room has no local
        # participant to register anything on until it is in one — and
        # egma's own driver registers in this same order, the moment the
        # room is joined, which is still before the agent's worker is
        # asked for and so still before any census could arrive.
        await self.room.connect(LIVEKIT_URL, _token(room_name, EGMA_IDENTITY))
        self.room.local_participant.register_rpc_method(
            seam.HELLO_METHOD, self._hello
        )
        self.room.local_participant.register_rpc_method(seam.TOOL_METHOD, self._tool)

    async def _hello(self, invocation: rtc.RpcInvocationData) -> str:
        self.asked.append((seam.HELLO_METHOD, json.loads(invocation.payload)))
        return json.dumps(
            {
                "protocol_version": seam.PROTOCOL_VERSION,
                "mocked_tools": ["check_calendar"],
            }
        )

    async def _tool(self, invocation: rtc.RpcInvocationData) -> str:
        self.asked.append((seam.TOOL_METHOD, json.loads(invocation.payload)))
        return json.dumps({"answer": MOCKED_ANSWER})

    def asked_for(self, method: str) -> list[dict]:
        return [body for said, body in self.asked if said == method]


class LiveContext:
    """A job context, down to the two things the SDK reads of one."""

    def __init__(self, room: rtc.Room, metadata: str) -> None:
        self.room = room
        self.job = type("Job", (), {"metadata": metadata})()


def _token(room_name: str, identity: str) -> str:
    return (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )


async def _each(*teardowns: Coroutine) -> None:
    """Run all of them, and let none of them stop the rest.

    What each one failed at is said out loud rather than raised, so a
    room that could not be deleted is visible without becoming the
    failure this test reports.
    """
    for teardown in teardowns:
        try:
            await teardown
        except Exception as failed:  # noqa: BLE001
            print(f"teardown step did not finish: {failed}")


def _metadata() -> str:
    """The dispatch metadata egma really sends, byte for byte in shape."""
    return json.dumps(
        {
            "simulationId": A_SIMULATION,
            "modality": "voice",
            "egmaIdentity": EGMA_IDENTITY,
            "protocolVersion": seam.PROTOCOL_VERSION,
        },
        separators=(",", ":"),
    )


@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_livekit_still_honours_the_couriers_this_sdk_registers():
    global really_ran
    really_ran = False

    room_name = f"egma-sdk-live-{uuid.uuid4().hex}"
    lkapi = api.LiveKitAPI(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    egma = EgmaInTheRoom()
    agent_room = rtc.Room()
    session = AgentSession(
        # Forced, because what is under test is the interception rather
        # than a model's willingness to reach for a tool — and stopped
        # after one step, because a model told it must always call a tool
        # would otherwise keep calling this one.
        llm=openai.LLM(
            model=MODEL_NAME, api_key=MODEL_API_KEY, tool_choice="required"
        ),
        max_tool_steps=1,
    )

    try:
        await lkapi.room.create_room(api.CreateRoomRequest(name=room_name))
        # egma first, and that ordering is the real one: the participant
        # registers the exchange before the agent's worker is dispatched,
        # so a census sent at session start always has somebody to reach.
        await egma.join(room_name)
        await agent_room.connect(LIVEKIT_URL, _token(room_name, AGENT_IDENTITY))

        agent = ReceptionAgent()
        await mockable(agent, LiveContext(agent_room, _metadata()), session)

        # The census really travelled a wire and really came back.
        census = egma.asked_for(seam.HELLO_METHOD)
        assert len(census) == 1, "the census was not sent exactly once"
        assert [tool["name"] for tool in census[0]["tools"]] == ["check_calendar"]

        await session.start(
            agent=agent,
            room=agent_room,
            room_input_options=RoomInputOptions(
                audio_enabled=False, text_enabled=True
            ),
            room_output_options=RoomOutputOptions(audio_enabled=False),
        )

        await asyncio.wait_for(
            session.run(user_input="Do you have anything free on Tuesday?"),
            timeout=WITHIN_SECONDS,
        )
    finally:
        # Every one of them, whatever the others did. A teardown that
        # stopped at the first failure would leave a room standing in
        # somebody's project and an HTTP session open — and would report
        # the teardown's own complaint in place of whatever really went
        # wrong above it.
        await _each(
            session.aclose(),
            agent_room.disconnect(),
            egma.room.disconnect(),
            lkapi.room.delete_room(api.DeleteRoomRequest(room=room_name)),
            lkapi.aclose(),
        )

    # The call reached egma over the room, with the arguments the model
    # sent — which is the copied signature surviving the framework's own
    # trimming, on the real path this time.
    calls = egma.asked_for(seam.TOOL_METHOD)
    assert calls, "no tool call reached egma; the courier was never consulted"
    assert calls[0]["name"] == "check_calendar"
    assert "day" in calls[0].get("arguments", {})

    # And the assertion this whole file exists for. If the framework ever
    # stops honouring the side table, this is the line that says so.
    assert not really_ran, (
        "the agent's real tool ran during a mocked call: LiveKit no longer "
        "honours the side table mock_tools writes into, so the pin in "
        "pyproject.toml is holding a version that cannot do the job"
    )
