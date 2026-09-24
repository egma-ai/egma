"""Test simulation startup and mock-tool RPC against an offline room stub.
Failed startup raises NotReported; failed mock RPC never runs the real tool.
Invoke mocks through LiveKit argument trimming to verify copied signatures.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from conftest import (
    ReceptionAgent,
    called,
    couriers_on,
    in_a_simulation,
)
from livekit.agents import (
    AgentTask,
    CloseEvent,
    CloseReason,
    ConversationItemAddedEvent,
    ToolError,
    function_tool,
)
from livekit.agents.llm import AgentHandoff
from livekit.rtc import RpcError
from room_stub import (
    EGMA_IDENTITY,
    StubContext,
    StubRoom,
    not_reached,
    persona_in,
)

from egma import seam, simulation
from egma.simulation_room import NotReported


@pytest.fixture(autouse=True)
def exports(egma_export):
    """Every room here is a simulation room, so every one exports.

    The export is the first thing the verb installs, before a single
    message goes out, because the agent's spans are what Egma files as
    this simulation's agent POV. A test that did not arrange one would be
    testing a verb that raises for want of an endpoint.
    """
    return egma_export


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

    await simulation(agent, ctx, session)

    assert ctx.connect_calls == 1
    assert room.methods_asked == [seam.HELLO_METHOD]


# -- Finding egma in the room -------------------------------------------------


async def test_room_disconnect_ends_the_wait_for_egma(session):
    agent = ReceptionAgent()
    room = StubRoom(present=())
    waiting = asyncio.create_task(
        simulation(agent, in_a_simulation(room), session)
    )
    await asyncio.sleep(0)

    room.disconnect()

    with pytest.raises(NotReported, match="room disconnected"):
        await asyncio.wait_for(waiting, 0.2)
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

    await simulation(agent, in_a_simulation(room), session)

    assert room.asked[0].identity == persona
    assert set(couriers_on(session, agent)) == {"check_calendar"}


async def test_the_exact_persona_departure_closes_the_simulation_session(
    session, monkeypatch
):
    """The simulator can finish capture while the customer's entrypoint waits."""
    agent = ReceptionAgent()
    persona = persona_in()
    room = StubRoom(present=(persona, "somebody-else"))
    close = AsyncMock()
    monkeypatch.setattr(session, "aclose", close)

    await simulation(agent, in_a_simulation(room), session)
    room.depart("somebody-else")
    await asyncio.sleep(0)
    close.assert_not_awaited()

    room.depart(persona)
    await asyncio.sleep(0)

    close.assert_awaited_once_with()


async def test_room_loss_closes_the_simulation_session_and_removes_listeners(
    session, monkeypatch
):
    agent = ReceptionAgent()
    room = StubRoom()
    close = AsyncMock()
    monkeypatch.setattr(session, "aclose", close)

    await simulation(agent, in_a_simulation(room), session)
    room.disconnect()
    await asyncio.sleep(0)

    close.assert_awaited_once_with()
    session.emit("close", CloseEvent(reason=CloseReason.USER_INITIATED))
    assert room.listeners == {}


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

    with pytest.raises(NotReported) as refused:
        await simulation(agent, in_a_simulation(room), session)

    assert "not knowable" in str(refused.value)
    assert couriers_on(session, agent) == {}
    # Not one word on the wire: the census is this agent's whole tool
    # inventory, and it is never sent to somebody who might not be egma.
    assert room.asked == []


@pytest.mark.parametrize(
    "identity",
    [
        pytest.param("egma-personality-quiz", id="a name that merely starts alike"),
        pytest.param("caller-8871", id="an ordinary caller"),
        # The separator with nothing after it. It names no simulation, so
        # it is a prefix rather than an identity — and the census is this
        # agent's whole tool inventory.
        pytest.param("egma-persona-", id="the separator naming no simulation"),
    ],
)
async def test_a_participant_who_is_not_egma_is_never_asked(
    session, identity
):
    """Only exact Egma participant names may receive tool schemas.
    Unrelated prefix matches must never receive the census.
    """
    agent = ReceptionAgent()
    room = StubRoom(present=(identity,), mocked_tools=("check_calendar",))
    waiting = asyncio.create_task(
        simulation(agent, in_a_simulation(room), session)
    )
    await asyncio.sleep(0)
    room.disconnect()

    with pytest.raises(NotReported):
        await waiting

    assert couriers_on(session, agent) == {}
    assert room.asked == []


@pytest.mark.parametrize("code", [1400, 1502])
async def test_a_transient_hello_failure_retries_the_same_census(session, code):
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",),
        hello_failures=[RpcError(code, "one hello attempt was lost")],
    )

    await simulation(agent, in_a_simulation(room), session)

    assert room.methods_asked == [seam.HELLO_METHOD, seam.HELLO_METHOD]
    assert room.asked[0].payload == room.asked[1].payload
    assert set(couriers_on(session, agent)) == {"check_calendar"}


async def test_a_census_is_asked_again_until_the_room_ends(session):
    """Transient setup keeps trying while the simulation room is active."""
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",), refuses_hello_until=10_000)
    waiting = asyncio.create_task(
        simulation(agent, in_a_simulation(room), session)
    )
    await room.second_hello_started.wait()
    room.disconnect()

    with pytest.raises(NotReported) as refused:
        await waiting

    assert "room disconnected" in str(refused.value)
    assert couriers_on(session, agent) == {}
    assert room.methods_asked


# -- What a mocked call comes back with ---------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(None, id="nothing at all"),
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

    await simulation(agent, in_a_simulation(room), session)
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

    await simulation(agent, in_a_simulation(room), session)

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

    await simulation(agent, in_a_simulation(room), session)
    served = await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")

    assert served == looks_like


# -- The signature copy -------------------------------------------------------


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

    await simulation(agent, in_a_simulation(room), session)
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

    await simulation(agent, in_a_simulation(room), session)

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

    await simulation(agent, in_a_simulation(room), session)

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

    await simulation(agent, in_a_simulation(room), session)
    try:
        await session.start(agent=agent)
        session.update_agent(HandoffProbeTask(observed))
        assert await asyncio.wait_for(observed, timeout=1)
    finally:
        await session.aclose()


# -- When egma is not reached: the five codes that used to fall open ----------
#
# These are the transport's own way of saying nobody was there to ask,
# and they used to mean "run the real tool". In a simulation room they do
# not any more. A wrapped tool exists because this simulation answers for
# it, so running its real implementation books the real appointment and
# charges the real card — the one thing a test may never do. An Egma this
# side cannot reach mid-conversation is exactly when a real backend must
# be left alone.


@pytest.mark.parametrize(
    "code",
    [
        pytest.param(RpcError.ErrorCode.RECIPIENT_NOT_FOUND, id="1401 nobody there"),
    ],
)
async def test_a_call_egma_never_received_errors_and_never_runs_the_real_tool(
    session, code
):
    """Fail closed. The model hears a tool that failed, and nothing ran.

    ``check_calendar`` answers ``"really ran: …"`` when its own
    implementation runs, so the assertion that it did not is the whole
    point of that string.
    """
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",),
        refuses_tool_with=RpcError(code, "gone"),
    )

    await simulation(agent, in_a_simulation(room), session)
    with pytest.raises(ToolError) as raised:
        await called(
            couriers_on(session, agent)["check_calendar"],
            day="Tuesday",
            party_size=2,
        )

    assert "check_calendar" in str(raised.value)
    assert "really ran" not in str(raised.value)


async def test_a_census_egma_never_received_ends_the_simulation(session):
    """An absent egma is discovered here, before any tool call."""
    agent = ReceptionAgent()
    before = agent.tools
    room = StubRoom(refuses_with=not_reached())

    with pytest.raises(NotReported) as refused:
        await simulation(agent, in_a_simulation(room), session)

    assert EGMA_IDENTITY in str(refused.value)
    assert couriers_on(session, agent) == {}
    assert all(now is then for now, then in zip(agent.tools, before, strict=True))


# -- When egma refuses --------------------------------------------------------


@pytest.mark.parametrize(
    "refusal",
    [
        pytest.param(
            RpcError(seam.UNKNOWN_TOOL, "this simulation has no mock tool for it"),
            id="902 a name egma does not answer for",
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

    await simulation(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError) as raised:
        await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")
    assert "check_calendar" in str(raised.value)
    assert refusal.message in str(raised.value)


# -- Replies this side cannot read --------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param('{"protocol_version":1}', id="no names at all"),
        pytest.param('{"protocol_version":2,"mocked_tools":[]}', id="another version"),
    ],
)
async def test_a_census_reply_this_side_cannot_read_ends_the_simulation(
    session, reply
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

    with pytest.raises(NotReported) as refused:
        await simulation(agent, in_a_simulation(room), session)

    assert seam.HELLO_METHOD in str(refused.value)
    assert couriers_on(session, agent) == {}


@pytest.mark.parametrize(
    "reply",
    [
        pytest.param({}, id="neither tag"),
    ],
)
async def test_an_answer_this_side_cannot_read_fails_rather_than_waits(session, reply):
    agent = ReceptionAgent()
    room = StubRoom(
        mocked_tools=("check_calendar",), answers={"check_calendar": reply}
    )

    await simulation(agent, in_a_simulation(room), session)

    with pytest.raises(ToolError):
        await called(couriers_on(session, agent)["check_calendar"], day="Tuesday")


# -- What Egma is told about this simulation ----------------------------------
#
# The agent's own spans are the second POV of a simulation, and the only
# one that knows what the agent's model did, how long each stage took and
# which tools really ran. They travel by the ordinary OpenTelemetry road —
# the same door production monitoring posts to — and what makes them a
# simulation's rather than a conversation's is one attribute: the room's
# name, which Egma matches back to the simulation that opened that room.


async def test_a_second_simulation_in_one_process_is_refused(session, egma_export):
    """One job per process, said where it can still be acted on.

    A provider's resource is fixed when it is built and LiveKit's metadata
    processor goes on once, so the room this process exports under is
    decided by the first job. A second room in the same process would file
    one conversation's spans under another conversation's name, so it is
    refused instead.
    """
    agent = ReceptionAgent()
    room = StubRoom(mocked_tools=("check_calendar",))

    await simulation(agent, in_a_simulation(room), session)

    with pytest.raises(ValueError) as refused:
        await simulation(
            ReceptionAgent(),
            StubContext(StubRoom(), "egma-sim-sim-sdk-0002"),
            session,
        )

    assert "one job per process" in str(refused.value)


@pytest.mark.parametrize(
    "missing",
    [
        pytest.param("EGMA_API_KEY", id="no key"),
    ],
)
async def test_a_simulation_with_nowhere_to_report_raises_before_it_connects(
    session, egma_export, monkeypatch, missing
):
    """The SDK is required, so its settings are required with it.

    A simulation room whose worker cannot say where Egma is has no way to
    report the agent's POV, and no way to be told which tools to wrap
    either. It stops here, before the room is connected and before a word
    is sent.
    """
    monkeypatch.delenv(missing)
    agent = ReceptionAgent()
    room = StubRoom(connected=False, mocked_tools=("check_calendar",))
    ctx = in_a_simulation(room)

    with pytest.raises(ValueError) as refused:
        await simulation(agent, ctx, session)

    assert missing in str(refused.value)
    assert ctx.connect_calls == 0
    assert room.asked == []
    assert couriers_on(session, agent) == {}
