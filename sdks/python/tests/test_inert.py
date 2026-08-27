"""The property this package is safe by: in a production room it does nothing.

Not "adds negligible latency", not "wraps harmlessly" — **nothing**. The
same tool objects, no side table written, and not one message put on the
wire. Everything else this SDK does is worth having only if a customer
can install it and have their production behavior be literally
unchanged, so this file comes first and is read as the whole safety
argument.

Every way of not finding egma ends here the same way, and that is on
purpose: metadata that is absent, empty, somebody else's, unparseable, or
egma's own in a version this SDK does not speak. The differences between
those are differences about the *room*; about what this SDK should do
they all say one thing.
"""

from __future__ import annotations

import pytest
from conftest import ReceptionAgent, couriers_on
from livekit.agents import AgentTask, ConversationItemAddedEvent, function_tool
from livekit.agents.llm import AgentHandoff
from room_stub import StubContext, StubRoom, egma_metadata

from egma import mockable

NO_EGMA = [
    pytest.param("", id="no metadata at all"),
    pytest.param("   ", id="metadata of blanks"),
    pytest.param('{"tenant":"acme","shift":"nights"}', id="the customer's own"),
    pytest.param("not json at all", id="metadata that is not json"),
    pytest.param('"a string"', id="json that is not an object"),
    pytest.param('{"egmaIdentity":""}', id="an egma name that names nobody"),
    pytest.param('{"egmaIdentity":42}', id="an egma name that is not a name"),
]


class ProductionTask(AgentTask[None]):
    """A task a normal production session may select after startup."""

    def __init__(self) -> None:
        super().__init__(instructions="Book the appointment.")

    @function_tool
    async def book_appointment(self, day: str) -> str:
        """Book a real appointment."""
        return f"really booked {day}"


@pytest.mark.parametrize("metadata", NO_EGMA)
async def test_a_room_with_no_egma_in_it_is_left_alone(metadata, session):
    agent = ReceptionAgent()
    before = agent.tools
    room = StubRoom(connected=False)
    ctx = StubContext(room, metadata)

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


async def test_a_production_handoff_stays_inert_after_mockable_returns(session):
    """No metadata also means no listener waiting to wrap a later task."""
    agent = ReceptionAgent()
    task = ProductionTask()
    room = StubRoom(connected=False)

    await mockable(agent, StubContext(room, ""), session)
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


@pytest.mark.parametrize(
    "declared",
    [
        pytest.param(99, id="a version from the future"),
        pytest.param(True, id="a boolean, which python counts as one"),
        pytest.param("1", id="a version written as text"),
        pytest.param(None, id="no version at all"),
    ],
)
async def test_a_version_this_sdk_cannot_read_wraps_nothing(session, declared):
    """Only the number itself will do.

    A boolean is the one worth naming: Python counts ``True`` as equal to
    ``1``, so a metadata field carrying ``true`` would otherwise pass for
    version 1 and this SDK would speak an exchange nobody declared.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    await mockable(
        agent, StubContext(room, egma_metadata(protocol_version=declared)), session
    )

    assert couriers_on(session, agent) == {}
    assert room.asked == []


async def test_a_version_neither_side_speaks_wraps_nothing(session, caplog):
    """egma is there, and this SDK does not speak its exchange.

    Nothing is wrapped, so every tool runs its own implementation — the
    same place the absent-egma path lands, reached from the other
    direction. It is said at error level because, unlike an absent egma,
    this one is a fault somebody must fix: a simulation ran unisolated.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(
            agent, StubContext(room, egma_metadata(protocol_version=99)), session
        )

    assert couriers_on(session, agent) == {}
    # Not even the census: a version mismatch is known before anything is
    # said, which is the whole reason the version rides the metadata.
    assert room.asked == []
    assert "99" in caplog.text


async def test_an_agent_with_no_tools_still_reports_and_wraps_nothing(session):
    """The census is sent even when it is empty.

    An agent with no tools is a fact egma wants on the record — it is how
    the coverage stamp can say "nothing was covered because there was
    nothing to cover" rather than staying silent.
    """
    from conftest import ToollessAgent

    agent = ToollessAgent()
    room = StubRoom()

    await mockable(agent, StubContext(room, egma_metadata()), session)

    assert [asked.method for asked in room.asked] == ["egma.hello"]
    assert room.asked[0].body["tools"] == []
    assert couriers_on(session, agent) == {}
