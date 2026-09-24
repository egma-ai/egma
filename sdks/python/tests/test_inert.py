"""Production rooms must not trigger simulation setup.
Test room names with empty, arbitrary, and legacy-shaped customer metadata;
none may install mocks, export spans, connect, or send RPC messages.
"""

from __future__ import annotations

import pytest
from conftest import ReceptionAgent, couriers_on
from room_stub import SIMULATION_ROOM, StubContext, StubRoom

from egma import export, simulation

NOT_A_SIMULATION_ROOM = [
    pytest.param("egma-sim", id="the prefix without its separator"),
    pytest.param("call-egma-sim-0001", id="the prefix in the middle"),
]

THE_CUSTOMER_S_OWN_METADATA = [
    pytest.param("not json at all", id="metadata that is not json"),
    pytest.param(
        '{"egmaIdentity":"egma-persona","simulationId":"sim-0001"}',
        id="the customer's own use of egma's key names",
    ),
]


@pytest.mark.parametrize("room_name", NOT_A_SIMULATION_ROOM)
@pytest.mark.parametrize("metadata", THE_CUSTOMER_S_OWN_METADATA)
async def test_a_room_egma_did_not_name_is_left_alone(room_name, metadata, session):
    agent = ReceptionAgent()
    before = agent.tools
    # egma is standing right there, willing to answer. Nothing may ask it.
    room = StubRoom(connected=False, mocked_tools=("check_calendar",))
    ctx = StubContext(room, room_name, metadata)

    await simulation(agent, ctx, session)

    # The very same objects. Not equal, not equivalent — the identical
    # callables the agent was built with, which is the only claim that
    # rules out a wrapper standing quietly in the path.
    after = agent.tools
    assert len(after) == len(before)
    assert all(now is then for now, then in zip(after, before, strict=True))

    # Nothing was written where the framework looks for a stand-in.
    assert couriers_on(session, agent) == {}

    # And nothing was said. This is the assertion that would catch an SDK
    # which discovered egma's absence by asking — a call that costs a
    # production room a round trip on every session start.
    assert room.asked == []
    assert ctx.connect_calls == 0
    # Nor was anything left listening for somebody to walk in.
    assert room.listeners == {}
    # And no exporter was built, so this conversation cannot reach Egma
    # as somebody's simulation.
    assert export._state is None
    assert ctx.shutdown_callbacks == []


async def test_an_agent_with_no_tools_still_reports_and_wraps_nothing(
    session, egma_export
):
    """The census is sent even when it is empty.

    An agent with no tools is a fact egma wants on the record — it is how
    the coverage stamp can say "nothing was covered because there was
    nothing to cover" rather than staying silent.
    """
    from conftest import ToollessAgent

    agent = ToollessAgent()
    room = StubRoom()

    await simulation(agent, StubContext(room, SIMULATION_ROOM), session)

    assert [asked.method for asked in room.asked] == ["egma.hello"]
    assert room.asked[0].body["tools"] == []
    assert couriers_on(session, agent) == {}
