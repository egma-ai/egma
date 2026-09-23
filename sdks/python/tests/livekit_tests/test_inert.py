"""Production rooms must not trigger simulation setup.
Test room names with empty, arbitrary, and legacy-shaped customer metadata;
none may install mocks, export spans, connect, or send RPC messages.
"""

from __future__ import annotations

import pytest
from conftest import ReceptionAgent, couriers_on
from livekit.agents import AgentTask, ConversationItemAddedEvent, function_tool
from livekit.agents.llm import AgentHandoff
from room_stub import PRODUCTION_ROOM, SIMULATION_ROOM, StubContext, StubRoom

from egma import export, simulation

NOT_A_SIMULATION_ROOM = [
    pytest.param("", id="no room name at all"),
    pytest.param(PRODUCTION_ROOM, id="the customer's own room"),
    pytest.param("egma-sim", id="the prefix without its separator"),
    pytest.param("egma-simulator-demo", id="a name that merely starts alike"),
    pytest.param("call-egma-sim-0001", id="the prefix in the middle"),
    pytest.param("EGMA-SIM-0001", id="the prefix in another case"),
]

THE_CUSTOMER_S_OWN_METADATA = [
    pytest.param("", id="no metadata at all"),
    pytest.param("   ", id="metadata of blanks"),
    pytest.param('{"tenant":"acme","shift":"nights"}', id="the customer's own"),
    pytest.param("not json at all", id="metadata that is not json"),
    pytest.param('"a string"', id="json that is not an object"),
    pytest.param('{"egmaIdentity":""}', id="an egma name that names nobody"),
    pytest.param('{"egmaIdentity":42}', id="an egma name that is not a name"),
    pytest.param(
        '{"egmaIdentity":"egma-persona","simulationId":"sim-0001"}',
        id="the customer's own use of egma's key names",
    ),
]


class ProductionTask(AgentTask[None]):
    """A task a normal production session may select after startup."""

    def __init__(self) -> None:
        super().__init__(instructions="Book the appointment.")

    @function_tool
    async def book_appointment(self, day: str) -> str:
        """Book a real appointment."""
        return f"really booked {day}"


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


@pytest.mark.parametrize("metadata", THE_CUSTOMER_S_OWN_METADATA)
async def test_the_customers_dispatch_metadata_is_never_read_as_an_instruction(
    metadata, session
):
    """Customer metadata, including legacy Egma keys, cannot turn a production
    room into a simulation or change its tools.
    """
    agent = ReceptionAgent()
    room = StubRoom(connected=False, mocked_tools=("check_calendar",))
    ctx = StubContext(room, PRODUCTION_ROOM, metadata)

    await simulation(agent, ctx, session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert ctx.connect_calls == 0
    assert export._state is None


async def test_a_production_handoff_stays_inert_after_the_verb_returns(session):
    """A production room also means no listener waiting to wrap a later task."""
    agent = ReceptionAgent()
    task = ProductionTask()
    room = StubRoom(connected=False)

    await simulation(agent, StubContext(room, PRODUCTION_ROOM), session)
    session.update_agent(task)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=task.id)
        ),
    )

    assert couriers_on(session, task) == {}
    assert await task.book_appointment("Tuesday") == "really booked Tuesday"
    assert room.asked == []
    assert export._state is None


async def test_a_production_room_is_answered_without_a_job_room_object(session):
    """A context that carries no room on its job is a production room.

    Read defensively on purpose. Whatever this is handed, the answer that
    costs nobody anything is the one it gives — and a caller who passed
    the wrong object entirely still reaches a worded complaint elsewhere
    rather than an attribute error raised from inside this SDK.
    """
    agent = ReceptionAgent()
    room = StubRoom(connected=False)
    ctx = StubContext(room, PRODUCTION_ROOM)
    ctx.job.room = None

    await simulation(agent, ctx, session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert ctx.connect_calls == 0
    assert export._state is None


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
