"""The Retell text mode plug against a text-mode-shaped server.

The plug is the one component that speaks a platform's wire protocol, so
what is pinned here is the wire: the whole history on every request because
the platform keeps none of it, the version named every time because its
default moves, egma's own answers riding along as native mocks, and the
resume state threaded turn by turn. The counterpart is a real HTTP server
shaped like the completion API, on loopback — no account, no key, no
network.

What the plug **saw** is pinned beside it, at the seam that writes it down:
every tool call the platform reported reaches the mock-tool seam, marked
``mocked`` exactly where the run's snapshot covers the name. The record
those become is proved end to end in the acceptance suite; here the
question is what the plug hands over.

The failure paths get the same treatment, because they are where a
credential leaks if it ever does: a throttle, a billing wall, a key the
platform refuses, and a platform careless enough to say the key back all
end in a refusal a person can act on, and none of them says the key.
"""

from __future__ import annotations

import asyncio

import pytest
from text_mode_stub import Reply, ToolTurn

from egma_simulator.mock_tools import MockToolSeam
from egma_simulator.plugs import AgentReply, PlugError, plug_for
from egma_simulator.plugs.retell import DEFAULT_BASE_URL
from egma_simulator.plugs.retell_text_mode import (
    MATCH_ANYTHING,
    RATE_LIMIT_RETRIES,
    RetellTextMode,
)
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import MockTool

SENTINEL_KEY = "SENTINEL-text-mode-key-4b7e1c9a2f6d"

UNSET = object()
"""What "the spec carried nothing here" looks like to the builder below,
told apart from an explicit ``None`` that a test means to hand over."""


def seam(*mocks: MockTool) -> MockToolSeam:
    """One run's resolved answers, as the claimed spec would carry them."""
    return MockToolSeam(mocks)


def answering(name: str, value: object, *, delay_milliseconds: int = 0) -> MockTool:
    return MockTool(
        tool_name=name,
        answer={"answer": value},
        delay_milliseconds=delay_milliseconds,
    )


def failing(name: str, value: object) -> MockTool:
    return MockTool(tool_name=name, answer={"error": value}, delay_milliseconds=0)


def text_mode(
    config: dict,
    *,
    modality: str = "chat",
    access_variant: str = "retell_text_mode.api_key",
    key: str | None = SENTINEL_KEY,
    agent_version: object = UNSET,
    dynamic_variables: object = UNSET,
    mock_tools: object = UNSET,
) -> RetellTextMode:
    credentials = None if key is None else {"apiKey": key}
    carried: dict = {}
    if agent_version is not UNSET:
        carried["agent_version"] = agent_version
    if dynamic_variables is not UNSET:
        carried["dynamic_variables"] = dynamic_variables
    if mock_tools is not UNSET:
        carried["mock_tools"] = mock_tools
    return RetellTextMode(
        modality=modality,
        access_variant=access_variant,
        config=config,
        credentials=credentials,
        **carried,
    )


def test_the_registry_knows_the_text_mode_plug():
    assert plug_for("retell_text_mode") is RetellTextMode


def test_a_connection_saying_nothing_about_where_reaches_retell_itself():
    """The base URL is the plug's own optional key; absent, it is the
    platform, which is what every real connection block will mean."""
    plug = text_mode({"retellAgentId": "agent_1"})
    assert plug.base_url == DEFAULT_BASE_URL == "https://api.retellai.com"


def test_the_agent_is_named_in_the_path_and_escaped_there():
    """The agent's id is somebody else's string, and it goes in a URL."""
    plug = text_mode({"retellAgentId": "agent one/two"})
    assert plug.completion_path == "/agent-playground-completion/agent%20one%2Ftwo"


# -- The exchange ------------------------------------------------------------


async def test_the_agent_opens_and_the_plug_conducts_the_whole_exchange(
    start_text_mode_stub,
):
    """A full conduct: the opening line, two delivered turns, and the whole
    history on every request because the platform keeps none of it."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(words="Lakeside Dental, how can I help?"),
            Reply(words="Of course — could I take your name?"),
            Reply(words="Booked for Thursday."),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_lakeside", "baseUrl": running.base_url},
        mock_tools=seam(),
    )

    assert (await plug.open()).text == "Lakeside Dental, how can I help?"
    assert await plug.deliver("I need to move my cleaning.") == AgentReply(
        text="Of course — could I take your name?", ended=False
    )
    assert await plug.deliver("Margaret Hale.") == AgentReply(
        text="Booked for Thursday.", ended=False
    )
    await plug.close()

    stub = running.stub
    assert [request["agent_id"] for request in stub.requests] == ["agent_lakeside"] * 3
    # The open carries nothing said yet; every request after it carries the
    # whole conversation, the agent's own messages included and verbatim.
    histories = stub.histories()
    assert histories[0] == []
    assert [message["role"] for message in histories[1]] == ["agent", "user"]
    assert [message["role"] for message in histories[2]] == [
        "agent",
        "user",
        "agent",
        "user",
    ]
    assert stub.delivered() == ["I need to move my cleaning.", "Margaret Hale."]


async def test_an_agent_with_nothing_to_say_first_lets_the_persona_open(
    start_text_mode_stub,
):
    """The silent open: the request is still made — an agent that speaks
    first has to be given the chance — and nothing comes back."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, replies=[Reply(), Reply(words="Yes?")]
    )
    plug = text_mode(
        {"retellAgentId": "agent_quiet", "baseUrl": running.base_url},
        mock_tools=seam(),
    )

    assert (await plug.open()).text is None
    assert (await plug.deliver("Hello?")).text == "Yes?"
    await plug.close()

    assert running.stub.histories()[0] == []


async def test_several_bubbles_in_one_reply_stay_one_turn(start_text_mode_stub):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words=["Let me look.", "Thursday works."])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    assert (await plug.deliver("Anything Thursday?")).text == (
        "Let me look.\nThursday works."
    )
    await plug.close()


async def test_a_reply_that_carried_no_words_is_an_answer_without_words(
    start_text_mode_stub,
):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(tools=[ToolTurn(name="check_calendar")])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    assert await plug.deliver("Anything Thursday?") == AgentReply(text=None)
    await plug.close()


# -- How it ends -------------------------------------------------------------


async def test_the_agent_ending_the_exchange_is_read_from_the_flag(
    start_text_mode_stub,
):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="Goodbye then.", ends=True)],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    assert await plug.deliver("That is all.") == AgentReply(
        text="Goodbye then.", ended=True
    )
    await plug.close()


async def test_an_end_tool_ends_the_exchange_even_without_the_flag(
    start_text_mode_stub,
):
    """The same fact said the other way: a Retell agent ends any exchange by
    invoking its end tool, and a reply carrying one has ended."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="Bye.", tools=[ToolTurn(name="end_call")])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    assert (await plug.deliver("That is all.")).ended is True
    await plug.close()


async def test_an_agent_that_ended_on_its_opening_is_not_argued_with(
    start_text_mode_stub,
):
    """Rare and real — "we are closed today" and a goodbye. The ending is
    reported rather than a request being sent into an exchange that is over."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, replies=[Reply(words="We are closed today.", ends=True)]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    assert (await plug.open()).text == "We are closed today."
    assert await plug.deliver("Oh — can I book for tomorrow?") == AgentReply(
        text=None, ended=True
    )
    await plug.close()

    assert len(running.stub.requests) == 1, "no request continues an ended exchange"


async def test_the_walk_keeps_its_own_limits(start_text_mode_stub):
    """Nothing here ends an exchange that the agent did not end: a plug that
    keeps answering is a walk that runs out of turns instead, which is the
    walk's job and never the agent failing."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, replies=[Reply(), Reply(words="Still here.")]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    for _ in range(4):
        assert (await plug.deliver("And?")).ended is False
    await plug.close()


# -- The version, the variables, and the resume state ------------------------


@pytest.mark.parametrize("version", [106, "latest", "  latest  ", "prod"])
async def test_every_request_names_the_version_the_spec_named(
    start_text_mode_stub, version
):
    """Named every time, never once: Retell's default is the newest version,
    and a version created between two turns would move the agent under test
    mid-conversation."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, replies=[Reply(), Reply(words="Yes.")]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url},
        agent_version=version,
        mock_tools=seam(),
    )

    await plug.open()
    await plug.deliver("Hello?")
    await plug.close()

    wanted = version.strip() if isinstance(version, str) else version
    assert [request["agent_version"] for request in running.stub.requests] == [
        wanted,
        wanted,
    ]


async def test_a_spec_carrying_no_version_asks_for_none(start_text_mode_stub):
    running = await start_text_mode_stub(api_key=SENTINEL_KEY, replies=[Reply()])
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    await plug.close()

    assert "agent_version" not in running.stub.requests[0]["body"]


@pytest.mark.parametrize(
    "variables_key", ["retell_llm_dynamic_variables", "dynamic_variables"]
)
async def test_a_reply_updates_this_simulations_variables_without_dropping_them(
    start_text_mode_stub, variables_key
):
    """Out byte for byte, and back **over** what was already held.

    A variable the agent set on turn two is set on turn three, because the
    platform keeps nothing. And a variable it did not mention is still
    set: whether a reply names every variable or only the ones that
    changed is not documented anywhere, so a reply that names one is read
    as naming one — which is what keeps egma's own attribution variable on
    every request instead of vanishing after the first change.

    Both names a reply might carry them under are exercised, because which
    one a real reply uses is a guess until the developer's live run.
    """
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Found you.",
                variables={"caller_name": "Margaret"},
                variables_key=variables_key,
            ),
            Reply(words="Booked."),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url},
        dynamic_variables={"egma_simulation": "sim_01", "caller_name": ""},
        mock_tools=seam(),
    )

    await plug.open()
    await plug.deliver("It's Margaret.")
    await plug.deliver("Thursday please.")
    await plug.close()

    carried = [
        request["body"].get("retell_llm_dynamic_variables")
        for request in running.stub.requests
    ]
    assert carried[0] == {"egma_simulation": "sim_01", "caller_name": ""}
    assert carried[1] == {"egma_simulation": "sim_01", "caller_name": ""}
    assert carried[2] == {"egma_simulation": "sim_01", "caller_name": "Margaret"}
    # The one that must never fall off: it is what a tool call the platform
    # makes rides back to this simulation on.
    assert all(
        variables["egma_simulation"] == "sim_01" for variables in carried
    ), carried


async def test_a_spec_carrying_no_variables_sends_no_variable_block(
    start_text_mode_stub,
):
    """Absent stays absent: an empty block is a value Retell would render."""
    running = await start_text_mode_stub(api_key=SENTINEL_KEY, replies=[Reply()])
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url},
        dynamic_variables={},
        mock_tools=seam(),
    )

    await plug.open()
    await plug.close()

    assert "retell_llm_dynamic_variables" not in running.stub.requests[0]["body"]


async def test_the_resume_state_is_threaded_across_turns(start_text_mode_stub):
    """A flow that moved node, and moved again into a component: each reply's
    state rides the next request under the platform's own names."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(words="Hello.", node="greet"),
            Reply(words="Checking.", node="lookup", component="verify_caller"),
            Reply(words="Done."),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_flow", "baseUrl": running.base_url},
        mock_tools=seam(),
    )

    await plug.open()
    await plug.deliver("It's Margaret.")
    await plug.deliver("Thursday please.")
    await plug.close()

    bodies = [request["body"] for request in running.stub.requests]
    assert "current_node_id" not in bodies[0], "nothing is resumed before anything ran"
    assert bodies[1]["current_node_id"] == "greet"
    assert "current_component_id" not in bodies[1]
    assert bodies[2]["current_node_id"] == "lookup"
    assert bodies[2]["current_component_id"] == "verify_caller"


async def test_a_retell_llm_threads_its_state_the_same_way(start_text_mode_stub):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(words="Hi.", state="collect_details"), Reply(words="Done.")],
    )
    plug = text_mode(
        {"retellAgentId": "agent_llm", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    await plug.deliver("Margaret here.")
    await plug.close()

    assert running.stub.requests[1]["body"]["current_state"] == "collect_details"


async def test_a_transition_the_platform_announces_lands_on_the_turn(
    start_text_mode_stub,
):
    """A node transition is a message in a role the record does not know, so
    it is preserved verbatim as agent-side content — which is how a
    transition gets onto the record at all."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="One moment.", node="lookup_caller")],
    )
    plug = text_mode(
        {"retellAgentId": "agent_flow", "baseUrl": running.base_url},
        mock_tools=seam(),
    )

    await plug.open()
    answered = await plug.deliver("It's Margaret.")
    await plug.close()

    # Beside the turn, never in it: the persona is handed the words back,
    # and a transition read as speech is a conversation nobody had.
    assert answered.text == "One moment."
    assert answered.platform_notes == ("moved to lookup_caller",)


async def test_a_role_the_record_does_not_know_reads_back_verbatim(
    start_text_mode_stub,
):
    """Never dropped silently: a platform growing a fifth role must not cost
    this simulation part of its transcript."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Sent.",
                extra=[{"role": "sms", "content": "Your booking: Thu 14:30"}],
            ),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    answered = await plug.deliver("Text it to me.")
    await plug.close()

    assert answered.text == "Sent."
    assert answered.platform_notes == ("Your booking: Thu 14:30",)


async def test_a_platform_that_echoes_the_persona_does_not_make_it_speak_twice(
    start_text_mode_stub,
):
    """Egma owns the persona's side of the history. A platform that repeats
    the turn it was just given is repeating what is already written down,
    and keeping the echo would have the caller say everything twice from
    the next request onward."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Thursday, then.",
                extra=[{"role": "user", "content": "Anything Thursday?"}],
            ),
            Reply(words="Booked."),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    answered = await plug.deliver("Anything Thursday?")
    await plug.deliver("Yes please.")
    await plug.close()

    # Not the agent's words either: the record knows this role, so it is
    # neither spoken nor preserved as something nobody understood.
    assert answered.text == "Thursday, then."
    assert [
        (message["role"], message["content"])
        for message in running.stub.histories()[2]
    ] == [
        ("user", "Anything Thursday?"),
        ("agent", "Thursday, then."),
        ("user", "Yes please."),
    ]


async def test_a_message_with_nothing_a_record_can_read_is_still_kept(
    start_text_mode_stub,
):
    """The whole message where it carries no words of its own: the
    alternative is throwing away something the platform meant to say."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(extra=[{"role": "beeped", "digits": "1"}])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    answered = await plug.deliver("Press one.")
    await plug.close()

    assert answered.text is None
    assert answered.platform_notes == ('{"role":"beeped","digits":"1"}',)


# -- Mock tools ride the request ---------------------------------------------


async def test_egmas_answers_ride_every_request_as_native_mocks(
    start_text_mode_stub,
):
    """One answer per tool, matched by name with the match-anything rule —
    the arguments are never read, here as everywhere."""
    running = await start_text_mode_stub(api_key=SENTINEL_KEY, replies=[Reply()])
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url},
        mock_tools=seam(
            answering("check_calendar", {"slots": []}),
            failing("book_appointment", "the booking service is down"),
        ),
    )

    await plug.open()
    await plug.close()

    assert running.stub.mocks()[0] == [
        {
            "tool_name": "check_calendar",
            "input_match_rule": MATCH_ANYTHING,
            "output": '{"slots":[]}',
            "result": True,
        },
        {
            "tool_name": "book_appointment",
            "input_match_rule": MATCH_ANYTHING,
            "output": '"the booking service is down"',
            "result": False,
        },
    ]


async def test_a_run_that_mocks_nothing_sends_no_mocks(start_text_mode_stub):
    running = await start_text_mode_stub(api_key=SENTINEL_KEY, replies=[Reply()])
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    await plug.open()
    await plug.close()

    assert "tool_mocks" not in running.stub.requests[0]["body"]


async def test_a_covered_call_is_marked_mocked_and_an_uncovered_one_is_not(
    start_text_mode_stub,
):
    """The whole honesty claim of this lane, at the tool grain: the platform
    served egma's answer for the covered name and the customer's own backend
    for the other, and the record says which was which."""
    answers = seam(answering("check_calendar", {"slots": ["thu-1430"]}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Thursday at half two?",
                tools=[
                    ToolTurn(name="check_calendar", arguments='{"day":"thu"}'),
                    ToolTurn(
                        name="lookup_customer",
                        arguments='{"phone":"+1"}',
                        real_result='{"customer":"real"}',
                    ),
                ],
            ),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    answered = await plug.deliver("Anything Thursday?")
    await plug.close()

    # Nothing rides back on the reply itself: the seam is the one writer
    # that can stamp a call, and two writers would record each call twice.
    assert answered.tool_calls == ()

    exchanged = answers.exchanged()
    assert [(call.name, call.mock_tool) for call in exchanged] == [
        ("check_calendar", "check_calendar"),
        ("lookup_customer", None),
    ]
    mocked, real = exchanged
    assert mocked.arguments == '{"day":"thu"}'
    assert mocked.answer == '{"slots":["thu-1430"]}'
    assert mocked.refused is False and mocked.late_attached is False
    # The uncovered call is on the record as the observation it is: what was
    # called, with what — and no stamp, which is the record's own way of
    # saying a real backend did the work.
    assert real.arguments == '{"phone":"+1"}'
    assert real.answer is None

    assert answers.coverage() == {
        "discovered": ["check_calendar", "lookup_customer"],
        "covered": ["check_calendar"],
        "uncovered": ["lookup_customer"],
    }


async def test_a_mocked_failure_reads_back_as_a_failure_not_a_string(
    start_text_mode_stub,
):
    """The tag stays on the record for the failure branch, exactly as it
    does on the room lane, so one authored world reads the same on both."""
    answers = seam(failing("book_appointment", {"code": 503}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="Sorry — I could not book that.",
                                tools=[ToolTurn(name="book_appointment")])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    await plug.deliver("Book it.")
    await plug.close()

    (call,) = answers.exchanged()
    assert call.answer == '{"error":{"code":503}}'
    assert call.mock_tool == "book_appointment"


async def test_a_platform_that_ignored_the_mocks_fails_instead_of_being_stamped(
    start_text_mode_stub,
):
    """The one guess on this lane that could cost a customer their isolation.

    That text mode honours a field egma sends it is unverified until
    the developer's live run, and a JSON API that does not know
    ``tool_mocks`` commonly ignores it — in which case the real backend
    runs and nothing on the wire says so. The only evidence is that the
    tool was given something other than what egma sent, so that is checked
    before any call is stamped, and a mismatch stops the simulation rather
    than reporting it as isolated.
    """
    answers = seam(answering("check_calendar", {"slots": ["thu-1430"]}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        ignores_tool_mocks=True,
        replies=[
            Reply(),
            Reply(
                words="Nothing free, sorry.",
                tools=[ToolTurn(name="check_calendar", real_result='{"slots":[]}')],
            ),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    with pytest.raises(PlugError) as refusal:
        await plug.deliver("Anything Thursday?")
    await plug.close()

    told = str(refusal.value)
    assert "check_calendar" in told
    assert "real implementation ran" in told, told
    # The refusal names the tool and neither answer: one is the customer's
    # authored data and the other their backend's.
    assert "thu-1430" not in told and "slots" not in told
    # And nothing was stamped: a call Egma cannot vouch for is not on the
    # record as one Egma answered.
    assert [call.mock_tool for call in answers.exchanged()] == []


async def test_a_covered_call_the_platform_says_nothing_about_is_not_stamped(
    start_text_mode_stub,
):
    """The same rule where the evidence is missing rather than wrong: Egma
    cannot confirm its answer was served, so it will not claim it was."""
    answers = seam(answering("check_calendar", {"slots": []}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Checked.",
                extra=[
                    {
                        "role": "tool_call_invocation",
                        "tool_call_id": "call_with_no_result",
                        "name": "check_calendar",
                        "arguments": "{}",
                    }
                ],
            ),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    with pytest.raises(PlugError, match="cannot confirm"):
        await plug.deliver("Anything Thursday?")
    await plug.close()


async def test_an_answer_spelled_differently_by_the_platform_still_counts(
    start_text_mode_stub,
):
    """Two equivalent JSON documents are one answer. A platform that
    re-serializes egma's answer with spaces in it, or its keys the other
    way round, has still served it — and failing a working simulation over
    whitespace would be the check doing more harm than the hole it
    closes."""
    answers = seam(answering("check_calendar", {"slots": [], "open": True}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Checked.",
                extra=[
                    {
                        "role": "tool_call_invocation",
                        "tool_call_id": "respelled",
                        "name": "check_calendar",
                        "arguments": "{}",
                    },
                    {
                        "role": "tool_call_result",
                        "tool_call_id": "respelled",
                        "content": '{"open": true,  "slots": []}',
                    },
                ],
            ),
        ],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    await plug.deliver("Anything Thursday?")
    await plug.close()

    (call,) = answers.exchanged()
    assert call.mock_tool == "check_calendar"


async def test_a_declared_delay_is_not_spent_on_this_lane(start_text_mode_stub):
    """Delays are speech-world fidelity — the layer chat deliberately
    excludes — and the answer is served inside Retell's own execution
    anyway, where egma has nothing to hold back."""
    answers = seam(answering("check_calendar", {}, delay_milliseconds=30_000))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="Checked.", tools=[ToolTurn("check_calendar")])],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    await plug.open()
    async with asyncio.timeout(10):
        await plug.deliver("Anything Thursday?")
    await plug.close()

    (call,) = answers.exchanged()
    assert call.mock_tool == "check_calendar"


async def test_a_simulation_reaching_no_platform_claims_no_coverage(
    start_text_mode_stub,
):
    """A request that never landed put egma in nobody's tool path, and the
    stamp is the one thing that must never claim otherwise."""
    answers = seam(answering("check_calendar", {}))
    running = await start_text_mode_stub(
        api_key="the-only-key-this-stub-honors", replies=[Reply()]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=answers
    )

    with pytest.raises(PlugError):
        await plug.open()
    await plug.close()

    assert answers.coverage() is None


# -- Errors, loud and without the key ----------------------------------------


async def test_a_throttle_retries_a_bounded_number_of_times_then_fails_loudly(
    start_text_mode_stub, quick_text_mode_backoff
):
    """A run that quietly waited out a throttle would report a shorter
    exchange than the test asked for, with nothing to say why."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, refusals=(429,) * 10, replies=[Reply()]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    assert len(running.stub.requests) == RATE_LIMIT_RETRIES + 1
    told = str(refusal.value)
    assert "429" in told and "throttled" in told
    assert "rate limit" in told, told
    assert SENTINEL_KEY not in told


async def test_a_throttle_that_lets_up_is_conducted_through(
    start_text_mode_stub, quick_text_mode_backoff
):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        refusals=(429, 429),
        replies=[Reply(words="Lakeside Dental.")],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    assert (await plug.open()).text == "Lakeside Dental."
    await plug.close()

    assert len(running.stub.requests) == 3


async def test_a_throttle_that_says_how_long_to_wait_is_waited_out_that_long(
    start_text_mode_stub, monkeypatch
):
    """A throttled platform saying how long it wants is worth more than any
    number egma could pick — bounded, because a header is not a promise
    this process has to keep for minutes."""
    from egma_simulator.plugs import retell_text_mode

    monkeypatch.setattr(retell_text_mode, "FIRST_BACKOFF_SECONDS", 0.001)
    monkeypatch.setattr(retell_text_mode, "LONGEST_BACKOFF_SECONDS", 0.05)
    slept: list[float] = []

    async def remember(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(retell_text_mode.asyncio, "sleep", remember)

    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        refusals=(429, 429),
        retry_after="600",
        replies=[Reply(words="Lakeside Dental.")],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    assert (await plug.open()).text == "Lakeside Dental."
    await plug.close()

    # Asked for ten minutes, capped: the wait is the platform's wish held
    # to what a simulation can afford.
    assert slept == [0.05, 0.05]


@pytest.mark.parametrize("retry_after", ["not-a-number", "0", "-5"])
async def test_a_retry_after_egma_cannot_use_falls_back_to_the_backoff(
    start_text_mode_stub, quick_text_mode_backoff, retry_after
):
    """An HTTP date, a nonsense value, a zero: egma's own doubling backoff
    is a perfectly good answer without any of them."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        refusals=(429,),
        retry_after=retry_after,
        replies=[Reply(words="Lakeside Dental.")],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    assert (await plug.open()).text == "Lakeside Dental."
    await plug.close()


async def test_a_billing_wall_fails_naming_the_billing(start_text_mode_stub):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, refusals=(402,), replies=[Reply()]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert "402" in told and "billed" in told and "billing" in told
    assert len(running.stub.requests) == 1, "a billing wall is not retried"
    assert SENTINEL_KEY not in told


async def test_a_key_the_platform_refuses_fails_without_saying_the_key(
    start_text_mode_stub,
):
    running = await start_text_mode_stub(api_key="the-only-key-this-stub-honors")
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert "401" in told and running.base_url in told
    assert SENTINEL_KEY not in told


async def test_a_platform_that_says_the_key_back_is_quoted_without_it(
    start_text_mode_stub,
):
    """A platform careless enough to echo the key would otherwise put it in
    a failure reason and in the traceback logged beneath it."""
    running = await start_text_mode_stub(
        api_key="the-only-key-this-stub-honors", echo_key_in_refusal=True
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert SENTINEL_KEY not in told
    assert REDACTED in told, told


async def test_a_throttle_that_says_the_key_back_is_quoted_without_it(
    start_text_mode_stub, quick_text_mode_backoff
):
    """The same discipline on the failing path this lane adds — a throttle is
    where a busy account meets a careless error body."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        refusals=(429,) * 10,
        echo_key_in_refusal=True,
        replies=[Reply()],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert SENTINEL_KEY not in told
    assert REDACTED in told, told


async def test_a_platform_that_answers_nowhere_fails_without_saying_the_key():
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": "http://127.0.0.1:1"},
        mock_tools=seam(),
    )

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    assert SENTINEL_KEY not in str(refusal.value)
    assert "unreachable" in str(refusal.value)


async def test_a_reply_with_no_messages_is_refused_rather_than_read_as_silence(
    start_text_mode_stub,
):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, answers_without_messages=True
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    with pytest.raises(PlugError, match="no messages list"):
        await plug.open()
    await plug.close()


async def test_a_turn_before_the_exchange_opened_is_refused():
    plug = text_mode({"retellAgentId": "agent_1"}, mock_tools=seam())

    with pytest.raises(PlugError, match="before the exchange opened"):
        await plug.deliver("Hello?")


async def test_closing_an_exchange_that_was_never_opened_is_safe():
    plug = text_mode({"retellAgentId": "agent_1"}, mock_tools=seam())
    await plug.close()
    await plug.close()


# -- What the record claims about this lane ----------------------------------


async def test_this_lane_offers_no_provider_reference_ever(start_text_mode_stub):
    """Text mode stores nothing, so there is no id either side could
    look this exchange up by — and an id only egma has seen is not a join."""
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY, replies=[Reply(words="Hello."), Reply(words="Yes.")]
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )

    assert plug.provider_reference is None
    await plug.open()
    assert plug.provider_reference is None
    await plug.deliver("Hello?")
    assert plug.provider_reference is None
    await plug.close()
    assert plug.provider_reference is None


# -- Config, credentials, and the modality it speaks -------------------------


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"retellAgentId": ""},
        {"retellAgentId": "   "},
        {"retellAgentId": 7},
        {"retellAgentId": "agent_1", "baseUrl": ""},
        {"retellAgentId": "agent_1", "roomHost": "wss://somewhere"},
        {"agentId": "agent_1"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        text_mode(config)


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        text_mode({"retellAgentId": "agent_1", "retellAgentID": "agent_2"})
    assert "retellAgentID" in str(refusal.value)


@pytest.mark.parametrize(
    "credentials",
    [None, {}, {"apiKey": ""}, {"apiKey": 7}, {"apiKey": "k", "apiSecret": "s"}],
)
def test_credentials_of_the_wrong_shape_are_refused(credentials):
    with pytest.raises(PlugError):
        RetellTextMode(
            modality="chat",
            access_variant="retell_text_mode.api_key",
            config={"retellAgentId": "agent_1"},
            credentials=credentials,
        )


def test_a_credential_refusal_names_the_key_and_never_its_value():
    with pytest.raises(PlugError) as refusal:
        RetellTextMode(
            modality="chat",
            access_variant="retell_text_mode.api_key",
            config={"retellAgentId": "agent_1"},
            credentials={"apiKey": SENTINEL_KEY, "apiSecret": "SENTINEL-secret-0001"},
        )
    told = str(refusal.value)
    assert "apiSecret" in told
    assert SENTINEL_KEY not in told and "SENTINEL-secret-0001" not in told


def test_the_plug_speaks_chat_only():
    with pytest.raises(PlugError, match="chat only"):
        text_mode({"retellAgentId": "agent_1"}, modality="voice")


def test_the_plug_holds_one_access_variant():
    with pytest.raises(PlugError, match="access variant"):
        text_mode(
            {"retellAgentId": "agent_1"}, access_variant="retell_chat_api.api_key"
        )


@pytest.mark.parametrize(
    ("agent_version", "dynamic_variables"),
    [(" ", UNSET), (-1, UNSET), (UNSET, {"open_slots": 3}), (UNSET, {" ": "x"})],
)
def test_a_version_or_a_variable_the_plug_cannot_send_is_refused(
    agent_version, dynamic_variables
):
    """Read through the shared helpers, so two plugs reaching one platform
    cannot disagree about what either of them is."""
    with pytest.raises(PlugError):
        text_mode(
            {"retellAgentId": "agent_1"},
            agent_version=agent_version,
            dynamic_variables=dynamic_variables,
        )
