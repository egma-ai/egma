"""What every test here builds from, and the one place LiveKit's own
internals are read.

The agents below are real :class:`~livekit.agents.Agent` subclasses with
real ``@function_tool`` methods, because the SDK reads its census off a
real agent object and a hand-rolled shape would prove the shape rather
than the reading.

## Reading the side table on purpose

``mock_tools`` writes into a table LiveKit keeps privately, and the same
table is what the framework's tool dispatch consults per call. So the
only way to say "a courier is standing in front of exactly these names,
and it answers a call the way the framework would deliver one" without a
LiveKit server is to read that table and call through the framework's own
argument trimming.

Both are private names, and reaching for them is deliberate. This package
pins ``livekit-agents`` to one minor precisely because the substitution
mechanism carries no stability promise — and a failing import here is
that pin's tripwire firing, at test time, on the developer's machine,
which is exactly where it should fire.
"""

from __future__ import annotations

from typing import Any

import pytest
from livekit.agents import Agent, AgentSession, function_tool

# LiveKit's own, read on purpose: see the module docstring.
from livekit.agents.voice.run_result import (  # noqa: PLC2701
    _run_mock,
    _SessionMockTools,
)
from room_stub import StubContext, StubRoom, egma_metadata


class ReceptionAgent(Agent):
    """A small agent with two tools: one Egma will answer for, one it
    will not, so every test can say what happened to each."""

    def __init__(self) -> None:
        super().__init__(instructions="You are a dental receptionist.")

    @function_tool
    async def check_calendar(self, day: str, party_size: int = 1) -> str:
        """Look up free slots on a day.

        Args:
            day: The day to look at.
            party_size: How many people are coming.
        """
        return f"really ran: {day} for {party_size}"

    @function_tool
    async def read_notice(self) -> str:
        """Read the practice's notice of the day."""
        return "really ran: the notice"


class ToollessAgent(Agent):
    """An agent with nothing to mock, for the census that reports none."""

    def __init__(self) -> None:
        super().__init__(instructions="You answer the phone and nothing else.")


@pytest.fixture
async def session() -> AgentSession:
    """A session object, which is the key the side table is written under.

    Never started: what the SDK does with a session is hand it to
    ``mock_tools`` as an identity, and starting one would need a model,
    a microphone and a room. Built inside the loop because a session
    reaches for the running one as it is created.
    """
    return AgentSession()


def in_a_simulation(room: StubRoom, **metadata: Any) -> StubContext:
    """A job dispatched by Egma into that room."""
    return StubContext(room, egma_metadata(**metadata))


def couriers_on(session: AgentSession, agent: Agent) -> dict[str, Any]:
    """What is standing in front of this agent's tools, by name.

    Read straight off LiveKit's own side table — the very table its tool
    dispatch consults — so "registered" here means registered where it
    counts, not where the SDK says it put something.
    """
    return dict(_SessionMockTools.get(session, {}).get(type(agent), {}))


async def called(courier: Any, *args: Any, **kwargs: Any) -> Any:
    """Call a courier the way the framework delivers a call to one.

    Through LiveKit's own trimming, which is the thing that hands a mock
    only the parameters it declares — and therefore the thing that makes
    the copied signature matter at all. A test that called the courier
    directly would pass whatever it liked and prove nothing about it.
    """
    return await _run_mock(courier, *args, **kwargs)
