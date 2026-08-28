"""The room-name contract, held against a real LiveKit — and no account.

Every other suite here proves the SDK against a room-shaped fake, which is
the right default and says nothing about a real room. Two claims cannot be
settled that way, and both are load-bearing:

- **egma is found where it really is.** Addressing reads a room's own
  participant table, and a fake table is a fake answer.
- **the wait really ends.** Detection is the room's name, and the name is
  what lets this side wait for egma rather than conclude production. On
  two of the three dispatch paths the agent is in the room *first*, so the
  wait is not a nicety there — it is the whole reason those paths work.

So these run against a real server, and deliberately cost nothing to run:
the server is the one this repository deploys, started in its own dev mode
by the ``live_livekit`` fixture, and no conversation is ever held. No
speech, no model, no key. What is exercised is detection, addressing and
the exchange — all of the SDK a real LiveKit is in a position to
contradict.

The speaking half of a live simulation is a different proof with a
different price, and it lives in the simulator's own
``test_live_livekit_room.py``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from conftest import ReceptionAgent, called, couriers_on
from livekit import rtc

from egma import mockable, seam

pytestmark = pytest.mark.timeout(120)

EGMA_IDENTITY = "egma-persona"
"""What egma joins as, and the whole of what the SDK looks for. Named here
rather than imported so a rename in the SDK has to be made twice on
purpose — this is the published half of a cross-process contract."""

LATE_BY_SECONDS = 3.0
"""How far behind the agent egma is made to arrive.

Long enough that a SDK which did not wait would have given up and wrapped
nothing before egma was ever in the room, which is what makes this a test
of the wait rather than of a coincidence."""


class _Job:
    def __init__(self, room_name: str) -> None:
        self.room = _JobRoom(room_name)


class _JobRoom:
    def __init__(self, name: str) -> None:
        self.name = name


class _LiveContext:
    """A job context whose room is a real, connected LiveKit room.

    The two things ``mockable`` reads, and nothing invented beside them:
    the name the server gave this job, and the room this process is in.
    ``connect`` is here because the SDK will call it on a room that is not
    yet open; these tests hand it one that already is, so it never runs.
    """

    def __init__(self, room_name: str, room: rtc.Room) -> None:
        self.job = _Job(room_name)
        self.room = room

    async def connect(self) -> None:  # pragma: no cover - room is already open
        raise AssertionError("the room was already connected")


class _EgmaInTheRoom:
    """A real participant answering to egma's name, and the two methods.

    Stands in for the simulator's side of the exchange rather than for the
    room: what it answers is scripted, and everything about how the answer
    is asked for and carried is a real LiveKit's.
    """

    def __init__(self) -> None:
        self.room = rtc.Room()
        self.asked: list[tuple[str, Any]] = []
        self.answers_for: tuple[str, ...] = ()

    async def join(self, live: Any, room_name: str, answers_for: tuple[str, ...]):
        self.answers_for = answers_for
        await self.room.connect(live.url, live.token(room_name, EGMA_IDENTITY))

        async def hello(invocation: Any) -> str:
            self.asked.append((seam.HELLO_METHOD, json.loads(invocation.payload)))
            return json.dumps(
                {
                    "protocol_version": seam.PROTOCOL_VERSION,
                    "mocked_tools": list(self.answers_for),
                }
            )

        async def tool(invocation: Any) -> str:
            self.asked.append((seam.TOOL_METHOD, json.loads(invocation.payload)))
            return json.dumps({"answer": "egma answered this one"})

        self.room.local_participant.register_rpc_method(seam.HELLO_METHOD, hello)
        self.room.local_participant.register_rpc_method(seam.TOOL_METHOD, tool)
        return self

    async def leave(self) -> None:
        await self.room.disconnect()

    def census(self) -> dict[str, Any] | None:
        for method, payload in self.asked:
            if method == seam.HELLO_METHOD:
                return payload
        return None


async def _agent_joins(live: Any, room_name: str, identity: str = "the-agent"):
    room = rtc.Room()
    await room.connect(live.url, live.token(room_name, identity))
    return room


async def test_egma_already_in_the_room_is_found_and_answers(
    live_livekit: Any, session: Any
) -> None:
    """The named-dispatch order: egma is in the room before the agent.

    The whole exchange over a real room — the census egma really received,
    the courier really installed in LiveKit's own side table, and a call
    really answered by egma rather than by the tool.
    """
    room_name = "egma-sim-live-egma-first"
    egma = await _EgmaInTheRoom().join(live_livekit, room_name, ("check_calendar",))
    room = await _agent_joins(live_livekit, room_name)
    agent = ReceptionAgent()
    try:
        await mockable(agent, _LiveContext(room_name, room), session)

        assert egma.census() is not None, "the census never reached egma"
        reported = {tool["name"] for tool in egma.census()["tools"]}
        assert reported == {"check_calendar", "read_notice"}

        couriers = couriers_on(session, agent)
        assert set(couriers) == {"check_calendar"}
        assert await called(couriers["check_calendar"], day="Tuesday") == (
            "egma answered this one"
        )
    finally:
        await room.disconnect()
        await egma.leave()


async def test_the_agent_in_the_room_first_waits_for_egma(
    live_livekit: Any, session: Any
) -> None:
    """The order that made two of the three dispatch paths work.

    On both token-endpoint paths the worker is walked into the room as the
    room comes into existence, which is before egma has joined it. The
    room's name is what says to wait; this proves the waiting really ends
    when a real participant really arrives.
    """
    room_name = "egma-sim-live-agent-first"
    room = await _agent_joins(live_livekit, room_name)
    agent = ReceptionAgent()
    egma = _EgmaInTheRoom()

    async def arrive_late() -> None:
        await asyncio.sleep(LATE_BY_SECONDS)
        await egma.join(live_livekit, room_name, ("check_calendar",))

    late = asyncio.create_task(arrive_late())
    try:
        await mockable(agent, _LiveContext(room_name, room), session)

        assert egma.census() is not None, (
            "the SDK gave up before egma arrived, so nothing was wrapped — "
            "which is the failure the room-name contract exists to stop"
        )
        assert set(couriers_on(session, agent)) == {"check_calendar"}
    finally:
        await late
        await room.disconnect()
        await egma.leave()


async def test_a_production_room_is_left_alone(
    live_livekit: Any, session: Any
) -> None:
    """A room the customer named, in a real project: nothing is touched.

    The inertness suite proves this without a server. This proves the same
    thing where a server could have been asked and was not: egma is really
    in this room, under its own name, and the SDK still wraps nothing —
    because the room's name, not egma's presence, is what decides.
    """
    room_name = "acme-interview-4417"
    egma = await _EgmaInTheRoom().join(live_livekit, room_name, ("check_calendar",))
    room = await _agent_joins(live_livekit, room_name, identity="a-candidate")
    agent = ReceptionAgent()
    before = list(agent.tools)
    try:
        await mockable(agent, _LiveContext(room_name, room), session)

        assert egma.asked == [], "a production room asked egma something"
        assert couriers_on(session, agent) == {}
        after = list(agent.tools)
        assert len(before) == len(after)
        assert all(b is a for b, a in zip(before, after, strict=True))
    finally:
        await room.disconnect()
        await egma.leave()
