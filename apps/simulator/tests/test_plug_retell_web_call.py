"""The Retell web-call plug: a call egma creates, in a room Retell opens.

Two counterparts, one for each half of what this plug does, and neither of
them a mock of egma's own code:

- **Creating the call** goes to the Retell-shaped HTTP server on loopback
  (:mod:`retell_stub`), the same one the chat plug is held against. What is
  proved about the request egma sends is proved over a socket, against
  Retell's own field names and status codes.
- **Joining the room** goes to the room-shaped LiveKit CI already runs
  (:mod:`room_stub`), which stands in for the places the room driver
  reaches a LiveKit and leaves every other line of it real. A web call *is*
  a LiveKit room joined by url and token, so the room this plug conducts in
  is the room every other voice simulation conducts in.

What is pinned here is the whole story: the call created against the
version the spec named with this simulation's variables attached, the room
joined with the token that creation handed back, a conversation held in it,
every way the two halves fail said honestly and typed, and egma leaving a
room it has no power to delete.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from conftest import A_PERSONALITY, A_SCENARIO, a_spec
from room_stub import RoomStub

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, NOT_ANSWERED
from egma_simulator.media.livekit_room import PLATFORM_NAMED_ROOM, RoomSettings
from egma_simulator.media.room import ROOM_PREFIX, room_name_for
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import PlugError, VoiceConnection, failed_ending, plug_for
from egma_simulator.plugs import retell_web_call as web_call_plug
from egma_simulator.plugs.retell_web_call import (
    RETELL_ROOM_HOST,
    RetellWebCall,
)
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR
from egma_simulator.walk import Conducted, WalkControls

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
    "egma_simulation": A_SIMULATION,
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
    room_host: str | None = None,
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
    if room_host is not None:
        config["roomHost"] = room_host
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
    room: RoomStub,
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
        credentials=(
            {"apiKey": SENTINEL_KEY} if credentials is UNSET else credentials
        ),
        simulation_id=A_SIMULATION,
        agent_version=agent_version,
        dynamic_variables=(
            THE_VARIABLES if dynamic_variables is None else dynamic_variables
        ),
        driver=room.driver,
    )


async def web_call_walk(
    tmp_path: Path,
    room: RoomStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    base_url: str,
    controls: WalkControls | None = None,
    **overrides: Any,
) -> tuple[Conducted, list[tuple[str, str]], Any]:
    """One web-call simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — so what is exercised below the two
    counterparts is every line the service would run, the Pipecat conductor
    that drives the room included.
    """
    monkeypatch.setattr(web_call_plug, "LiveKitRoomBackend", room.driver)
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
        controls=controls if controls is not None else WalkControls(),
        name="sim:web-call-test",
        on_utterance=on_utterance,
        on_measured=ignore,
    )
    return conducted, turns, assembled


def assert_egma_only_joined(room: RoomStub) -> None:
    """Egma made no room, asked for nobody, and deleted nothing.

    All three halves of the same property, and the safety-carrying one:
    the room belongs to Retell. Egma holds a token that opens it and
    nothing more, so a request to create, to dispatch or to delete would
    be a power egma does not have — and asking for one would spend a
    request to be refused, or, worse, would work against the wrong LiveKit.
    """
    assert room.rooms == [], "egma made no room; Retell opened it"
    assert room.dispatches == [], "egma asked for nobody; Retell puts its own agent in"
    assert room.deleted == [], "egma deleted nothing; Retell closes what it made"


def test_the_registry_knows_the_retell_web_call_plug():
    assert plug_for("retell_web_call") is RetellWebCall


def test_a_web_call_is_one_pipecat_voice_connection():
    """The seam gives Pipecat the transport instead of exchanging PCM."""
    connection = web_call(RoomStub(), base_url="http://127.0.0.1:1")
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
    room = RoomStub(
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
    way_in = room.joined_with[0]
    assert way_in.token == created["access_token"]
    assert way_in.url == RETELL_ROOM_HOST

    # And the record's join to Retell's telemetry is the call, which is the
    # one name both sides can look this exchange up by.
    assert conducted.provider_reference == created["call_id"]
    assert_egma_only_joined(room)

    # The recording resolves, the way it does for every voice simulation.
    audio = assembled.audio
    assert set(audio) == {"recording"}
    assert "://" not in audio["recording"]
    assert (tmp_path / audio["recording"]).read_bytes()


async def test_the_agent_ending_the_call_is_the_agent_ending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, start_retell_stub
):
    """Retell's participant leaving is the agent ending the exchange, and
    everything said up to that moment stays on the record."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = RoomStub(
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
    room = RoomStub(
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
    room = RoomStub(greeting="Remedy after hours.", replies=["Noted."])
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
    offers nothing in the room even for a simulation that resolved mock
    answers, and the record claims nothing about tools — which is the
    truth, because egma never stood in their path to learn anything."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = RoomStub(greeting="Remedy after hours.", replies=["Noted."])
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
                "delay_milliseconds": 0,
            }
        ],
    )

    assert assembled.mock_tool_coverage is None
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
    room = RoomStub()
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
    plug = web_call(RoomStub(), base_url=running.base_url)

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
    room = RoomStub()
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
    room = RoomStub()
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
    plug = web_call(RoomStub(), base_url=running.base_url)

    with pytest.raises(PlugError) as refused:
        await plug.prepare()
    await plug.close()

    told = str(refused.value)
    assert "invalid api key" in told, "the platform's own words are still quoted"
    assert SENTINEL_KEY not in told
    assert REDACTED in told


async def test_a_platform_that_answers_nowhere_fails_without_saying_the_key():
    """A closed port: the other way a platform is absent."""
    plug = web_call(RoomStub(), base_url="http://127.0.0.1:1")

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
    room = RoomStub(greeting="Remedy after hours.")
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
    room = RoomStub(refuses_join="access token is no longer valid")
    plug = web_call(room, base_url=running.base_url)

    await plug.prepare()
    with pytest.raises(PlugError) as refused:
        await plug.open()
    await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "access token is no longer valid" in told
    assert "opens one room once" in told
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
    room = RoomStub(agent_joins=False)
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
    room = RoomStub(agent_publishes_audio=False)
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
    room = RoomStub()
    plug = web_call(room, base_url="http://127.0.0.1:1")
    await plug.close()
    await plug.close()
    assert room.joined_rooms == []


async def test_opening_before_creating_is_refused_rather_than_guessed():
    plug = web_call(RoomStub(), base_url="http://127.0.0.1:1")
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

    natural = RoomStub(greeting="Remedy after hours.", replies=["Noted."])
    await web_call_walk(
        tmp_path, natural, monkeypatch, base_url=running.base_url, scenario="One point."
    )
    assert not natural.room.joined
    assert_egma_only_joined(natural)

    canceled = RoomStub(greeting="Remedy after hours.", replies=["Noted."])
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



class CancelsOnceUnderWay(WalkControls):
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
    room = RoomStub(
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
    produced.append(repr(room.backends[0]._settings))

    minted = running.stub.web_calls[0]["access_token"]
    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert SENTINEL_KEY not in piece
        assert minted not in piece


async def test_egma_never_invents_a_name_for_a_room_retell_named(
    start_retell_stub,
):
    """The room has a name already, and egma is never told it.

    Pipecat prints the room name into every connect and disconnect line, so
    a name made up here — ``egma-sim-<simulation>``, the one egma uses for
    rooms it opens itself — would put a string in the logs that exists in
    nobody's telemetry and that no one can look up on either side. What
    joins the two records is Retell's call id, which the plug carries as
    the provider reference instead.
    """
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = RoomStub(greeting="Remedy after hours.")
    plug = web_call(room, base_url=running.base_url)
    await plug.prepare()
    await plug.close()

    named = room.backends[0].room_name
    assert named == PLATFORM_NAMED_ROOM
    assert not named.startswith(ROOM_PREFIX), "that prefix is for rooms egma opens"
    assert A_SIMULATION not in named
    assert room_name_for(A_SIMULATION) != named
    # And the reference the record really carries is Retell's own.
    assert plug.provider_reference == running.stub.web_calls[0]["call_id"]


def test_the_way_in_is_a_secret_the_settings_know_they_hold():
    """The token is registered before anything can quote it, so a room that
    echoed it back would get it scrubbed like any other credential."""
    settings = RoomSettings(url=RETELL_ROOM_HOST, given_token="a-token")
    assert settings.secrets == ("a-token",)
    assert "a-token" not in repr(settings)
    assert not settings.mints_its_own, "egma minted nothing; it was handed this"


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
        {"retellAgentId": AN_AGENT, "roomHost": "retell-ai.livekit.cloud"},
        {"retellAgentId": AN_AGENT, "retellAgentld": "a typo"},
        {"retellAgentId": AN_AGENT, "apiKey": "a secret in the wrong block"},
        {"retellAgentId": AN_AGENT, "agentName": "a room's key, not this one's"},
    ],
)
def test_config_the_plug_does_not_understand_is_refused(config: dict):
    with pytest.raises(PlugError):
        web_call(RoomStub(), base_url="http://127.0.0.1:1", config=config)


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        web_call(
            RoomStub(),
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
        web_call(RoomStub(), base_url="http://127.0.0.1:1", credentials=credentials)


def test_a_credential_refusal_names_the_key_and_never_its_value():
    with pytest.raises(PlugError) as refusal:
        web_call(
            RoomStub(),
            base_url="http://127.0.0.1:1",
            credentials={"apiKey": SENTINEL_KEY, "apiSecret": SENTINEL_KEY},
        )
    assert "apiSecret" in str(refusal.value)
    assert SENTINEL_KEY not in str(refusal.value)


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        web_call(RoomStub(), base_url="http://127.0.0.1:1", modality="chat")
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


def test_the_room_host_is_retells_own_and_a_connection_may_name_another():
    """One value, in one place, tracked against Retell's own SDK — and
    overridable, so a deployment can follow Retell moving its
    infrastructure without waiting for a release of egma."""
    assert RETELL_ROOM_HOST.startswith("wss://")
    assert "livekit" in RETELL_ROOM_HOST

    stock = web_call(RoomStub(), base_url="http://127.0.0.1:1")
    assert stock.room_host == RETELL_ROOM_HOST

    named = web_call(
        RoomStub(),
        base_url="http://127.0.0.1:1",
        config={
            "retellAgentId": AN_AGENT,
            "baseUrl": "http://127.0.0.1:1",
            "roomHost": "wss://retell-eu.livekit.cloud",
        },
    )
    assert named.room_host == "wss://retell-eu.livekit.cloud"


async def test_the_room_is_reached_at_the_host_the_connection_named(
    start_retell_stub,
):
    """Whatever the connection says is where the join goes."""
    running = await start_retell_stub(api_key=SENTINEL_KEY)
    room = RoomStub(greeting="Remedy after hours.")
    plug = web_call(
        room,
        base_url=running.base_url,
        config={
            "retellAgentId": AN_AGENT,
            "baseUrl": running.base_url,
            "roomHost": "wss://retell-eu.livekit.cloud",
        },
    )
    await plug.prepare()
    await plug.close()

    assert room.joined_with[0].url == "wss://retell-eu.livekit.cloud"


def test_the_plug_and_the_stub_agree_on_where_a_web_call_is_created():
    """The two sides of this suite name one path, rather than a stub that
    serves whatever it is asked for.

    It does not say the path is Retell's — nothing hermetic can. What
    settles that is the API reference, and the ``/v2/`` prefix the shared
    Retell client already uses for the calls it makes.
    """
    from retell_stub import RetellStub

    served = {
        resource.canonical for resource in RetellStub().build_app().router.resources()
    }
    assert web_call_plug.CREATE_PATH in served
