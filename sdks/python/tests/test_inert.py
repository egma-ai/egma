"""The property this package is safe by: in a production room it does nothing.

Not "adds negligible latency", not "wraps harmlessly" — **nothing**. The
same tool objects, no side table written, not one message put on the
wire, and no connect the agent was not already making. Everything else
this SDK does is worth having only if a customer can install it and have
their production behavior be literally unchanged, so this file comes first
and is read as the whole safety argument.

The question the SDK asks is the room's name, and only the room's name, so
this file is mostly a list of names that are not egma's. Every one of them
is crossed with a list of dispatch metadata — including metadata carrying
egma's own key names — because that channel is the customer's to fill with
whatever they like and nothing in it may turn their production room into a
simulation. A room wrapped by mistake is also a room whose spans are held
out of Monitoring, and a dropped trace is evidence a customer cannot get
back.
"""

from __future__ import annotations

import pytest
from conftest import ReceptionAgent, couriers_on
from livekit.agents import AgentTask, ConversationItemAddedEvent, function_tool
from livekit.agents.llm import AgentHandoff
from room_stub import PRODUCTION_ROOM, SIMULATION_ROOM, StubContext, StubRoom

from egma import mockable

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

    await mockable(agent, ctx, session)

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


@pytest.mark.parametrize("metadata", THE_CUSTOMER_S_OWN_METADATA)
async def test_the_customers_dispatch_metadata_is_never_read_as_an_instruction(
    metadata, session
):
    """The channel that is the customer's, down to egma's own key names.

    Dispatch metadata is where LiveKit teaches customers to put a caller's
    own identifiers, so whatever is in it belongs to them — including the
    four names egma writes there for older SDK versions. A customer whose
    own JSON happens to use ``egmaIdentity`` gets exactly the production
    room they had: their tools untouched, and their conversation still on
    the record in Monitoring.

    The last parameter is the one this test exists for. The rest are here
    so the reading is proved to be no reading at all, rather than a
    reading that this particular JSON happened to fail.
    """
    agent = ReceptionAgent()
    room = StubRoom(connected=False, mocked_tools=("check_calendar",))
    ctx = StubContext(room, PRODUCTION_ROOM, metadata)

    await mockable(agent, ctx, session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert ctx.connect_calls == 0


async def test_a_production_handoff_stays_inert_after_mockable_returns(session):
    """A production room also means no listener waiting to wrap a later task."""
    agent = ReceptionAgent()
    task = ProductionTask()
    room = StubRoom(connected=False)

    await mockable(agent, StubContext(room, PRODUCTION_ROOM), session)
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

    await mockable(agent, ctx, session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert ctx.connect_calls == 0


async def test_an_agent_with_no_tools_still_reports_and_wraps_nothing(session):
    """The census is sent even when it is empty.

    An agent with no tools is a fact egma wants on the record — it is how
    the coverage stamp can say "nothing was covered because there was
    nothing to cover" rather than staying silent.
    """
    from conftest import ToollessAgent

    agent = ToollessAgent()
    room = StubRoom()

    await mockable(agent, StubContext(room, SIMULATION_ROOM), session)

    assert [asked.method for asked in room.asked] == ["egma.hello"]
    assert room.asked[0].body["tools"] == []
    assert couriers_on(session, agent) == {}
