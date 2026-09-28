"""Check v3 call creation and voice conduction with scripted media.
Actual gateway signaling and audio peers are tested in test_retell_gateway.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from conftest import A_PERSONALITY, A_SCENARIO, a_spec
from room_stub import RoomStub

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, NOT_ANSWERED
from egma_simulator.conversation import Conducted, ConversationControls
from egma_simulator.media.livekit_room import RoomSettings
from egma_simulator.media.retell_gateway import RetellGatewaySettings
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import PlugError, VoiceConnection, failed_ending, plug_for
from egma_simulator.plugs import retell_web_call as web_call_plug
from egma_simulator.plugs.retell_web_call import RetellWebCall
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR


@dataclass
class GatewayStub(RoomStub):
    """Reuse scripted media below the gateway backend boundary.

    The real gateway's HTTP signaling and peer audio are tested separately.
    """

    connections: list[RetellGatewaySettings] = field(default_factory=list)

    def driver(self, *, settings: RetellGatewaySettings, **arguments: Any):
        self.connections.append(settings)
        arguments.pop("poll_remote_end", None)
        return super().driver(
            settings=RoomSettings(
                url="wss://scripted.invalid", given_token=settings.access_token
            ),
            mock_tools=None,
            **arguments,
        )


SENTINEL_KEY = "SENTINEL-retell-web-call-key-4c81de"
"""The account key that creates the call. A sentinel because every path
below is scanned for it, on the way through and on the way out."""

AN_AGENT = "agent_b0e2e9cb267c47e7e7026cd8e8"
A_SIMULATION = "sim-web-call-001"
A_DRAFT = 106
"""The version a mocked run branched. Named at creation every time: Retell's
own default is whatever version is newest, which on a mocked run is exactly
the draft nobody may be at the mercy of."""

THE_VARIABLES = {
    "account_id": A_SIMULATION,
    "is_existing": "false",
    "caller_name": "",
}
"""What this simulation is conducted with. Egma's attribution variable is
among them — it is what a tool call Retell makes rides back to this
simulation on — and one value is deliberately empty, because a variable set
to nothing is not the same as one nobody set."""


def web_call_spec(
    simulation_id: str = A_SIMULATION,
    *,
    base_url: str,
    agent_id: str = AN_AGENT,
    agent_version: object = A_DRAFT,
    dynamic_variables: object = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    mock_tools: list[dict] | None = None,
) -> dict:
    """One voice spec whose connection names a Retell web call.

    Deliberately the same shape as the room and phone builders: a web-call
    simulation differs from every other voice one by its connection block
    and by the two facts the lane rides on, and by nothing else.
    """
    config: dict = {"retellAgentId": agent_id, "baseUrl": base_url}
    return a_spec(
        simulation_id,
        modality="voice",
        connection={
            "agent_platform": "retell",
            "connection_type": "retell_web_call",
            "access_variant": "retell_web_call.api_key",
            "config": config,
            "credentials": {"apiKey": SENTINEL_KEY},
        },
        agent_version=agent_version,
        dynamic_variables=(
            THE_VARIABLES if dynamic_variables is None else dynamic_variables
        ),
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
        mock_tools=mock_tools,
    )


UNSET = object()
"""What "this test says nothing about it" looks like to the builder below,
told apart from an explicit ``None`` a test means to hand over."""


def web_call(
    room: GatewayStub,
    *,
    base_url: str,
    modality: str = "voice",
    config: dict | None = None,
    credentials: object = UNSET,
    agent_version: object = A_DRAFT,
    dynamic_variables: object = None,
) -> RetellWebCall:
    """One web-call plug, against both counterparts."""
    return RetellWebCall(
        modality=modality,
        access_variant="retell_web_call.api_key",
        config=(
            {"retellAgentId": AN_AGENT, "baseUrl": base_url}
            if config is None
            else config
        ),
        credentials=({"apiKey": SENTINEL_KEY} if credentials is UNSET else credentials),
        simulation_id=A_SIMULATION,
        agent_version=agent_version,
        dynamic_variables=(
            THE_VARIABLES if dynamic_variables is None else dynamic_variables
        ),
        driver=room.driver,
    )


async def web_call_walk(
    tmp_path: Path,
    room: GatewayStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    base_url: str,
    controls: ConversationControls | None = None,
    **overrides: Any,
) -> tuple[Conducted, list[tuple[str, str]], Any]:
    """One web-call simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — so what is exercised below the two
    counterparts is every line the service would run, the Pipecat conductor
    that drives the room included.
    """
    monkeypatch.setattr(web_call_plug, "RetellGatewayBackend", room.driver)
    spec = SimulationSpec.from_document(web_call_spec(base_url=base_url, **overrides))
    turns: list[tuple[str, str]] = []

    async def on_utterance(speaker: str, text: str, _began: int, _ended: int) -> None:
        turns.append((speaker, text))

    async def ignore(*_facts: object) -> None:
        return None

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.conductor is not None
    conducted = await assembled.conductor.conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=controls if controls is not None else ConversationControls(),
        name="sim:web-call-test",
        on_utterance=on_utterance,
        on_measured=ignore,
    )
    return conducted, turns, assembled


def assert_egma_only_joined(room: GatewayStub) -> None:
    """The scripted fixture must receive no LiveKit room operations."""
    assert room.rooms == []
    assert room.dispatches == []
    assert room.deleted == []


def test_the_registry_knows_the_retell_web_call_plug():
    factory = plug_for("retell_web_call")
    assert factory is not None
    assert isinstance(
        factory(
            modality="voice",
            access_variant="retell_web_call.api_key",
            config={"retellAgentId": AN_AGENT},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id=A_SIMULATION,
        ),
        RetellWebCall,
    )


def test_a_web_call_is_one_pipecat_voice_connection():
    """The seam gives Pipecat the transport instead of exchanging PCM."""
    connection = web_call(GatewayStub(), base_url="http://127.0.0.1:1")
    assert isinstance(connection, VoiceConnection)
    assert not hasattr(connection, "exchange")
    assert not hasattr(connection, "sample_rate_hz")


# -- One whole simulation ----------------------------------------------------


async def test_a_web_call_spec_conducts_a_whole_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """The whole story, from a spec alone.

    A spec whose connection names a Retell web call becomes a conversation:
    the call is created against the version the spec named with this
    simulation's variables attached, the room that creation opened is
    joined with the token it handed back, the turns are exchanged, and the
    record's join to Retell's telemetry is Retell's own call id.
    """
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(
        greeting="Remedy after hours, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    conducted, turns, assembled = await web_call_walk(
        tmp_path,
        room,
        monkeypatch,
        base_url=running.base_url,
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. My name is Margaret Hale."
        ),
    )

    assert turns == [
        ("agent", "Remedy after hours, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"

    # One call, created against the named version with the variables
    # attached — and against nothing else.
    assert [call["endpoint"] for call in running.stub.calls] == ["create-web-call"]
    created = running.stub.web_calls[0]
    assert created["body"] == {
        "agent_id": AN_AGENT,
        "agent_version": A_DRAFT,
        "retell_llm_dynamic_variables": THE_VARIABLES,
    }

    # The room was joined with what that creation handed back, at Retell's
    # own host — the token from *this* call, not a token from anywhere.
    assert len(room.joined_with) == 1
    way_in = room.connections[0]
    assert way_in.access_token == created["access_token"]
    assert way_in.base_url == running.base_url
    assert way_in.call_id == created["call_id"]
    assert way_in.ice_servers == [{"urls": "stun:stun.l.google.com:19302"}]

    # And the record's join to Retell's telemetry is the call, which is the
    # one name both sides can look this exchange up by.
    assert conducted.provider_reference == created["call_id"]
    assert_egma_only_joined(room)

    # The recording resolves, the way it does for every voice simulation.
    audio = assembled.audio
    assert set(audio) == {"recording", "waveform"}
    assert "://" not in audio["recording"]
    assert (tmp_path / audio["recording"]).read_bytes()


async def test_the_agent_ending_the_call_is_the_agent_ending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """Retell's participant leaving is the agent ending the exchange, and
    everything said up to that moment stays on the record."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(
        greeting="Remedy after hours.",
        replies=["I am afraid I have to go. Goodbye."],
        hangs_up_after_replies=True,
    )
    conducted, turns, _assembled = await web_call_walk(
        tmp_path,
        room,
        monkeypatch,
        base_url=running.base_url,
        scenario=" ".join(f"Sentence number {n}." for n in range(1, 41)),
    )

    assert conducted.status == "completed"
    assert conducted.ending == "agent_ended"
    assert turns == [
        ("agent", "Remedy after hours."),
        ("human", "Sentence number 1."),
        ("agent", "I am afraid I have to go. Goodbye."),
    ]
    assert_egma_only_joined(room)


async def test_a_limit_ends_the_call_and_egma_still_leaves(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """A simulation stopped by its own walls ends deliberately, and it is
    never the agent failing. Egma leaves the room either way."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(
        greeting="Remedy after hours.", replies=["One.", "Two.", "Three."]
    )
    conducted, _turns, _assembled = await web_call_walk(
        tmp_path,
        room,
        monkeypatch,
        base_url=running.base_url,
        scenario="First. Second. Third. Fourth.",
        max_turns=3,
    )

    assert conducted.ending == "limit_reached"
    assert not room.room.joined, "egma left the room it was in"
    assert_egma_only_joined(room)


async def test_a_call_naming_no_version_and_no_variables_asks_for_the_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """Both facts are optional here as everywhere. An unmocked run over
    this connection names no version and carries no variables, and the
    creation is then the agent and nothing else — because a version Retell
    was not asked for is one it chooses itself, and an empty variable block
    is a set of values it would render."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(greeting="Remedy after hours.", replies=["Noted."])
    await web_call_walk(
        tmp_path,
        room,
        monkeypatch,
        base_url=running.base_url,
        agent_version=None,
        dynamic_variables={},
        scenario="One point.",
    )

    assert running.stub.web_calls[0]["body"] == {"agent_id": AN_AGENT}


async def test_egma_never_stands_in_this_agents_tool_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """A mocked Retell world answers from egma's own endpoint, which the
    agent reaches over the internet and not across the room. So this plug
    offers nothing in the room even for a simulation whose test names mock
    tools, so no call of the agent's ever reaches the seam — which is the
    truth, because egma never stood in their path in this room."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(greeting="Remedy after hours.", replies=["Noted."])
    _conducted, _turns, assembled = await web_call_walk(
        tmp_path,
        room,
        monkeypatch,
        base_url=running.base_url,
        scenario="One point.",
        mock_tools=[
            {
                "tool_name": "get_availability",
                "answer": {"answer": {"slots": []}},
            }
        ],
    )

    assert assembled.tool_calls() == []
    # Nothing was offered in the room, so there is nothing there to call.
    assert not room.standing_ready.is_set()


# -- Every way a web call fails to become a simulation -----------------------


async def test_a_creation_retell_refuses_is_a_fault_in_its_words(
    start_retell_stub,
):
    """A platform that will not create the call is somebody's to fix, and
    what it said is the whole diagnosis. Nothing is joined afterwards."""
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        refuses_web_call="agent_b0e2e9cb267c47e7e7026cd8e8 has no version 106",
    )
    room = GatewayStub()
    plug = web_call(room, base_url=running.base_url)

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "has no version 106" in told, "the platform's own words are the diagnosis"
    assert "422" in told
    assert SENTINEL_KEY not in told
    assert room.joined_with == [], "no room is joined for a call that was refused"
    assert plug.provider_reference is None


async def test_a_creation_that_failed_left_nothing_to_be_spent(start_retell_stub):
    """A creation Retell refused minted no token and left no call.

    So the next attempt is a first attempt, and what it gets back is the
    platform's refusal again — never "the token is spent", which would send
    whoever reads it looking for a call that was never created.
    """
    running = await start_retell_stub(
        api_key=SENTINEL_KEY, refuses_web_call="that agent has no version 106"
    )
    plug = web_call(GatewayStub(), base_url=running.base_url)

    for _attempt in range(2):
        with pytest.raises(PlugError) as refused:
            await plug.prepare()
        told = str(refused.value)
        assert "has no version 106" in told
        assert "spent" not in told
    await plug.close()

    assert len(running.stub.calls) == 2, "each attempt really asked Retell"


async def test_a_creation_that_hands_back_no_way_in_is_refused(start_retell_stub):
    """A 2xx with no access token is a call egma cannot conduct. Half an
    exchange is worse than an honest refusal, so it is refused."""
    running = await start_retell_stub(
        api_key=SENTINEL_KEY, web_call_without_a_token=True
    )
    room = GatewayStub()
    plug = web_call(room, base_url=running.base_url)

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    assert failed_ending(refused.value) == ERROR
    assert "access_token" in str(refused.value)
    assert room.joined_with == []


async def test_a_key_the_platform_refuses_fails_without_saying_the_key(
    start_retell_stub,
):
    running = await start_retell_stub(api_key="the-only-key-this-stub-honors")
    room = GatewayStub()
    plug = web_call(room, base_url=running.base_url)

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert "401" in told, "the reason has to name what the platform said"
    assert SENTINEL_KEY not in told, "the refusal carried the credential"


async def test_a_platform_that_says_the_key_back_is_quoted_without_it(
    start_retell_stub,
):
    """A refusal carries the platform's own words, and those are not this
    plug's to trust: a platform careless enough to echo the key back must
    not get it repeated into a reason, a log line, or the traceback under
    one."""
    running = await start_retell_stub(
        api_key="the-only-key-this-stub-honors", echo_key_in_refusal=True
    )
    plug = web_call(GatewayStub(), base_url=running.base_url)

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert "invalid api key" in told, "the platform's own words are still quoted"
    assert SENTINEL_KEY not in told
    assert REDACTED in told


async def test_a_platform_that_answers_nowhere_fails_without_saying_the_key():
    """A closed port: the other way a platform is absent."""
    plug = web_call(GatewayStub(), base_url="http://127.0.0.1:1")

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert failed_ending(refused.value) == ERROR
    assert SENTINEL_KEY not in told
    assert SENTINEL_KEY not in repr(refused.value.__cause__)


async def test_a_token_is_spent_on_its_join_and_never_offered_twice(
    start_retell_stub,
):
    """One call, one join. Retell mints the access token for one entry into
    one room, so a second attempt on the same call is refused here rather
    than sent — the answer is already known, and asking would spend a
    request to be told so."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(greeting="Remedy after hours.")
    plug = web_call(room, base_url=running.base_url)

    await plug.prepare()
    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "spent" in told
    assert "new call" in told
    # And no second call was created behind the refusal.
    assert len(running.stub.web_calls) == 1


async def test_a_room_that_will_not_take_the_way_in_says_why(start_retell_stub):
    """A token already used, or created and left, is refused at the room.

    What a person sees then is a call that exists and a room they cannot
    get into, so the refusal carries both: the platform's own words, and
    the one fact that explains most of them.
    """
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(refuses_join="access token is no longer valid")
    plug = web_call(room, base_url=running.base_url)

    await plug.prepare()
    with pytest.raises(PlugError) as refused:
        await plug.open()
    await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "access token is no longer valid" in told
    assert running.stub.web_calls[0]["call_id"] in told
    assert running.stub.web_calls[0]["access_token"] not in told
    assert SENTINEL_KEY not in told


async def test_an_agent_that_never_joins_is_never_the_agent_failing(
    monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """The call is created, the room opens, and Retell puts nothing in it.

    Nothing was tested, so nothing is graded: the ending says the agent
    never joined. It is deliberately not ``NOT_ANSWERED`` — nothing rings
    on a web call, because egma creates the call and joins the room it
    opens rather than waiting for a line to be picked up.
    """
    monkeypatch.setattr(web_call_plug, "AGENT_JOIN_SECONDS", 0.05)
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(agent_joins=False)
    plug = web_call(room, base_url=running.base_url)

    await plug.prepare()
    with pytest.raises(PlugError) as never_came:
        await plug.open()
    await plug.close()

    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert failed_ending(never_came.value) != NOT_ANSWERED
    told = str(never_came.value)
    assert running.stub.web_calls[0]["call_id"] in told
    assert "never put an agent in it" in told
    assert_egma_only_joined(room)


async def test_an_agent_that_joins_and_publishes_nothing_never_joined_either(
    monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """The agent answered means its participant is there *and* its audio is
    flowing. A participant with no audio is a call that failed to start,
    and conducting against it would grade an agent that never spoke."""
    monkeypatch.setattr(web_call_plug, "AGENT_JOIN_SECONDS", 0.05)
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = GatewayStub(agent_publishes_audio=False)
    plug = web_call(room, base_url=running.base_url)

    await plug.prepare()
    with pytest.raises(PlugError) as silent:
        await plug.open()
    await plug.close()

    assert failed_ending(silent.value) == AGENT_NEVER_JOINED
    assert "audio" in str(silent.value)


def test_the_wait_for_the_agent_is_bounded_and_shorter_than_a_simulation():
    """A wait that outran a simulation's duration limit would put
    ``limit_reached`` on a record whose real story is that nothing came."""
    assert 0 < web_call_plug.AGENT_JOIN_SECONDS <= 60


async def test_closing_a_call_that_was_never_created_is_safe():
    """``close`` is called whatever happened, including before anything was
    created — and a plug that never made a call must not try to leave a
    room that was never joined."""
    room = GatewayStub()
    plug = web_call(room, base_url="http://127.0.0.1:1")
    await plug.close()
    await plug.close()
    assert room.joined_rooms == []


async def test_opening_before_creating_is_refused_rather_than_guessed():
    plug = web_call(GatewayStub(), base_url="http://127.0.0.1:1")
    with pytest.raises(PlugError) as refused:
        await plug.open()
    assert failed_ending(refused.value) == ERROR


# -- Egma leaves; Retell closes ---------------------------------------------


async def test_egma_leaves_the_room_however_the_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """The room is Retell's own, opened for its own call, and a token that
    opens one room carries no power to delete it. So egma leaves on every
    way out and asks for no deletion on any of them — a delete it has no
    right to make would spend a request to be refused."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)

    natural = GatewayStub(greeting="Remedy after hours.", replies=["Noted."])
    await web_call_walk(
        tmp_path, natural, monkeypatch, base_url=running.base_url, scenario="One point."
    )
    assert not natural.room.joined
    assert_egma_only_joined(natural)

    canceled = GatewayStub(greeting="Remedy after hours.", replies=["Noted."])
    conducted, _turns, _assembled = await web_call_walk(
        tmp_path,
        canceled,
        monkeypatch,
        base_url=running.base_url,
        controls=CancelsOnceUnderWay(),
        scenario="One point.",
    )
    assert conducted.status == "canceled"
    assert not canceled.room.joined
    assert_egma_only_joined(canceled)


class CancelsOnceUnderWay(ConversationControls):
    """A cancel directive that lands after the exchange has opened."""

    def __init__(self) -> None:
        super().__init__()
        self._steps = 0

    async def guard(self, coroutine):
        self._steps += 1
        if self._steps > 1:
            self.request_cancel()
        return await super().guard(coroutine)


# -- Nothing carries a credential -------------------------------------------


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_simulation_produces_carries_the_key_or_the_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    start_retell_stub,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    Two secrets are in the process for a web call — the account key that
    creates it and the access token that opens its room — and neither may
    reach a person. A whole simulation runs with both really in hand, and
    then everything it produced is read for them: every log line, the
    refusal and the exception under it, the driver printed out, and, where
    there was one, every byte of the recording.
    """
    monkeypatch.setattr(web_call_plug, "AGENT_JOIN_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG)
    running = await start_retell_stub(
        api_key=SENTINEL_KEY, web_call_token="SENTINEL-web-call-access-token-a91f7"
    )
    room = GatewayStub(
        greeting="Remedy after hours.", replies=["Noted."], agent_joins=agent_joins
    )

    produced: list[str] = []
    try:
        conducted, _turns, assembled = await web_call_walk(
            tmp_path,
            room,
            monkeypatch,
            base_url=running.base_url,
            scenario="One point.",
        )
        recording = (tmp_path / assembled.audio["recording"]).read_bytes()
        produced.append(recording.decode("latin-1"))
        # What the record is built out of, including the one thing this
        # plug puts on it by name: Retell's call id, which is a reference
        # and not a way into anything.
        produced += [repr(conducted), json.dumps(assembled.audio)]
    except PlugError as refused:
        produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced.append(repr(room.backends[0]))
    produced.append(repr(room.connections[0]))

    minted = running.stub.web_calls[0]["access_token"]
    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert SENTINEL_KEY not in piece
        assert minted not in piece


async def test_the_provider_reference_is_available_before_audio_connects(
    start_retell_stub,
):
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    gateway = GatewayStub()
    plug = web_call(gateway, base_url=running.base_url)
    await plug.prepare()
    assert plug.provider_reference == running.stub.web_calls[0]["call_id"]
    await plug.close()


# -- Connections the plug does not understand --------------------------------


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"retellAgentId": ""},
        {"retellAgentId": 7},
        {"retellAgentId": AN_AGENT, "baseUrl": 12},
        {"retellAgentId": AN_AGENT, "baseUrl": ""},
        {"retellAgentId": AN_AGENT, "roomHost": ""},
        {"retellAgentId": AN_AGENT, "roomHost": 7},
        {"retellAgentId": AN_AGENT, "roomHost": "wss://old.livekit.cloud"},
        {"retellAgentId": AN_AGENT, "roomHost": "retell-ai.livekit.cloud"},
        {"retellAgentId": AN_AGENT, "retellAgentld": "a typo"},
        {"retellAgentId": AN_AGENT, "apiKey": "a secret in the wrong block"},
        {"retellAgentId": AN_AGENT, "agentName": "a room's key, not this one's"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        web_call(GatewayStub(), base_url="http://127.0.0.1:1", config=config)


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        web_call(
            GatewayStub(),
            base_url="http://127.0.0.1:1",
            config={"retellAgentId": AN_AGENT, "roomHostt": "a typo"},
        )
    assert "roomHostt" in str(refusal.value)


@pytest.mark.parametrize(
    "credentials",
    [None, {}, {"apiKey": ""}, {"apiKey": 7}, {"api_key": "wrong-name-000000"}],
)
def test_credentials_of_the_wrong_shape_are_refused(credentials: object):
    with pytest.raises(PlugError):
        web_call(GatewayStub(), base_url="http://127.0.0.1:1", credentials=credentials)


def test_a_credential_refusal_names_the_key_and_never_its_value():
    with pytest.raises(PlugError) as refusal:
        web_call(
            GatewayStub(),
            base_url="http://127.0.0.1:1",
            credentials={"apiKey": SENTINEL_KEY, "apiSecret": SENTINEL_KEY},
        )
    assert "apiSecret" in str(refusal.value)
    assert SENTINEL_KEY not in str(refusal.value)


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        web_call(GatewayStub(), base_url="http://127.0.0.1:1", modality="chat")
    assert "chat" in str(refusal.value)


def test_an_access_variant_this_plug_does_not_hold_is_refused():
    with pytest.raises(PlugError) as refusal:
        RetellWebCall(
            modality="voice",
            access_variant="retell_chat_api.api_key",
            config={"retellAgentId": AN_AGENT},
            credentials={"apiKey": SENTINEL_KEY},
            simulation_id=A_SIMULATION,
        )
    assert "retell_chat_api.api_key" in str(refusal.value)


def test_call_creation_uses_the_current_retell_contract():
    from retell_stub import RetellStub

    served = {
        resource.canonical for resource in RetellStub().build_app().router.resources()
    }
    assert web_call_plug.CREATE_PATH == "/v3/create-web-call"
    assert "/v3/create-web-call" in served
    assert "/v2/create-web-call" not in served


@pytest.mark.parametrize(
    "connection_details",
    [
        {"transport": "livekit"},
        {"transport": None},
        {"ice_servers": None},
        {"ice_servers": ["stun:host"]},
        {"ice_servers": [{"urls": "https://invalid.example"}]},
        {"ice_servers": [{"urls": []}]},
        {"ice_servers": [{"urls": "turn:host", "credential": 7}]},
        {"expires_at": None},
        {"expires_at": True},
        {"expires_at": 1},
    ],
)
async def test_invalid_gateway_details_fail_before_connecting(
    start_retell_stub, connection_details
):
    running = await start_retell_stub(
        api_key=SENTINEL_KEY,
        web_call_connection_overrides=connection_details,
    )
    gateway = GatewayStub()
    plug = web_call(gateway, base_url=running.base_url)
    with pytest.raises(PlugError):
        await plug.prepare()
    assert plug.provider_reference == running.stub.web_calls[0]["call_id"]
    assert gateway.connections == []
    await plug.close()
