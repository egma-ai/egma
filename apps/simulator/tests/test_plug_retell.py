"""The Retell chat plug against a Retell-shaped server.

The plug is the one component that speaks a platform's wire protocol, so
what is pinned here is the wire: the chat opened once, a turn delivered
per persona turn with the agent's own words coming back, the agent's ending
read from its end-tool invocation, and the chat ended at the platform
afterwards. The counterpart is a real HTTP server shaped like Retell's chat
API, on loopback — no account, no key, no network.

The failure paths get the same treatment, because they are where a
credential leaks if it ever does: a key the platform refuses and an
endpoint nothing answers on both end in a refusal a person can act on, and
neither says the key.
"""

from __future__ import annotations

import pytest
from retell_stub import END_TOOL

from egma_simulator.plugs import AgentReply, PlugError, ToolCall, plug_for
from egma_simulator.plugs.retell import DEFAULT_BASE_URL, END_TOOL_NAMES, RetellChat
from egma_simulator.redaction import REDACTED

SENTINEL_KEY = "SENTINEL-retell-key-9f2c4a7b1e8d"


UNSET = object()
"""What "the spec carried nothing here" looks like to the builder below,
told apart from an explicit ``None`` that a test means to hand over."""


def retell(
    config: dict,
    *,
    modality: str = "chat",
    key: str | None = SENTINEL_KEY,
    agent_version: object = UNSET,
    dynamic_variables: object = UNSET,
) -> RetellChat:
    credentials = None if key is None else {"apiKey": key}
    carried: dict = {}
    if agent_version is not UNSET:
        carried["agent_version"] = agent_version
    if dynamic_variables is not UNSET:
        carried["dynamic_variables"] = dynamic_variables
    return RetellChat(
        modality=modality,
        access_variant="retell_chat_api.api_key",
        config=config,
        credentials=credentials,
        **carried,
    )


def test_the_registry_knows_the_retell_plug():
    assert plug_for("retell_chat_api") is RetellChat


def test_a_connection_saying_nothing_about_where_reaches_retell_itself():
    """The base URL is the plug's own optional key; absent, it is the
    platform, which is what every real connection block will mean."""
    plug = retell({"retellAgentId": "agent_1"})
    assert plug.base_url == DEFAULT_BASE_URL == "https://api.retellai.com"


async def test_the_plug_opens_delivers_and_ends_one_chat(start_retell_stub):
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    plug = retell({"retellAgentId": "agent_lakeside", "baseUrl": running.base_url})

    assert plug.provider_reference is None, "no chat exists before it is opened"
    assert await plug.open() == "Lakeside Dental, how can I help?"
    assert plug.provider_reference == running.stub.chat_ids()[0]

    assert await plug.deliver("I need to move my cleaning.") == AgentReply(
        text="Of course — could I take your name?", ended=False
    )
    assert await plug.deliver("Margaret Hale.") == AgentReply(
        text="Booked for Thursday.", ended=False
    )
    await plug.close()

    # The whole exchange, from the platform's own side: one chat opened
    # against the configured agent, both turns delivered in order, the chat
    # ended rather than left ongoing.
    stub = running.stub
    assert [call["endpoint"] for call in stub.calls] == [
        "create-chat",
        "create-chat-completion",
        "create-chat-completion",
        "end-chat",
    ]
    assert stub.calls[0]["agent_id"] == "agent_lakeside"
    assert stub.delivered() == ["I need to move my cleaning.", "Margaret Hale."]
    assert stub.ended() == [plug.provider_reference]


async def test_an_agent_with_nothing_to_say_first_lets_the_persona_open(
    start_retell_stub,
):
    running = await start_retell_stub(api_key=SENTINEL_KEY, replies=["Go on."])
    plug = retell({"retellAgentId": "agent_quiet", "baseUrl": running.base_url})
    assert await plug.open() is None
    await plug.close()


async def test_the_agent_ending_the_exchange_is_read_from_its_end_tool(
    start_retell_stub,
):
    """A Retell chat agent ends its own exchange by invoking its end tool;
    the invocation comes back with the completion, and the plug says so."""
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        replies=["Anything else?", "All sorted, goodbye now."],
        ends_after_replies=True,
    )
    plug = retell({"retellAgentId": "agent_brisk", "baseUrl": running.base_url})
    await plug.open()

    assert await plug.deliver("Just the one thing.") == AgentReply(
        text="Anything else?", ended=False
    )
    # The last reply carries the end-tool invocation: the agent's final
    # words are still recorded, the exchange is over, and the call itself
    # is reported like any other — ending the chat is something the agent
    # did, and the record of the conversation says so.
    assert await plug.deliver("No, that is everything.") == AgentReply(
        text="All sorted, goodbye now.",
        ended=True,
        tool_calls=(ToolCall(name="end_call", arguments="{}"),),
    )
    await plug.close()


async def test_the_tools_an_answer_called_are_read_off_it(start_retell_stub):
    """Retell reports its invocations beside the words, which is what makes
    a tool call observable from egma's side of the wire at all."""
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        replies=["Done — moved to Thursday."],
        tool_calls=[
            {
                "name": "reschedule_appointment",
                "arguments": '{"appointment_id":"apt-88213"}',
            },
            {"name": "send_confirmation_sms"},
        ],
    )
    plug = retell({"retellAgentId": "agent_tooled", "baseUrl": running.base_url})
    await plug.open()

    answer = await plug.deliver("Move my cleaning to Thursday.")
    assert answer.tool_calls == (
        ToolCall(
            name="reschedule_appointment",
            arguments='{"appointment_id":"apt-88213"}',
        ),
        # Reported without arguments: absence is the honest record of what
        # the platform said, never an empty object standing in for it.
        ToolCall(name="send_confirmation_sms", arguments=None),
    )
    await plug.close()


async def test_several_bubbles_in_one_completion_stay_one_turn(start_retell_stub):
    """Retell answers a turn with everything the agent produced for it, and
    an agent that sends two bubbles has still taken one turn."""
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        replies=[["Let me look that up.", "Yes — Thursday at two."]],
    )
    plug = retell({"retellAgentId": "agent_chatty", "baseUrl": running.base_url})
    await plug.open()

    assert await plug.deliver("Is Thursday free?") == AgentReply(
        text="Let me look that up.\nYes — Thursday at two.", ended=False
    )
    await plug.close()


async def test_an_answer_that_carried_no_words_is_an_answer_without_words(
    start_retell_stub,
):
    """A completion can come back with tool traffic and nothing said. The
    walk records no turn for it rather than an empty one."""
    running = await start_retell_stub(api_key=SENTINEL_KEY, replies=[[]])
    plug = retell({"retellAgentId": "agent_silent", "baseUrl": running.base_url})
    await plug.open()

    assert await plug.deliver("Hello?") == AgentReply(text=None, ended=False)
    await plug.close()


# -- Conducting over a named version, with this simulation's variables -------


async def test_a_chat_carrying_neither_asks_for_exactly_what_it_always_did(
    start_retell_stub,
):
    """The unchanged case, pinned at the wire rather than described.

    Most chats name no version and carry no variables, and for those the
    request is the one this plug has always sent — the agent and nothing
    else. An absent field is absent: Retell renders an empty variable block
    as values, and a version it was not asked for is a version it chooses
    itself.
    """
    running = await start_retell_stub(api_key=SENTINEL_KEY, greeting="Front desk.")
    plug = retell({"retellAgentId": "agent_plain", "baseUrl": running.base_url})
    await plug.open()
    await plug.close()

    assert running.stub.calls[0]["body"] == {"agent_id": "agent_plain"}


@pytest.mark.parametrize("version", [106, "latest", "prod"])
async def test_a_chat_is_opened_against_the_version_the_spec_named(
    start_retell_stub, version: object
):
    """A version rides to Retell exactly as the spec spelled it.

    A number stays a number and a name stays a name: the platform is the
    only thing that knows what either means, and a mocked run's whole
    isolation rests on the exchange landing on the version egma branched
    rather than on whatever is newest by the time the chat opens.
    """
    running = await start_retell_stub(api_key=SENTINEL_KEY, greeting="Front desk.")
    plug = retell(
        {"retellAgentId": "agent_drafted", "baseUrl": running.base_url},
        agent_version=version,
    )
    await plug.open()
    await plug.close()

    assert running.stub.calls[0]["body"] == {
        "agent_id": "agent_drafted",
        "agent_version": version,
    }


async def test_this_simulations_variables_reach_retell_byte_for_byte(
    start_retell_stub,
):
    """What the run resolved is what the agent's platform renders.

    Egma's own attribution variable is among them, and it is what a tool
    call Retell makes rides back to this simulation on — so a plug that
    tidied, dropped or renamed one would take the simulation's tool facts
    with it. An empty value is carried too: it renders as nothing, which is
    not what a variable nobody set does.
    """
    carried = {
        "egma_simulation": "sim_01K5T2W8ZC4H6QJDXN9MRB7VFA",
        "is_existing": "false",
        "caller_name": "",
        "note": "  spaces the author meant  ",
    }
    running = await start_retell_stub(api_key=SENTINEL_KEY, greeting="Front desk.")
    plug = retell(
        {"retellAgentId": "agent_varied", "baseUrl": running.base_url},
        agent_version=106,
        dynamic_variables=carried,
    )
    await plug.open()
    await plug.close()

    assert running.stub.calls[0]["body"] == {
        "agent_id": "agent_varied",
        "agent_version": 106,
        "retell_llm_dynamic_variables": carried,
    }


@pytest.mark.parametrize(
    ("agent_version", "dynamic_variables"),
    [
        (None, None),
        (None, {}),
        (UNSET, {}),
        (None, UNSET),
    ],
)
async def test_nothing_carried_is_nothing_sent_however_it_is_spelled(
    start_retell_stub, agent_version: object, dynamic_variables: object
):
    """No version and no variables, in every shape the control plane can
    write them: the request stays the one it always was."""
    running = await start_retell_stub(api_key=SENTINEL_KEY, greeting="Front desk.")
    plug = retell(
        {"retellAgentId": "agent_plain", "baseUrl": running.base_url},
        agent_version=agent_version,
        dynamic_variables=dynamic_variables,
    )
    await plug.open()
    await plug.close()

    assert running.stub.calls[0]["body"] == {"agent_id": "agent_plain"}


@pytest.mark.parametrize(
    ("agent_version", "dynamic_variables"),
    [
        ("   ", UNSET),
        (-1, UNSET),
        (10.5, UNSET),
        (True, UNSET),
        ({"version": 106}, UNSET),
        (UNSET, "egma_simulation=sim_1"),
        (UNSET, {"egma_simulation": 7}),
        (UNSET, {"egma_simulation": None}),
        (UNSET, {"": "sim_1"}),
    ],
)
def test_a_version_or_a_variable_the_plug_cannot_send_is_refused(
    agent_version: object, dynamic_variables: object
):
    """Refused at construction, before a chat exists.

    These travel to the agent under test unread, so this is the last place a
    mistake in them can be named at all — and naming it here costs a
    simulation nothing, because nothing has been opened yet.
    """
    with pytest.raises(PlugError):
        retell(
            {"retellAgentId": "agent_1"},
            agent_version=agent_version,
            dynamic_variables=dynamic_variables,
        )


def test_a_refusal_about_a_variable_names_it_and_never_its_value():
    """What a simulation carries can be a caller's own details, so a
    sentence about a mistake in them must not repeat them."""
    with pytest.raises(PlugError) as refusal:
        retell(
            {"retellAgentId": "agent_1"},
            dynamic_variables={"patient_record": 8842, "caller_name": "Margaret Hale"},
        )
    told = str(refusal.value)
    assert "patient_record" in told
    assert "8842" not in told
    assert "Margaret Hale" not in told


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"retellAgentId": ""},
        {"retellAgentId": 7},
        {"retellAgentId": "agent_1", "baseUrl": 12},
        {"retellAgentId": "agent_1", "baseUrl": ""},
        {"retellAgentId": "agent_1", "retellAgentld": "a typo"},
        {"retellAgentId": "agent_1", "apiKey": "a secret in the wrong block"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        retell(config)


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        retell({"retellAgentId": "agent_1", "retellAgentld": "a typo"})
    assert "retellAgentld" in str(refusal.value)


@pytest.mark.parametrize(
    "credentials",
    [None, {}, {"apiKey": ""}, {"apiKey": 7}, {"api_key": "wrong-name-000000"}],
)
def test_credentials_of_the_wrong_shape_are_refused(credentials):
    with pytest.raises(PlugError):
        RetellChat(
            modality="chat",
            access_variant="retell_chat_api.api_key",
            config={"retellAgentId": "agent_1"},
            credentials=credentials,
        )


def test_a_credential_refusal_names_the_key_and_never_its_value():
    with pytest.raises(PlugError) as refusal:
        RetellChat(
            modality="chat",
            access_variant="retell_chat_api.api_key",
            config={"retellAgentId": "agent_1"},
            credentials={"apiKey": SENTINEL_KEY, "apiSecret": SENTINEL_KEY},
        )
    assert "apiSecret" in str(refusal.value)
    assert SENTINEL_KEY not in str(refusal.value)


def test_the_plug_speaks_chat_only_for_now():
    with pytest.raises(PlugError) as refusal:
        retell({"retellAgentId": "agent_1"}, modality="voice")
    assert "voice" in str(refusal.value)


async def test_a_key_the_platform_refuses_fails_without_saying_the_key(
    start_retell_stub,
):
    running = await start_retell_stub(api_key="the-only-key-this-stub-honors")
    plug = retell({"retellAgentId": "agent_1", "baseUrl": running.base_url})

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert "401" in told, "the reason has to name what the platform said"
    assert SENTINEL_KEY not in told, "the refusal carried the credential"


async def test_a_platform_that_says_the_key_back_is_quoted_without_it(
    start_retell_stub,
):
    """A refusal carries the platform's own words, and those are not the
    plug's to trust: a platform careless enough to echo the key back must
    not get it repeated into a reason, a log line, or the traceback under
    one."""
    running = await start_retell_stub(
        api_key="the-only-key-this-stub-honors", echo_key_in_refusal=True
    )
    plug = retell({"retellAgentId": "agent_1", "baseUrl": running.base_url})

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert "invalid api key" in told, "the platform's own words are still quoted"
    assert SENTINEL_KEY not in told, "the refusal repeated the key back"
    assert REDACTED in told


async def test_a_platform_that_answers_nowhere_fails_without_saying_the_key():
    """A closed port: the other way a platform is absent."""
    plug = retell({"retellAgentId": "agent_1", "baseUrl": "http://127.0.0.1:1"})

    with pytest.raises(PlugError) as refusal:
        await plug.open()
    await plug.close()

    told = str(refusal.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert SENTINEL_KEY not in told, "the refusal carried the credential"


async def test_a_refused_completion_is_a_named_failure(start_retell_stub):
    """The platform refusing mid-exchange is the plug's to name, not to hide."""
    running = await start_retell_stub(api_key=SENTINEL_KEY, replies=["Certainly."])
    plug = retell({"retellAgentId": "agent_1", "baseUrl": running.base_url})
    await plug.open()
    assert (await plug.deliver("Hello.")).text == "Certainly."

    # The platform ends the chat from its side — an inactivity close, say —
    # and the next delivery is refused.
    running.stub.chats[plug.provider_reference]["ended"] = True
    with pytest.raises(PlugError) as refusal:
        await plug.deliver("Are you still there?")
    await plug.close()

    told = str(refusal.value)
    assert "422" in told
    assert SENTINEL_KEY not in told


async def test_closing_a_chat_that_was_never_opened_is_safe():
    """``close`` is called whatever happened, including before ``open``."""
    plug = retell({"retellAgentId": "agent_1", "baseUrl": "http://127.0.0.1:1"})
    await plug.close()
    await plug.close()


def test_the_plug_and_the_stub_agree_on_how_an_agent_ends_an_exchange():
    """Otherwise the ending test above pins the stub's habits, not Retell's."""
    assert END_TOOL in END_TOOL_NAMES
