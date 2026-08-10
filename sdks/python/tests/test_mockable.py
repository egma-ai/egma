"""The exchange, from the customer's seat: census, couriers, and answers.

Every test here runs against a room-shaped stand-in for egma's
participant, so the whole of the SDK's own code is exercised — the
metadata read, the census built off a real agent, the couriers stood in
LiveKit's own side table, the reply read, the fail-open — with no LiveKit
server and no network anywhere.

Where a courier is called, it is called the way the framework delivers a
call to one: through LiveKit's own argument trimming. That is the only
way the copied signature can be proved, because trimming is the very
thing the copy exists to survive.
"""

from __future__ import annotations

import json

import pytest
from conftest import ReceptionAgent, called, couriers_on, in_a_simulation
from livekit.agents import RunContext, ToolError, function_tool
from livekit.rtc import RpcError
from room_stub import EGMA_IDENTITY, StubRoom, not_reached

from egma import mockable, seam


def answer(value: object) -> dict:
    """What egma sends for an answer, tagged as the wire tags it."""
    return {"answer": value}


def failure(message: str) -> dict:
    """What egma sends for the branch a test forces on purpose."""
    return {"error": message}


# -- The census ---------------------------------------------------------------


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
    shorter than a delay a mock tool may legally declare."""
    agent = ReceptionAgent()
    room = StubRoom()

    await mockable(agent, in_a_simulation(room), session)

    assert room.asked[0].response_timeout == seam.RESPONSE_TIMEOUT_SECONDS
    assert room.asked[0].max_round_trip_latency == seam.MAX_ROUND_TRIP_SECONDS


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
            '{"protocol_version":1,"mocked_tools":[7]}', id="a name that is a number"
        ),
    ],
)
async def test_a_census_reply_this_side_cannot_read_wraps_nothing(
    session, reply, caplog
):
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

    for asked in room.asked:
        assert isinstance(json.loads(asked.payload), dict)
        assert ", " not in asked.payload
        assert len(asked.payload.encode()) <= seam.LARGEST_PAYLOAD_BYTES
        assert asked.identity == EGMA_IDENTITY
        assert asked.response_timeout == seam.RESPONSE_TIMEOUT_SECONDS
        assert asked.max_round_trip_latency == seam.MAX_ROUND_TRIP_SECONDS
