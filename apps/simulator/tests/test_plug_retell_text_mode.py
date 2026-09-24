"""Verify text-mode requests through a local HTTP stub: history, version, variables,
native mock answers, resume state, and reported tool evidence.
Exercise throttling, billing, authentication, and credential-echo failures.
These checks validate the implementation against the stub, not the live API.
"""

from __future__ import annotations

import pytest
from text_mode_stub import Reply, ToolTurn

from egma_simulator.mock_tools import MockToolSeam
from egma_simulator.plugs import AgentReply, PlugError
from egma_simulator.plugs.retell_common import DEFAULT_BASE_URL
from egma_simulator.plugs.retell_text_mode import (
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


def answering(name: str, value: object) -> MockTool:
    return MockTool(tool_name=name, answer={"answer": value})


def failing(name: str, value: object) -> MockTool:
    return MockTool(tool_name=name, answer={"error": value})


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


def test_a_connection_saying_nothing_about_where_reaches_retell_itself():
    """The base URL is the plug's own optional key; absent, it is the
    platform, which is what every real connection block will mean."""
    plug = text_mode({"retellAgentId": "agent_1"})
    assert plug.base_url == DEFAULT_BASE_URL == "https://api.retellai.com"


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


async def test_final_persona_words_use_one_completion_and_keep_its_reply(
    start_text_mode_stub,
):
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[Reply(), Reply(words="Take care.", ends=True)],
    )
    plug = text_mode(
        {"retellAgentId": "agent_1", "baseUrl": running.base_url}, mock_tools=seam()
    )
    await plug.open()

    answer = await plug.finish("Goodbye.")
    await plug.close()

    assert answer == AgentReply(text="Take care.", ended=True)
    assert running.stub.delivered() == ["Goodbye."]
    assert len(running.stub.requests) == 2


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


# -- The version, the variables, and the resume state ------------------------


@pytest.mark.parametrize("version", [106, "  latest  "])
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

    wanted = str(version).strip()
    assert [request["agent_version"] for request in running.stub.requests] == [
        wanted,
        wanted,
    ]


@pytest.mark.parametrize(
    "variables_key", ["retell_llm_dynamic_variables", "dynamic_variables"]
)
async def test_a_reply_updates_this_simulations_variables_without_dropping_them(
    start_text_mode_stub, variables_key
):
    """Forward authored variables unchanged, then merge reply variables over held state.
    Exercise both supported reply field names; omitted values must survive a delta.
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
        dynamic_variables={"account_id": "sim_01", "caller_name": ""},
        mock_tools=seam(),
    )

    await plug.open()
    await plug.deliver("It's Margaret.")
    await plug.deliver("Thursday please.")
    await plug.close()

    carried = [
        request["body"].get("dynamic_variables")
        for request in running.stub.requests
    ]
    assert carried[0] == {"account_id": "sim_01", "caller_name": ""}
    assert carried[1] == {"account_id": "sim_01", "caller_name": ""}
    assert carried[2] == {"account_id": "sim_01", "caller_name": "Margaret"}
    # The one that must never fall off: it is what a tool call the platform
    # makes rides back to this simulation on.
    assert all(
        variables["account_id"] == "sim_01" for variables in carried
    ), carried


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
    assert "component_id" not in bodies[1]
    assert bodies[2]["current_node_id"] == "lookup"
    assert bodies[2]["component_id"] == "verify_caller"


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
    await plug.deliver("What times are available?")
    await plug.close()

    expected_mocks = [
        {
            "tool_name": "check_calendar",
            "input_match_rule": {"type": "any"},
            "output": '{"slots":[]}',
            "result": True,
        },
        {
            "tool_name": "book_appointment",
            "input_match_rule": {"type": "any"},
            "output": '"the booking service is down"',
            "result": False,
        },
    ]
    assert running.stub.mocks() == [expected_mocks, expected_mocks]


async def test_tool_calls_preserve_the_result_the_platform_returned(
    start_text_mode_stub,
):
    """The whole honesty claim of this lane, at the tool grain: the platform
    served egma's answer for the covered name and the customer's own backend
    for the other, and the record says which was which — by carrying egma's
    own answer on the one it authored, and nothing on the one it did not."""
    answers = seam(answering("check_calendar", {"slots": ["thu-1430"]}))
    running = await start_text_mode_stub(
        api_key=SENTINEL_KEY,
        replies=[
            Reply(),
            Reply(
                words="Thursday at half two?",
                tools=[
                    ToolTurn(
                        name="check_calendar",
                        arguments='{"day":"thu"}',
                        reported_result='{"slots":["fri-0900"],"from":"retell"}',
                    ),
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

    # Nothing rides back on the reply itself: the seam is the one writer of
    # this lane's tool record, and two writers would record each call twice.
    assert answered.tool_calls == ()

    reported = answers.exchanged()
    assert [(call.name, call.answer) for call in reported] == [
        ("check_calendar", '{"slots":["fri-0900"],"from":"retell"}'),
        ("lookup_customer", '{"customer":"real"}'),
    ]
    assert [call.arguments for call in reported] == [
        '{"day":"thu"}',
        '{"phone":"+1"}',
    ]


def test_a_tool_result_can_arrive_in_a_later_completion():
    answers = seam(answering("check_calendar", {"slots": []}))
    plug = text_mode({"retellAgentId": "agent_1"}, mock_tools=answers)

    plug._read({
        "messages": [{
            "role": "tool_call_invocation",
            "tool_call_id": "call_1",
            "name": "check_calendar",
            "arguments": '{"day":"thu"}',
        }],
        "call_ended": False,
    })
    assert answers.exchanged() == []

    plug._read({
        "messages": [{
            "role": "tool_call_result",
            "tool_call_id": "call_1",
            "content": '{"slots":["thu-1430"]}',
        }],
        "call_ended": False,
    })

    (call,) = answers.exchanged()
    assert call.answer == '{"slots":["thu-1430"]}'


def test_an_unpaired_invocation_is_kept_without_an_invented_result():
    answers = seam(answering("check_calendar", {"slots": ["authored"]}))
    plug = text_mode({"retellAgentId": "agent_1"}, mock_tools=answers)

    reply = {
        "messages": [{
            "role": "tool_call_invocation",
            "name": "check_calendar",
            "arguments": '{"day":"thu"}',
        }],
        "call_ended": False,
    }
    plug._read(reply)

    (call,) = answers.exchanged()
    assert call.answer is None


def test_replayed_tool_messages_do_not_duplicate_a_completed_call():
    answers = seam()
    plug = text_mode({"retellAgentId": "agent_1"}, mock_tools=answers)
    reply = {
        "messages": [
            {"role": "tool_call_invocation", "tool_call_id": "call_1",
             "name": "lookup_customer"},
            {"role": "tool_call_result", "tool_call_id": "call_1",
             "content": '{"customer":"real"}'},
        ],
        "call_ended": False,
    }

    plug._read(reply)
    plug._read(reply)

    assert len(answers.exchanged()) == 1


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


@pytest.mark.parametrize("retry_after", ["not-a-number"])
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


# -- Config and credentials -------------------------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {},
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
    [None],
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
