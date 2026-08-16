"""This agent is the same agent whether or not Egma exists.

The SDK proves inertness about itself, against agents it wrote for the
purpose. This file proves it about **this** agent — the one with the
integration line really in it, in the place a customer would put it — and
that is a different claim: a wiring mistake here would leave the SDK's own
suite green and this fixture changed.

Nothing here needs a room, a model or a key. A production room is a room
with no Egma named in its dispatch metadata, and that is a string, so the
whole property is testable on a laptop with the network unplugged.
"""

from __future__ import annotations

import pytest
from conftest import outside_egma
from egma import mockable

from agent import AFTERNOON_SLOT, MORNING_SLOT, FrontDesk

NO_EGMA = [
    pytest.param("", id="no metadata at all"),
    pytest.param("   ", id="metadata of blanks"),
    pytest.param(
        '{"tenant":"maple-street","shift":"mornings"}', id="the practice's own"
    ),
    pytest.param("not json at all", id="metadata that is not json"),
]


@pytest.mark.parametrize("metadata", NO_EGMA)
async def test_a_room_with_no_egma_in_it_leaves_this_agent_alone(metadata, session):
    agent = FrontDesk()
    before = agent.tools
    context = outside_egma(metadata)

    await mockable(agent, context, session)

    # The very same objects. Not equal, not equivalent — the identical
    # callables this file built the agent with, which is the only claim
    # that rules out something standing quietly in the path.
    after = agent.tools
    assert len(after) == len(before)
    assert all(now is then for now, then in zip(after, before, strict=True))

    # And not one word said, which is the assertion that carries this
    # test. An SDK that discovered Egma's absence by *asking* would cost
    # every production session a round trip before it could greet
    # anybody — and the substitution it installs afterwards is written
    # into a side table rather than onto the agent, so the objects above
    # would still be the same ones. The room in this test would answer
    # such a call happily. This empty list is what says none was made.
    assert context.room.asked == []


async def test_the_tools_still_answer_out_of_this_file(session):
    """The two answers a caller gets when nobody is mocking anything.

    Both are written into ``agent.py`` and neither reads a clock, a
    network or a disk — so this agent can be left running against a real
    LiveKit project without booking anything, and an unmocked live run
    says the same thing twice.
    """
    agent = FrontDesk()
    await mockable(agent, outside_egma(), session)

    said = await agent.check_availability("Tuesday")
    assert said == await agent.check_availability("Tuesday")
    assert MORNING_SLOT in said and AFTERNOON_SLOT in said
    assert "Tuesday" in said

    hours = await agent.opening_hours()
    assert hours == await agent.opening_hours()
    assert "8am to 6pm" in hours
