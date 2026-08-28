"""The exchange, from the customer's seat: census, couriers, and answers.

Every test here runs against a room-shaped stand-in for egma's
participant, so the whole of the SDK's own code is exercised — the room's
name read, egma found among the people in the room, the census built off
a real agent, the couriers stood in LiveKit's own side table, the reply
read, the fail-open — with no LiveKit server and no network anywhere.

Where a courier is called, it is called the way the framework delivers a
call to one: through LiveKit's own argument trimming. That is the only
way the copied signature can be proved, because trimming is the very
thing the copy exists to survive.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from conftest import ReceptionAgent, called, couriers_on, in_a_simulation
from livekit.agents import (
    AgentTask,
    CloseEvent,
    CloseReason,
    ConversationItemAddedEvent,
    RunContext,
    ToolError,
    function_tool,
)
from livekit.agents.llm import AgentHandoff
from livekit.rtc import RpcError
from room_stub import (
    EGMA_IDENTITY,
    SIMULATION_ROOM,
    StubContext,
    StubRoom,
    egma_metadata,
    not_reached,
    persona_in,
)

from egma import mockable, seam

# The module rather than the verb: ``egma.mockable`` is both, and the
# tests that shorten this SDK's own waits have to reach the module.
implementation = importlib.import_module("egma.mockable")


def answer(value: object) -> dict:
    """What egma sends for an answer, tagged as the wire tags it."""
    return {"answer": value}


def failure(message: str) -> dict:
    """What egma sends for the branch a test forces on purpose."""
    return {"error": message}


# -- The census ---------------------------------------------------------------


async def test_a_simulation_connects_before_it_reports_tools(session):
    agent = ReceptionAgent()
    room = StubRoom(connected=False)
    ctx = in_a_simulation(room)

    await mockable(agent, ctx, session)

    assert ctx.connect_calls == 1
    assert room.methods_asked == [seam.HELLO_METHOD]


async def test_an_already_connected_simulation_does_not_connect_again(session):
    agent = ReceptionAgent()
    room = StubRoom()
    ctx = in_a_simulation(room)

    await mockable(agent, ctx, session)

    assert ctx.connect_calls == 0


async def test_a_room_that_will_not_open_leaves_the_agent_alone(session, caplog):
    """The one connect this SDK forces is not a way for it to raise.

    Connecting is the only thing ``mockable`` makes an agent do that the
    agent had not asked for yet, so it is the one place a fault of egma's
    could reach a customer's entrypoint. It does not: a room that will not
    open is a room egma cannot be found in, which lands where every other
    unreachable egma lands — nothing wrapped, every tool its own, and the
    reason said out loud. The agent's own startup is left to connect, or
    to fail on its own terms.
    """
    agent = ReceptionAgent()
    room = StubRoom(connected=False, mocked_tools=("check_calendar",))
    ctx = in_a_simulation(room)

    async def will_not_open() -> None:
        raise RuntimeError("the LiveKit server refused this token")

    ctx.connect = will_not_open

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, ctx, session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert "the LiveKit server refused this token" in caplog.text


async def test_the_census_goes_first_and_names_every_tool(session):
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    await mockable(agent, in_a_simulation(room), session)

    # First, before anything else could have been said. An egma that is
    # not in the room has to be discovered here rather than by a caller
    # waiting mid-conversation.
    assert room.methods_asked[0] == seam.HELLO_METHOD
    census = room.asked[0].body
    assert census["protocol_version"] == seam.PROTOCOL_VERSION
    reported = {tool["name"] for tool in census["tools"]}
    assert reported == {"check_calendar", "read_notice"}
    assert room.asked[0].identity == EGMA_IDENTITY


async def test_the_census_carries_each_tool_s_schema(session):
    """Names make matching correct; schemas make authoring possible.

    A mock tool is authored against the arguments the model really sends,
    so the census carries the shape the model is shown — read off the
    agent by the framework that built it, never re-derived here.
    """
    agent = ReceptionAgent()
    room = StubRoom()

    await mockable(agent, in_a_simulation(room), session)

    schemas = {tool["name"]: tool["schema"] for tool in room.asked[0].body["tools"]}
    calendar = schemas["check_calendar"]
    assert calendar["name"] == "check_calendar"
    assert "free slots" in calendar["description"]
    assert set(calendar["parameters"]["properties"]) == {"day", "party_size"}


async def test_the_census_sets_both_knobs_explicitly(session):
    """Never a default, on any call. The transport's own timeout is
    shorter than a delay a mock tool may legally declare.

    A census gets the shorter of this SDK's two waits, because a hello has
    no authored delay to wait out and every second spent on one is a
    second the agent has not greeted anybody in.
    """
    agent = ReceptionAgent()
    room = StubRoom()

    await mockable(agent, in_a_simulation(room), session)

    assert room.asked[0].response_timeout == seam.HELLO_TIMEOUT_SECONDS
    assert room.asked[0].max_round_trip_latency == seam.MAX_ROUND_TRIP_SECONDS


async def test_the_hello_wait_stays_clear_of_the_time_egma_gives_an_agent(session):
    """The relation the number is chosen for, asserted rather than trusted.

    egma allows an agent 30 seconds to join and publish audio. A hello is
    sent before the session starts, so a hello this side would wait longer
    than that for is a simulation egma ends by blaming the customer's
    worker for a stall on this side of the room.
    """
    assert seam.HELLO_TIMEOUT_SECONDS < seam.RESPONSE_TIMEOUT_SECONDS
    assert seam.HELLO_TIMEOUT_SECONDS < 30.0


# -- Finding egma in the room -------------------------------------------------


async def test_egma_arriving_after_the_agent_is_waited_for(session):
    """The ordinary order, on two of the three dispatch paths into an egma room.

    Nothing dispatches the worker on egma's behalf on those two, so the
    agent is in the room first and egma walks in afterwards. The room's
    name already said this is a simulation, so this side may wait — and it
    connects before it waits, because a room nobody is connected to has
    nobody in it.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        connected=False, present=(), mocked_tools=("check_calendar",)
    )
    ctx = in_a_simulation(room)

    async def egma_walks_in() -> None:
        await asyncio.sleep(0.05)
        room.arrive(EGMA_IDENTITY)

    joining = asyncio.create_task(egma_walks_in())
    await mockable(agent, ctx, session)
    await joining

    assert ctx.connect_calls == 1
    assert room.methods_asked == [seam.HELLO_METHOD]
    assert room.asked[0].identity == EGMA_IDENTITY
    assert set(couriers_on(session, agent)) == {"check_calendar"}
    # Nothing is left subscribed to the room once egma has been found.
    assert room.listeners == {}


async def test_egma_already_in_the_room_is_found_without_waiting(session):
    """The other order, which is the one an explicit dispatch produces."""
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    await mockable(agent, in_a_simulation(room), session)

    assert set(couriers_on(session, agent)) == {"check_calendar"}
    assert room.listeners == {}


async def test_the_persona_a_token_endpoint_mints_for_is_found_too(session):
    """egma joins under two names, and the second is the customer's variant.

    Where a customer's own token endpoint mints egma's token, egma asks it
    for ``egma-persona-<simulation>`` rather than the bare name. Both are
    egma, and the address every message goes to is whichever one is really
    in the room.
    """
    agent = ReceptionAgent()
    persona = persona_in()
    room = StubRoom(present=(persona,), mocked_tools=("check_calendar",))

    await mockable(agent, in_a_simulation(room), session)

    assert room.asked[0].identity == persona
    assert set(couriers_on(session, agent)) == {"check_calendar"}


async def test_two_participants_answering_to_egmas_name_are_refused(session, caplog):
    """A room with two claimants is a room where the answer is not knowable.

    LiveKit makes one identity unique per room, so an impersonator taking
    egma's exact name is evicted by the server. One taking a variant of it
    sits quietly beside the real thing — and whichever this side picked
    would be handed every tool name and schema this agent has. So neither
    is picked.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        present=(EGMA_IDENTITY, persona_in()), mocked_tools=("check_calendar",)
    )

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    # Not one word on the wire: the census is this agent's whole tool
    # inventory, and it is never sent to somebody who might not be egma.
    assert room.asked == []
    assert EGMA_IDENTITY in caplog.text


@pytest.mark.parametrize(
    "identity",
    [
        pytest.param("egma-personality-quiz", id="a name that merely starts alike"),
        pytest.param("caller-8871", id="an ordinary caller"),
        pytest.param("EGMA-PERSONA", id="the name in another case"),
    ],
)
async def test_a_participant_who_is_not_egma_is_never_asked(
    session, monkeypatch, identity
):
    """The room's name says simulation; who to talk to is a separate question.

    The name gets this side as far as looking, and no further: what the
    census carries is every tool this agent has, by name and schema, so
    the only participant it may be sent to is one that answers to egma's
    name exactly — the bare name, or the name with a ``-`` and a
    simulation after it. A prefix test would hand that inventory to
    ``egma-personality-quiz``. Nobody here matches, so the search waits
    the bound out and ends in the ordinary fail-open instead.
    """
    agent = ReceptionAgent()
    room = StubRoom(present=(identity,), mocked_tools=("check_calendar",))
    monkeypatch.setattr(implementation, "STARTUP_SECONDS", 0.2)

    await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []


async def test_a_room_that_will_not_say_who_is_in_it_wraps_nothing(
    session, monkeypatch, caplog
):
    """A room this side cannot see into is read as a room egma is not in.

    Who is in the room is read through the mapping LiveKit declares, so
    anything that answers ``items()`` is walked and anything that does not
    is treated as an empty room rather than raised from. The end is the
    ordinary fail-open, and nothing is sent anywhere on the way there.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))
    room.remote_participants = None
    monkeypatch.setattr(implementation, "STARTUP_SECONDS", 0.2)

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert "Monitoring" in caplog.text


async def test_a_simulation_room_egma_never_joined_says_what_to_do(
    session, monkeypatch, caplog
):
    """The branch that is unreachable in production, by construction.

    The room's name said simulation and nobody by egma's name ever
    arrived, which is a simulation that will run its real tools unless
    somebody acts. So this is the one line in the SDK that asks for
    action: it names who to look for in the room and this package's own
    version, and it says that this job's spans stay out of Monitoring
    regardless, because the room's name settled that on its own.
    """
    agent = ReceptionAgent()
    room = StubRoom(present=(), mocked_tools=("check_calendar",))
    monkeypatch.setattr(implementation, "STARTUP_SECONDS", 0.2)

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert room.asked == []
    assert "egma" in caplog.text
    assert "Monitoring" in caplog.text
    assert room.listeners == {}


async def test_a_census_sent_before_egma_registered_the_exchange_is_asked_again(
    session,
):
    """egma is in the room a while before it answers to anything.

    Its participant enters when its transport connects; the two methods of
    this exchange are registered later. An SDK that read the transport's
    "no such method" as "there is no egma here" would fall open for the
    whole simulation — every mocked tool running its real implementation,
    which is a real appointment booked.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",), refuses_hello_until=2)

    await mockable(agent, in_a_simulation(room), session)

    assert room.methods_asked == [seam.HELLO_METHOD] * 3
    assert set(couriers_on(session, agent)) == {"check_calendar"}


async def test_a_census_asked_again_until_the_deadline_wraps_nothing(
    session, monkeypatch, caplog
):
    """The retry is bounded, and what it ends in is the ordinary fail-open."""
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",), refuses_hello_until=10_000)
    monkeypatch.setattr(implementation, "STARTUP_SECONDS", 0.3)

    with caplog.at_level("WARNING", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert room.methods_asked
    assert EGMA_IDENTITY in caplog.text


async def test_a_room_that_lost_egma_is_not_waited_out(session):
    """``RECIPIENT_NOT_FOUND`` is answered at once, not asked again.

    It is the same kind of race as an unregistered method in principle,
    and it is treated differently on purpose: nothing gets as far as
    asking without having seen egma in this room's own participant table,
    so a destination that cannot be found now is one that left. A
    participant that left gets the fail-open every lost participant gets.
    Asking it again for the rest of the bound would hold this agent silent
    through the simulation it was waiting to serve, and end in the same
    place.
    """
    agent = ReceptionAgent()
    room = StubRoom(refuses_with=not_reached())

    await mockable(agent, in_a_simulation(room), session)

    assert room.methods_asked == [seam.HELLO_METHOD]
    assert couriers_on(session, agent) == {}


# -- What dispatch metadata is worth in a simulation room ---------------------


async def test_the_legacy_context_block_changes_nothing_in_a_simulation_room(session):
    """egma's own four keys arrive on one dispatch path, and are not read.

    Where egma dispatches the worker by name it merges a context block
    into the job's metadata, underneath the customer's keys, for SDK
    releases below the room-name floor. This side reads none of
    it. The room is what said simulation, and egma is found by looking for
    it — so this room behaves exactly like the same room with empty
    metadata, which is the property that keeps that block deletable.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    await mockable(
        agent,
        StubContext(room, SIMULATION_ROOM, egma_metadata()),
        session,
    )

    assert room.asked[0].identity == EGMA_IDENTITY
    assert set(couriers_on(session, agent)) == {"check_calendar"}


async def test_an_identity_named_in_metadata_is_never_the_address(
    session, monkeypatch
):
    """The address comes from the room, never from a string handed to it.

    The census is this agent's whole tool inventory, so who receives it is
    the one decision in this file that a name in the customer's own
    dispatch metadata may not make. Here that metadata names somebody who
    is not in the room and is not egma; the room holds nobody by egma's
    name; and the answer is the ordinary fail-open, with nothing sent to
    anyone.
    """
    agent = ReceptionAgent()
    room = StubRoom(present=("caller-8871",), mocked_tools=("check_calendar",))
    monkeypatch.setattr(implementation, "STARTUP_SECONDS", 0.2)

    await mockable(
        agent,
        StubContext(room, SIMULATION_ROOM, egma_metadata(identity="caller-8871")),
        session,
    )

    assert room.asked == []
    assert couriers_on(session, agent) == {}


async def test_a_version_neither_side_speaks_is_learned_from_the_reply(
    session, caplog
):
    """The version rides the hello, and that is where it is read.

    It rides the hello in both directions. An egma that will not speak
    this side's version refuses the census with its own code, and the one
    thing this SDK adds to that sentence is the package the two numbers
    belong to — because "Egma speaks 1 and this one declared 2" reads as
    an SDK that is too new when the fix is usually the other half.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        refuses_with=RpcError(
            seam.UNSUPPORTED_PROTOCOL_VERSION,
            "egma.hello declares which version of this exchange it speaks",
        )
    )

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert "egma" in caplog.text
    assert "Upgrade" in caplog.text


# -- Which tools get a courier ------------------------------------------------


async def test_couriers_stand_for_exactly_the_names_egma_answered_with(session):
    """Not the overlap with the census — egma's whole list.

    ``book_appointment`` is a tool this agent does not have. It still
    gets a courier, because the side table is read by name at call time
    and a tool attached later must be intercepted on its first call. A
    courier for a name that never turns up costs nothing: it never fires.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar", "book_appointment"))

    await mockable(agent, in_a_simulation(room), session)

    assert set(couriers_on(session, agent)) == {"check_calendar", "book_appointment"}


async def test_an_unmocked_tool_is_left_exactly_as_it_was(session):
    """``read_notice`` is in the census and not in egma's answer.

    So no courier stands for it, its object is the one the agent was
    built with, and calling it really runs it. egma is not in its path
    and never sees the call — which is what the record's coverage stamp
    is there to say out loud.
    """
    agent = ReceptionAgent()
    before = {tool.info.name: tool for tool in agent.tools}
    room = StubRoom(
        mocked_tools=("check_calendar",),
        answers={"check_calendar": answer("no free slots")},
    )

    await mockable(agent, in_a_simulation(room), session)

    assert "read_notice" not in couriers_on(session, agent)
    assert {tool.info.name: tool for tool in agent.tools} == before
    assert await agent.read_notice() == "really ran: the notice"
    assert room.tool_calls == []


async def test_a_courier_for_a_tool_that_never_turns_up_never_fires(session):
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar", "book_appointment"),
        answers={"check_calendar": answer("no free slots")},
    )

    await mockable(agent, in_a_simulation(room), session)
    await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")

    # One call was made, and it was the one the agent actually made.
    assert [call["name"] for call in room.tool_calls] == ["check_calendar"]


# -- What a mocked call comes back with ---------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        pytest.param("no free slots on Tuesday", id="text"),
        pytest.param({"slots": []}, id="an object"),
        pytest.param([1, 2, 3], id="a list"),
        pytest.param(None, id="nothing at all"),
        pytest.param(False, id="a boolean that looks like nothing"),
    ],
)
async def test_a_mocked_call_comes_back_with_egma_s_answer(session, value):
    """Including the answers that look like absence.

    ``None`` and ``False`` are legal answers a mock tool may hold, so the
    tag is what decides whether a call succeeded — never the value.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": answer(value)}
    )

    await mockable(agent, in_a_simulation(room), session)
    served = await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")

    assert served == value
    # And the real implementation was not touched on the way.
    assert served != "really ran: Tuesday for 1"


async def test_an_authored_failure_reaches_the_model_as_the_tool_s_own_error(session):
    """The branch a test forces: the booking API errors.

    It arrives as the framework's tool error, so the agent handles it
    exactly as it handles a real backend failing — which is the whole
    thing the test exists to find out.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",),
        answers={"check_calendar": failure("the calendar service is down")},
    )

    await mockable(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError) as raised:
        await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")
    # The mock tool author's own sentence, not this side's words about it.
    assert str(raised.value) == "the calendar service is down"


async def test_an_answer_that_looks_like_a_failure_is_still_an_answer(session):
    """A tool whose real return value is ``{"error": …}`` is a real thing.

    Read by shape it would arrive as a failure nobody authored. Read by
    tag it arrives as what it is: the value the mock tool holds.
    """
    agent = ReceptionAgent()
    looks_like = {"error": "not found", "code": 404}
    room = StubRoom(
        mocked_tools=("check_calendar",),
        answers={"check_calendar": answer(looks_like)},
    )

    await mockable(agent, in_a_simulation(room), session)
    served = await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")

    assert served == looks_like


# -- The signature copy -------------------------------------------------------


async def test_a_real_tool_s_arguments_arrive_complete(session):
    """The copied signature, proved through the framework's own trimming.

    LiveKit hands a mock only the parameters the mock declares. Without
    the copy this courier would be handed nothing — not an error, just an
    empty call, which is the quietest way to lose a record.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": answer("ok")}
    )

    await mockable(agent, in_a_simulation(room), session)
    await called(
        couriers_on(session, agent)["check_calendar"], day="Tuesday", party_size=4
    )

    assert room.tool_calls == [
        {"name": "check_calendar", "arguments": {"day": "Tuesday", "party_size": 4}}
    ]


async def test_a_default_the_model_left_out_is_reported_as_it_was_applied(session):
    """What reaches the tool is what reaches the record.

    The model sent one argument; the framework filled the other from the
    signature's default. The call really ran with both, so both are what
    egma writes down.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": answer("ok")}
    )

    await mockable(agent, in_a_simulation(room), session)
    await called(couriers_on(session, agent)["check_calendar"], day="Friday")

    assert room.tool_calls[0]["arguments"] == {"day": "Friday", "party_size": 1}


async def test_the_session_s_own_context_is_never_reported(session):
    """A tool may ask the framework for its way back into the conversation.

    That parameter is the framework handing the tool a handle, not
    something the model asked for, so it is dropped before the call is
    reported — and it must be dropped, because it is not JSON and the
    message would not go.
    """

    class ContextAgent(ReceptionAgent):
        @function_tool
        async def transfer(self, to: str, context: RunContext) -> str:
            """Hand the caller on.

            Args:
                to: Who to hand them to.
            """
            return f"really transferred to {to}"

    agent = ContextAgent()
    room = StubRoom(mocked_tools=("transfer",), answers={"transfer": answer("done")})

    await mockable(agent, in_a_simulation(room), session)
    courier = couriers_on(session, agent)["transfer"]
    # A context of the framework's own type and nothing else, because the
    # type is the whole of what a courier reads about one. Building a
    # working context would need a live speech handle and a live call,
    # and would prove nothing this does not.
    served = await called(courier, to="billing", context=RunContext.__new__(RunContext))

    assert served == "done"
    assert room.tool_calls[0]["arguments"] == {"to": "billing"}


class RawAgent(ReceptionAgent):
    """An agent whose tool carries its own schema.

    The shape the documented fallback mechanism is built from, and a
    shape a customer may already be using: the framework hands such a
    tool the whole call under one parameter of its own choosing.
    """

    @function_tool(
        raw_schema={
            "name": "lookup",
            "description": "Look a caller up by anything.",
            "parameters": {
                "type": "object",
                "properties": {"by": {"type": "string"}},
                "required": ["by"],
            },
        }
    )
    async def lookup(self, raw_arguments: dict[str, object]) -> str:
        return f"really ran: {raw_arguments}"


async def test_a_raw_schema_tool_reports_its_own_schema(session):
    agent = RawAgent()
    room = StubRoom()

    await mockable(agent, in_a_simulation(room), session)

    schemas = {tool["name"]: tool["schema"] for tool in room.asked[0].body["tools"]}
    assert schemas["lookup"]["parameters"]["properties"] == {"by": {"type": "string"}}


async def test_a_raw_schema_call_is_reported_as_the_model_sent_it(session):
    """Not nested inside the parameter the framework wrapped it in.

    The record is read by people authoring mock tools against what the
    model sends. One extra level of the framework's own making would put
    every raw tool's arguments somewhere nobody expects them.
    """
    agent = RawAgent()
    room = StubRoom(
        mocked_tools=("lookup",), answers={"lookup": answer("Ada Lovelace")}
    )

    await mockable(agent, in_a_simulation(room), session)
    served = await called(
        couriers_on(session, agent)["lookup"], raw_arguments={"by": "phone"}
    )

    assert served == "Ada Lovelace"
    assert room.tool_calls == [{"name": "lookup", "arguments": {"by": "phone"}}]


# -- Tools that arrive late ---------------------------------------------------


class SpecialRequestsTask(AgentTask[None]):
    """A real LiveKit task with a tool that is absent from the root agent."""

    def __init__(self) -> None:
        super().__init__(instructions="Record the caller's notes.")

    @function_tool
    async def record_special_requests(self, notes: list[str]) -> str:
        """Store the caller's special requests."""
        return f"really stored: {notes!r}"


class MarkedSpecialRequestsTask(AgentTask[None]):
    """The result says which same-class instance really handled a fallback."""

    def __init__(self, marker: str) -> None:
        super().__init__(instructions="Record the caller's notes.")
        self.marker = marker

    @function_tool
    async def record_special_requests(self, notes: list[str]) -> str:
        """Store the caller's special requests."""
        return f"{self.marker}: {notes!r}"


class HandoffProbeTask(AgentTask[None]):
    """Observe whether couriers exist at LiveKit's real task entry boundary."""

    def __init__(self, observed: asyncio.Future[bool]) -> None:
        self.observed = observed
        super().__init__(instructions="Observe startup ordering.")

    @function_tool
    async def record_special_requests(self, notes: list[str]) -> str:
        """Store the caller's special requests."""
        return f"really stored: {notes!r}"

    async def on_enter(self) -> None:
        if not self.observed.done():
            self.observed.set_result(
                "record_special_requests" in couriers_on(self.session, self)
            )
        self.complete(None)


class InsuranceTask(AgentTask[None]):
    """A second task class, used to prove that census discovery only grows."""

    def __init__(self) -> None:
        super().__init__(instructions="Verify insurance.")

    @function_tool
    async def verify_insurance(self, member_id: str) -> str:
        """Verify the caller's insurance."""
        return f"really verified {member_id}"


async def test_a_tool_attached_after_this_runs_is_intercepted_on_its_first_call(
    session,
):
    """The reason couriers stand for egma's whole list.

    ``book_appointment`` did not exist when the census went out. Its
    courier did, because egma said it answers for that name — and when
    the tool arrives, its very first call is answered.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("book_appointment",),
        answers={"book_appointment": answer("booked, and nothing was really booked")},
    )

    await mockable(agent, in_a_simulation(room), session)

    @function_tool
    async def book_appointment(day: str) -> str:
        """Book it for real.

        Args:
            day: The day to book.
        """
        raise AssertionError("the real booking ran during a simulation")

    await agent.update_tools([*agent.tools, book_appointment])

    courier = couriers_on(session, agent)["book_appointment"]
    assert await called(courier) == "booked, and nothing was really booked"


async def test_a_late_attached_call_reports_no_arguments_rather_than_wrong_ones(
    session,
):
    """The caveat egma flags on the record, made concrete here.

    There was no signature to copy, so the framework hands this courier
    nothing. It says so — the call carries no ``arguments`` key at all —
    rather than claiming the call was made without any.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("book_appointment",),
        answers={"book_appointment": answer("booked")},
    )

    await mockable(agent, in_a_simulation(room), session)
    await called(couriers_on(session, agent)["book_appointment"], day="Tuesday")

    assert room.tool_calls == [{"name": "book_appointment"}]


async def test_a_tool_on_an_agent_task_handoff_is_intercepted_before_its_first_call(
    session,
):
    """LiveKit dispatches tools by the current agent's exact class.

    An ``AgentTask`` is a temporary agent with a different class from the root
    agent. The public handoff event fires after LiveKit selects that task and
    before it starts the task activity, so the task's first tool call must see
    the same session-scoped courier as a tool on the root agent.
    """

    agent = ReceptionAgent()
    task = SpecialRequestsTask()
    room = StubRoom(
        mocked_tools=("record_special_requests",),
        answers={
            "record_special_requests": answer(
                "the simulated scheduling system kept the notes"
            )
        },
    )

    await mockable(agent, in_a_simulation(room), session)

    # ``update_agent`` is LiveKit's public way to select the next agent. A
    # running session emits this public event at the handoff boundary; the
    # unit test emits the same value without starting audio or a model.
    session.update_agent(task)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=task.id)
        ),
    )

    served = await called(
        couriers_on(session, task)["record_special_requests"],
        notes=["wheelchair access", "interpreter"],
    )

    assert served == "the simulated scheduling system kept the notes"
    assert room.tool_calls[-1] == {
        "name": "record_special_requests",
        "arguments": {"notes": ["wheelchair access", "interpreter"]},
    }


async def test_livekit_public_handoff_installs_before_the_task_enters(session):
    """Lock down the public event ordering the handoff hook relies on."""
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("record_special_requests",))
    observed = asyncio.get_running_loop().create_future()

    await mockable(agent, in_a_simulation(room), session)
    try:
        await session.start(agent=agent)
        session.update_agent(HandoffProbeTask(observed))
        assert await asyncio.wait_for(observed, timeout=1)
    finally:
        await session.aclose()


async def test_an_agent_task_handoff_reports_the_task_tools_in_a_new_census(session):
    """The hosted run's coverage must name tools owned by an ``AgentTask``."""
    agent = ReceptionAgent()
    task = SpecialRequestsTask()
    room = StubRoom(mocked_tools=("record_special_requests",))

    await mockable(agent, in_a_simulation(room), session)
    session.update_agent(task)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=task.id)
        ),
    )
    await asyncio.sleep(0)

    assert room.methods_asked == [seam.HELLO_METHOD, seam.HELLO_METHOD]
    task_census = room.asked[-1].body
    assert {tool["name"] for tool in task_census["tools"]} == {
        "check_calendar",
        "read_notice",
        "record_special_requests",
    }


async def test_census_only_grows_across_tasks_and_a_return_to_the_root(session):
    """A later handoff must never erase tools discovered on an earlier one."""
    root = ReceptionAgent()
    requests = SpecialRequestsTask()
    insurance = InsuranceTask()
    room = StubRoom(
        mocked_tools=("record_special_requests", "verify_insurance")
    )

    await mockable(root, in_a_simulation(room), session)
    for old, new in (
        (root, requests),
        (requests, root),
        (root, insurance),
    ):
        session.update_agent(new)
        session.emit(
            "conversation_item_added",
            ConversationItemAddedEvent(
                item=AgentHandoff(old_agent_id=old.id, new_agent_id=new.id)
            ),
        )

    for _ in range(5):
        if room.methods_asked.count(seam.HELLO_METHOD) == 3:
            break
        await asyncio.sleep(0)

    censuses = [
        {tool["name"] for tool in asked.body["tools"]}
        for asked in room.asked
        if asked.method == seam.HELLO_METHOD
    ]
    assert censuses == [
        {"check_calendar", "read_notice"},
        {"check_calendar", "read_notice", "record_special_requests"},
        {
            "check_calendar",
            "read_notice",
            "record_special_requests",
            "verify_insurance",
        },
    ]


async def test_a_new_instance_of_the_same_task_class_gets_its_own_fallback(session):
    """A courier must never retain the previous task instance's real tool."""
    agent = ReceptionAgent()
    first = MarkedSpecialRequestsTask("first")
    second = MarkedSpecialRequestsTask("second")
    room = StubRoom(mocked_tools=("record_special_requests",))

    await mockable(agent, in_a_simulation(room), session)
    session.update_agent(first)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=first.id)
        ),
    )
    session.update_agent(second)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=first.id, new_agent_id=second.id)
        ),
    )
    room.refuses_tool_with = not_reached()

    served = await called(
        couriers_on(session, second)["record_special_requests"],
        notes=["second task only"],
    )

    assert served == "second: ['second task only']"


async def test_a_failed_same_class_install_clears_the_previous_instance(
    session, monkeypatch
):
    """A broken handoff may run real tools, but never a stale task's tool."""
    agent = ReceptionAgent()
    first = MarkedSpecialRequestsTask("first")
    second = MarkedSpecialRequestsTask("second")
    room = StubRoom(mocked_tools=("record_special_requests",))

    await mockable(agent, in_a_simulation(room), session)
    implementation = importlib.import_module("egma.mockable")
    install = implementation._install_couriers

    def fail_for_second(selected, mocked, seat, selected_session):
        if selected is second:
            raise TypeError("the second task could not be prepared")
        return install(selected, mocked, seat, selected_session)

    monkeypatch.setattr(implementation, "_install_couriers", fail_for_second)
    session.update_agent(first)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=first.id)
        ),
    )
    assert "record_special_requests" in couriers_on(session, first)

    session.update_agent(second)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=first.id, new_agent_id=second.id)
        ),
    )

    assert couriers_on(session, second) == {}


async def test_a_later_census_cannot_change_the_startup_mock_set(session):
    """The run's mocked world is fixed even while tool discovery grows."""
    agent = ReceptionAgent()
    task = SpecialRequestsTask()
    room = StubRoom(mocked_tools=("record_special_requests",))

    await mockable(agent, in_a_simulation(room), session)
    room.mocked_tools = ("verify_insurance",)
    session.update_agent(task)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=task.id)
        ),
    )
    for _ in range(3):
        if room.methods_asked.count(seam.HELLO_METHOD) == 2:
            break
        await asyncio.sleep(0)

    assert set(couriers_on(session, task)) == {"record_special_requests"}


async def test_session_close_removes_handoff_couriers_and_listener(session):
    """A reused LiveKit session must not retain a previous run's mocks."""
    agent = ReceptionAgent()
    task = SpecialRequestsTask()
    room = StubRoom(mocked_tools=("record_special_requests",))

    await mockable(agent, in_a_simulation(room), session)
    session.update_agent(task)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=agent.id, new_agent_id=task.id)
        ),
    )
    session.emit("close", CloseEvent(reason=CloseReason.USER_INITIATED))

    assert couriers_on(session, agent) == {}
    assert couriers_on(session, task) == {}

    another = SpecialRequestsTask()
    session.update_agent(another)
    session.emit(
        "conversation_item_added",
        ConversationItemAddedEvent(
            item=AgentHandoff(old_agent_id=task.id, new_agent_id=another.id)
        ),
    )
    assert couriers_on(session, another) == {}


# -- When egma is not reached -------------------------------------------------


@pytest.mark.parametrize(
    "code",
    [
        pytest.param(RpcError.ErrorCode.RECIPIENT_NOT_FOUND, id="1401 nobody there"),
        pytest.param(RpcError.ErrorCode.RECIPIENT_DISCONNECTED, id="1503 left"),
        pytest.param(RpcError.ErrorCode.UNSUPPORTED_METHOD, id="1400 no such method"),
    ],
)
async def test_a_call_egma_never_received_runs_the_real_tool(session, code):
    """Fail open. The agent behaves as it would with this uninstalled."""
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",),
        refuses_tool_with=RpcError(code, "gone"),
    )

    await mockable(agent, in_a_simulation(room), session)
    served = await called(
        couriers_on(session, agent)["check_calendar"], day="Tuesday", party_size=2
    )

    assert served == "really ran: Tuesday for 2"


async def test_a_census_egma_never_received_wraps_nothing(session, caplog):
    """An absent egma is discovered here, before any tool call."""
    agent = ReceptionAgent()
    before = agent.tools
    room = StubRoom(refuses_with=not_reached())

    with caplog.at_level("WARNING", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert all(now is then for now, then in zip(agent.tools, before, strict=True))
    assert EGMA_IDENTITY in caplog.text


async def test_a_late_attached_tool_falls_open_to_whatever_the_agent_has_now(session):
    """The only handle a courier with no captured original can offer.

    There was nothing to capture when it was made, so when egma turns out
    to be unreachable it looks the name up on the agent as it stands.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("book_appointment",),
        refuses_tool_with=not_reached(),
    )

    await mockable(agent, in_a_simulation(room), session)

    @function_tool
    async def book_appointment() -> str:
        """Book it for real."""
        return "really booked"

    await agent.update_tools([*agent.tools, book_appointment])

    assert await called(couriers_on(session, agent)["book_appointment"]) == (
        "really booked"
    )


async def test_a_late_attached_tool_that_needs_arguments_fails_rather_than_waits(
    session,
):
    """The corner where falling open cannot work, said plainly.

    egma was not reached, and the tool that turned up late wants
    arguments this call was never handed — because there was no
    signature to read them through. It ends in an error the model can
    hear, rather than a type error from somebody else's function that a
    developer has to work backwards from.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("book_appointment",), refuses_tool_with=not_reached())

    await mockable(agent, in_a_simulation(room), session)

    @function_tool
    async def book_appointment(day: str) -> str:
        """Book it for real.

        Args:
            day: The day to book.
        """
        return "really booked"

    await agent.update_tools([*agent.tools, book_appointment])

    with pytest.raises(ToolError) as raised:
        await called(couriers_on(session, agent)["book_appointment"])
    assert "book_appointment" in str(raised.value)


async def test_a_call_with_nothing_to_fall_back_on_fails_rather_than_waits(session):
    """No egma, and no tool of that name either.

    Somebody called a tool the agent does not have, which the framework
    would not normally allow — so this is the impossible corner. It ends
    in an error the model can hear, because every corner of this file
    must end somewhere and none of them may end in waiting.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("book_appointment",), refuses_tool_with=not_reached()
    )

    await mockable(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError):
        await called(couriers_on(session, agent)["book_appointment"])


# -- When egma refuses --------------------------------------------------------


@pytest.mark.parametrize(
    "refusal",
    [
        pytest.param(
            RpcError(seam.UNKNOWN_TOOL, "this simulation has no mock tool for it"),
            id="902 a name egma does not answer for",
        ),
        pytest.param(
            RpcError(seam.MALFORMED_REQUEST, "unreadable"),
            id="901 a message egma could not read",
        ),
        pytest.param(
            RpcError(seam.ANSWER_TOO_LARGE, "17000 bytes"),
            id="903 an answer too big for the wire",
        ),
        pytest.param(
            RpcError(RpcError.ErrorCode.RESPONSE_TIMEOUT, "took too long"),
            id="1502 egma took too long",
        ),
        pytest.param(
            RpcError(RpcError.ErrorCode.APPLICATION_ERROR, "handler blew up"),
            id="1500 egma's handler failed",
        ),
    ],
)
async def test_a_refusal_reaches_the_model_and_never_the_real_tool(session, refusal):
    """Every refusal ends the call, and none of them runs the real tool.

    egma answered — with a no. Running the real implementation on the
    back of a no would be the SDK deciding that a simulation may touch a
    real backend, which is the one decision it must never make: fail-open
    belongs to *not reaching* egma, never to being refused by it.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",), refuses_tool_with=refusal)

    await mockable(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError) as raised:
        await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")
    assert "check_calendar" in str(raised.value)
    assert refusal.message in str(raised.value)


async def test_a_census_egma_refuses_wraps_nothing_and_says_so(session, caplog):
    """egma is there and will not answer for anything.

    Nothing is wrapped, so every tool runs its own implementation — and
    egma's own record agrees, because a refused census covers nothing.
    The agent is never taken down over it: that would lose the simulation
    as well as the isolation.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        refuses_with=RpcError(seam.UNSUPPORTED_PROTOCOL_VERSION, "egma speaks 2")
    )

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert "egma speaks 2" in caplog.text
    assert await agent.read_notice() == "really ran: the notice"


# -- Replies this side cannot read --------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param("not json", id="not json"),
        pytest.param('["a","list"]', id="not an object"),
        pytest.param('{"protocol_version":1}', id="no names at all"),
        pytest.param('{"protocol_version":2,"mocked_tools":[]}', id="another version"),
        pytest.param(
            '{"protocol_version":true,"mocked_tools":["check_calendar"]}',
            id="a boolean, which python counts as one",
        ),
        pytest.param(
            '{"protocol_version":"1","mocked_tools":["check_calendar"]}',
            id="a version written as text",
        ),
        pytest.param(
            '{"mocked_tools":["check_calendar"]}', id="no version at all"
        ),
        pytest.param(
            '{"protocol_version":1,"mocked_tools":[7]}', id="a name that is a number"
        ),
    ],
)
async def test_a_census_reply_this_side_cannot_read_wraps_nothing(
    session, reply, caplog
):
    """Only the number itself will do, in the one place the number is read.

    The boolean is the parameter worth naming: Python counts ``True`` as
    equal to ``1``, so a reply carrying ``true`` would otherwise pass for
    version 1 and this side would stand couriers on the word of a far side
    that never said which exchange it was answering in. Each of these
    carries a real tool name, so the only thing that can refuse them is
    the version reading itself.
    """
    agent = ReceptionAgent()
    room = StubRoom(hello_reply=reply)

    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert couriers_on(session, agent) == {}
    assert seam.HELLO_METHOD in caplog.text


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param({}, id="neither tag"),
        pytest.param({"result": "ok"}, id="some other tag"),
        pytest.param({"error": {"code": 1}}, id="a failure that is not a sentence"),
    ],
)
async def test_an_answer_this_side_cannot_read_fails_rather_than_waits(session, reply):
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": reply}
    )

    await mockable(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError):
        await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")


async def test_a_call_too_big_for_one_message_is_refused_before_it_is_sent(session):
    """The cap is the same cap on both messages of the exchange.

    egma refuses an answer that would not fit rather than truncating it;
    this side refuses a call the same way. Refused here rather than by
    the transport, whose own complaint reaches the model as a tool that
    failed for no stated reason.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": answer("ok")}
    )

    await mockable(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError) as raised:
        await called(
            couriers_on(session, agent)["check_calendar"],
            day="x" * (seam.LARGEST_PAYLOAD_BYTES + 1),
        )

    assert str(seam.LARGEST_PAYLOAD_BYTES) in str(raised.value)
    # Never put on the wire, so egma was never asked and the real
    # calendar was never read either.
    assert room.tool_calls == []


async def test_a_census_too_big_for_one_message_wraps_nothing(session, caplog):
    """An agent with more tools than one message can name.

    Refused here rather than by the transport, whose own complaint would
    arrive as a census that mysteriously failed. Nothing is wrapped, so
    every tool runs its own implementation and the log names why.
    """
    agent = ReceptionAgent()

    @function_tool
    async def enormous(padding: str) -> str:
        """A tool whose description alone fills the wire.

        Args:
            padding: %s
        """
        return "ran"

    enormous.info.description = "x" * (seam.LARGEST_PAYLOAD_BYTES + 1)
    room = StubRoom(mocked_tools=("check_calendar",))

    await agent.update_tools([*agent.tools, enormous])
    with caplog.at_level("ERROR", logger="egma"):
        await mockable(agent, in_a_simulation(room), session)

    assert room.asked == []
    assert couriers_on(session, agent) == {}
    assert str(seam.LARGEST_PAYLOAD_BYTES) in caplog.text


# -- The message the far side has to be able to read --------------------------


async def test_every_message_is_one_compact_json_object(session):
    """What this side puts on the wire is what the far side parses.

    Asserted on the bytes rather than on a shape, because the two halves
    of this exchange are written in different languages and only the
    bytes are shared.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": answer("ok")}
    )

    await mockable(agent, in_a_simulation(room), session)
    await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")

    waits = {
        seam.HELLO_METHOD: seam.HELLO_TIMEOUT_SECONDS,
        seam.TOOL_METHOD: seam.RESPONSE_TIMEOUT_SECONDS,
    }
    for asked in room.asked:
        assert isinstance(json.loads(asked.payload), dict)
        assert ", " not in asked.payload
        assert len(asked.payload.encode()) <= seam.LARGEST_PAYLOAD_BYTES
        assert asked.identity == EGMA_IDENTITY
        assert asked.response_timeout == waits[asked.method]
        assert asked.max_round_trip_latency == seam.MAX_ROUND_TRIP_SECONDS
