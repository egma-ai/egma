"""This agent is the same agent whether or not egma exists.

The SDK proves inertness about itself, against agents it wrote for the
purpose. This file proves it about **this** agent — the one with the
integration line really in it, in the place a customer would put it — and
that is a different claim: a wiring mistake here would leave the SDK's own
suite green and this fixture changed.

Nothing here needs a room, a model or a key. A production room is a room
egma did not name, and a room's name is a string, so the whole property is
testable on a laptop with the network unplugged.
"""

from __future__ import annotations

import pytest
from conftest import outside_egma
from egma import mockable

from agent import AFTERNOON_SLOT, MORNING_SLOT, FrontDesk

NOT_AN_EGMA_ROOM = [
    pytest.param("maple-street-front-desk", id="the practice's own room"),
    pytest.param("", id="no room name at all"),
    pytest.param("egma-simulator-demo", id="a name that merely starts alike"),
    pytest.param("call-egma-sim-0001", id="the prefix in the middle"),
]

THE_PRACTICE_S_OWN_METADATA = [
    pytest.param("", id="no metadata at all"),
    pytest.param("   ", id="metadata of blanks"),
    pytest.param(
        '{"tenant":"maple-street","shift":"mornings"}', id="the practice's own"
    ),
    pytest.param("not json at all", id="metadata that is not json"),
    pytest.param(
        '{"egmaIdentity":"egma-persona"}',
        id="the practice's own use of egma's key name",
    ),
]


@pytest.mark.parametrize("metadata", THE_PRACTICE_S_OWN_METADATA)
@pytest.mark.parametrize("room_name", NOT_AN_EGMA_ROOM)
async def test_a_room_egma_did_not_name_leaves_this_agent_alone(
    room_name, metadata, session
):
    agent = FrontDesk()
    before = agent.tools
    context = outside_egma(room_name, metadata)

    await mockable(agent, context, session)

    # The very same objects. Not equal, not equivalent — the identical
    # callables this file built the agent with, which is the only claim
    # that rules out something standing quietly in the path.
    after = agent.tools
    assert len(after) == len(before)
    assert all(now is then for now, then in zip(after, before, strict=True))

    # And not one word said, which is the assertion that carries this
    # test. An SDK that discovered egma's absence by *asking* would cost
    # every production session a round trip before it could greet
    # anybody — and the substitution it installs afterwards is written
    # into a side table rather than onto the agent, so the objects above
    # would still be the same ones. The room in this test has egma in it
    # and would answer such a call happily. This empty list is what says
    # none was made.
    assert context.room.asked == []
    # Nor was the room connected on egma's account. Where this agent
    # connects, it connects for its own reasons.
    assert context.room.connect_calls == 0


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
