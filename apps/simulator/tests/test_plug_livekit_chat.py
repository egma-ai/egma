"""Chat connection tests through the registry, pipeline, and stubbed room boundary.
Exercise stream ownership, turn completion, RPC, transcript, and room attribution.
Reject missing agentName before requests and accidental audio at first output.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import pytest
from conftest import (
    A_PERSONALITY,
    A_SCENARIO,
    a_spec,
    load_fixture_spec,
)
from room_stub import AGENT_IDENTITY, ChatStub, ClosesLate
from token_endpoint_stub import serving

from egma_simulator import service as service_module
from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.config import SimulatorConfig
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR
from egma_simulator.conversation import Conducted, ConversationControls, conduct
from egma_simulator.media.livekit_room import (
    CHAT_TOPIC,
    SPOKEN_TRACK_ATTRIBUTE,
    TRANSCRIPTION_TOPIC,
    LiveKitChatRoomBackend,
    RoomSettings,
    Utterance,
)
from egma_simulator.media.room import PERSONA_IDENTITY, ROOM_PREFIX
from egma_simulator.mock_tools import PROTOCOL_VERSION
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import PlugError, failed_ending, plug_for
from egma_simulator.plugs import livekit_chat as chat_plug
from egma_simulator.plugs.livekit_chat import LiveKitChat
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import RunningSimulation
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

A_URL = "wss://lakeside-dental.livekit.cloud"
A_KEY = "APIlakeside0000"
A_SECRET = "SENTINEL-livekit-chat-api-secret-4c81f0e6"
"""The customer's key pair. The secret is a sentinel because every path
below is scanned for it, on the way through and on the way out."""

AN_AGENT = "front-desk"
A_SIMULATION = "sim-room-chat-001"

QUIET_SECONDS = 0.2
"""What the quiet period is shortened to for the suite.

The production number is sized against a real agent calling a real tool,
and paying it in CI would buy nothing but seconds. The *rule* is what is
under test, so every script below places its pauses relative to this and
the arithmetic is the production arithmetic.
"""

A_PAUSE = QUIET_SECONDS / 2
"""A gap inside one turn — shorter than the quiet period, which is what
makes it a pause rather than the end of a turn."""

DRAIN_SECONDS = QUIET_SECONDS * 5
"""What the wait for a still-open stream is shortened to for the suite.

Larger than the quiet period, exactly as the production pair is and for
the same reason: it is the wait a turn pays *after* the quiet period has
expired with a stream still open, so a suite where the two were equal
would be testing arithmetic this plug does not do.
"""

A_LATE_CLOSE = QUIET_SECONDS * 2
"""How long a scripted stream stays open after its turn's other words.

Past the quiet period, so a turn that ended on what had already arrived is
already over when this stream closes — and comfortably inside the drain,
so a turn that waits for what it opened still has it. The gap between the
two is what the tests below read.
"""

A_NEVER_CLOSES = DRAIN_SECONDS * 5
"""How long a stream that is never going to close stays open.

Past every bound the plug has, which is what a stream whose trailer the
wire lost looks like from egma's seat: indistinguishable from one that is
still being written, until the bound decides.
"""

A_LONG_QUIET = QUIET_SECONDS * 10
"""A quiet period big enough to be caught being skipped.

Where a test claims the agent's own state ended a turn, the claim is only
worth anything if waiting out the quiet period instead would have shown.
Ten times the suite's number, and the assertions leave half of it as
margin, so a slow machine cannot pass the test by accident either way.
"""

A_JUST_AFTER = QUIET_SECONDS / 4
"""The gap between one utterance closing and the next one opening.

Short enough that the second stream is plainly the same turn still being
written, rather than the agent starting again.
"""

A_SLOW_TURN_PAUSE = A_LATE_CLOSE + A_JUST_AFTER
"""The gap inside a turn whose every utterance closes late.

Each stream opens just after the one before it closed, so a turn scripted
with this pause is several honest slow utterances in a row and not one
stalled stream anywhere.
"""

A_SLOW_TOOL = 3.0
"""Scripted pause between filler and answer, representing an unmocked tool lookup.
The fallback quiet period must allow the final answer to arrive.
"""

A_TOOL_TURN_GAP = A_SLOW_TOOL + 0.5
"""That lookup with a model round trip on either side of it.

Half a second for the pair, which is generous to the quiet period rather
than to the agent: two real round trips cost more than that, so a quiet
period that cannot carry this gap cannot carry the real one either.
"""

A_MEASURED_QUIET = QUIET_SECONDS * 5
"""A quiet period long enough to carry that gap at its production ratio."""

A_TOOL_PAUSE = (
    A_MEASURED_QUIET * A_TOOL_TURN_GAP / chat_plug.TURN_QUIET_SECONDS
)
"""The gap above, on the suite's clock, at the production ratio.

Divided by the real
:data:`~egma_simulator.plugs.livekit_chat.TURN_QUIET_SECONDS` rather than
by a copy of it, so the test holds the *number* and not only the rule:
shrink the quiet period and this pause grows past it, which is the same
turn being cut short that a real stateless agent would have.
"""


def chat_spec(
    simulation_id: str = A_SIMULATION,
    *,
    url: str = A_URL,
    agent_name: str | None = AN_AGENT,
    job_dispatch_metadata: dict | None = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    mock_tools: list[dict] | None = None,
) -> dict:
    """One chat spec whose connection names a room, and nothing else.

    Deliberately the same shape as the voice suite's ``livekit_spec``: a
    chat room simulation differs from a spoken one by its modality and by
    nothing else in the document, which is the whole point of one
    connection type answering in two — the test's own dispatch metadata
    included.
    """
    config: dict = {"url": url}
    if agent_name is not None:
        config["agentName"] = agent_name
    return a_spec(
        simulation_id,
        modality="chat",
        job_dispatch_metadata=job_dispatch_metadata,
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": config,
            "credentials": {"apiKey": A_KEY, "apiSecret": A_SECRET},
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
        mock_tools=mock_tools,
    )


AN_AUTH_HEADER = '{"Authorization":"Bearer SENTINEL-chat-endpoint-bearer-2f7a"}'


def chat_endpoint_spec(
    simulation_id: str = A_SIMULATION,
    *,
    token_endpoint: str = "https://acme.example/egma/livekit-token",
    agent_name: str = AN_AGENT,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
    mock_tools: list[dict] | None = None,
    job_dispatch_metadata: dict | None = None,
) -> dict:
    """One chat spec whose connection asks an endpoint for its token.

    The voice suite's ``livekit_endpoint_spec`` with ``chat`` for its
    modality and nothing else different — the two ways in differ by who
    mints the token, never by what is said in the room.
    """
    return a_spec(
        simulation_id,
        modality="chat",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.customer_token_endpoint",
            "config": {"tokenEndpoint": token_endpoint, "agentName": agent_name},
            "credentials": {"headers": AN_AUTH_HEADER},
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
        mock_tools=mock_tools,
        job_dispatch_metadata=job_dispatch_metadata,
    )


def chat_room(stub: ChatStub, **config: object) -> LiveKitChat:
    """One livekit chat plug against a room-shaped LiveKit."""
    return LiveKitChat(
        modality="chat",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": AN_AGENT} | config,
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )


def hurry(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shorten every wait this plug takes, and nothing about the rules.

    The budgets are the only thing collapsed. Which of them is consulted
    where, what ends a turn, and what a spent one returns are all the
    production code's.
    """
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", QUIET_SECONDS)
    monkeypatch.setattr(chat_plug, "GREETING_SECONDS", QUIET_SECONDS)
    monkeypatch.setattr(chat_plug, "REPLY_SECONDS", QUIET_SECONDS)
    monkeypatch.setattr(chat_plug, "TURN_DRAIN_SECONDS", DRAIN_SECONDS)
    monkeypatch.setattr(chat_plug, "AGENT_JOIN_SECONDS", 1.0)


async def chat_walk(
    tmp_path: Path,
    stub: ChatStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    controls: ConversationControls | None = None,
    built_by=chat_spec,
    **overrides: object,
) -> tuple[Conducted, list[tuple[str, str]], list[tuple[str, str | None]], object]:
    """One chat simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — and is driven by the real conversation loop, so
    everything below the room-shaped LiveKit is every line the service
    would run. What comes back is the ending, the transcript, the tool
    calls egma answered, and the assembled pipeline the seam lives on.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "LiveKitChatRoomBackend", stub.driver)
    spec = SimulationSpec.from_document(built_by(**overrides))
    turns: list[tuple[str, str]] = []

    async def on_turn(
        speaker: str, text: str, notes: tuple[str, ...] = ()
    ) -> None:
        del notes
        turns.append((speaker, text))

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.plug is not None, "a chat spec is looped, never conducted"
    conducted = await conduct(
        persona=Persona(
            authored=spec.persona,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        plug=assembled.plug,
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        on_turn=on_turn,
        on_timing=None,
        controls=controls if controls is not None else ConversationControls(),
        name="sim:room-chat-test",
    )
    return conducted, turns, assembled


def test_the_registry_answers_a_chat_room_spec_with_the_chat_plug():
    """The one place the modality choice lives, asked the way assembly
    asks it: with keywords, and with no idea which of the two came back."""
    factory = plug_for("livekit_room")
    assert factory is not None
    built = factory(
        modality="chat",
        access_variant="livekit_room.project_credentials",
        config={"url": A_URL, "agentName": AN_AGENT},
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
    )
    assert isinstance(built, LiveKitChat)
    assert built.provider_reference is None, "no room exists before one is made"


# -- One whole simulation ----------------------------------------------------


async def test_a_chat_livekit_spec_conducts_a_whole_simulation_in_a_room(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Everything a chat simulation owes its record, from a spec alone.

    A spec whose connection names a room and says ``chat`` becomes an
    exchange, and what comes back is a transcript, a distinct ending, the
    room's own name as the join to the platform's telemetry — and no audio
    at all, which is the honest shape of a record where no speech ever ran.
    """
    stub = ChatStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    conducted, turns, assembled = await chat_walk(
        tmp_path,
        stub,
        monkeypatch,
        scenario=(
            "I need to move my Tuesday cleaning to Thursday. My name is Margaret Hale."
        ),
    )

    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"

    # The room this was held in is the provider reference — one room, one
    # simulation, and the one join between egma's record and LiveKit's.
    assert conducted.provider_reference == stub.rooms[0].name
    assert conducted.provider_reference.startswith(f"{ROOM_PREFIX}-")

    # No speech leg was built and nothing was recorded, which is the whole
    # product claim: a chat simulation costs the customer no synthesis.
    assert assembled.conductor is None
    assert assembled.audio is None

    # Every persona turn that was delivered went out on the topic a
    # LiveKit session listens to, and nothing else went anywhere. The
    # concluding goodbye is on the transcript and not on the wire, which
    # is the conversation loop's own rule and not this plug's: a persona that has
    # concluded is not waiting for an answer.
    assert [typed.topic for typed in stub.typed] == [CHAT_TOPIC] * 2
    assert [typed.text for typed in stub.typed] == [
        text for speaker, text in turns if speaker == "human"
    ][:2]

    # And the room was not left behind.
    assert stub.deleted == [stub.rooms[0].name]


async def test_the_dispatch_carries_chat_and_none_of_the_test(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Chat modality belongs in the room name. Dispatch metadata contains only
    test-authored context and must not expose scenario instructions.
    """
    scenario = "Ask to move the Tuesday cleaning to Thursday. Say you are Margaret."
    stub = ChatStub(greeting="Front desk.", replies=["Noted."] * 8)
    await chat_walk(tmp_path, stub, monkeypatch, scenario=scenario)

    assert len(stub.dispatches) == 1
    assert stub.dispatches[0].agent_name == AN_AGENT
    assert stub.dispatches[0].metadata == ""
    for word in ("Tuesday", "Thursday", "Margaret", "cleaning", A_PERSONALITY):
        assert word not in stub.dispatches[0].metadata


async def test_a_chat_rooms_name_carries_the_mark_the_worker_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Pin the published egma-sim-chat- literal independently of the room-name builder.
    Deployed workers rely on it, and it must retain the general egma-sim- prefix.
    """
    stub = ChatStub(greeting="Front desk.", replies=["Noted."] * 8)
    await chat_walk(tmp_path, stub, monkeypatch)

    name = stub.rooms[0].name
    assert name.startswith("egma-sim-chat-")
    assert name.startswith("egma-sim-")
    suffix = name[len("egma-sim-chat-") :]
    assert suffix and all(digit in "0123456789abcdef" for digit in suffix)


async def test_a_tests_own_modality_key_cannot_touch_the_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A key a test writes cannot break the lane, whatever it is called.

    A test may write job dispatch metadata using egma's own key names — a
    ``modality`` of its own among them. It rides alone, byte for byte,
    exactly as the voice lane promises, and nothing about the simulation
    bends: nothing the simulation needs travels on that channel, because
    the room's name carries the modality and the persona's identity
    carries the mock-tool address.
    """
    written = {"modality": "my own word", "simulationId": "their-id"}
    stub = ChatStub(greeting="Front desk.", replies=["Noted."] * 8)
    conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, job_dispatch_metadata=written
    )

    # Their object, alone and untouched.
    assert json.loads(stub.dispatches[0].metadata) == written
    assert stub.dispatches[0].metadata == (
        '{"modality":"my own word","simulationId":"their-id"}'
    )
    # The room carries none of it, on this lane as on the spoken one.
    assert stub.rooms[0].metadata == ""
    # And the simulation neither noticed nor cared.
    assert stub.rooms[0].name.startswith("egma-sim-chat-")
    assert conducted.ending == "persona_concluded"
    assert ("agent", "Front desk.") in turns


async def test_a_chat_dispatch_carries_the_tests_metadata_byte_for_byte(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The typed lane writes it exactly as the spoken one does.

    The driver under both is the same driver, so this is the claim rather
    than a second implementation of it: one compact serialisation, key
    order as written, characters outside ASCII carried raw.
    """
    written = {"tenant": "caf\u00e9", "caller": {"name": "Margaret", "ids": [1, 2]}}
    stub = ChatStub(greeting="Front desk.", replies=["Noted."] * 8)
    await chat_walk(
        tmp_path, stub, monkeypatch, job_dispatch_metadata=written
    )

    assert stub.dispatches[0].metadata == (
        '{"tenant":"caf\u00e9","caller":{"name":"Margaret","ids":[1,2]}}'
    )
    assert json.loads(stub.dispatches[0].metadata) == written


async def test_a_greeting_that_outran_its_wait_is_never_the_first_answer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A greeting stream opened during persona send belongs to the old turn.
    Discard it from the answer without consuming the new turn's reply budget.
    """
    stub = ChatStub(
        greeting_during_first_send="Welcome to Lakeside Dental!",
        replies=["Thursday at 2:15 is free.", "Booked.", "Anything else?"],
    )
    conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch
    )

    agent_turns = [text for speaker, text in turns if speaker == "agent"]
    assert "Welcome to Lakeside Dental!" not in " ".join(agent_turns)
    assert agent_turns[0] == "Thursday at 2:15 is free."
    assert conducted.ending == "persona_concluded"


async def test_egma_answers_for_the_agents_tools_in_a_typed_room(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The mock-tool seam is modality-blind, and this is what that buys.

    The exchange knows nothing about rooms and nothing about speech, so a
    typed room gets tool answering for free — the one tool the test named
    is answered by egma, and the other runs its own implementation.
    """
    hurry(monkeypatch)
    stub = ChatStub(greeting="Front desk.", replies=["Noted."])
    monkeypatch.setattr(chat_plug, "LiveKitChatRoomBackend", stub.driver)
    spec = SimulationSpec.from_document(
        chat_spec(
            mock_tools=[
                {
                    "tool_name": "check_availability",
                    "answer": {"answer": "Nothing free on Tuesday."},
                }
            ]
        )
    )
    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    plug = assembled.plug
    assert plug is not None
    await plug.open()

    # What a session in this room says, said in two lines: the census, and
    # one call. Both are answered by egma's own code, unchanged.
    told = await stub.says_hello("check_availability", "opening_hours")
    assert told == {
        "protocol_version": PROTOCOL_VERSION,
        "mocked_tools": ["check_availability"],
    }
    answered = await stub.calls("check_availability", {"day": "Tuesday"})
    assert answered == {"answer": "Nothing free on Tuesday."}

    # And egma keeps no copy of what it served. On this lane the agent's
    # own process reports the call it made, so a row of egma's would be a
    # second record of one call, free to disagree with the first.
    assert assembled.tool_calls() == []
    await plug.close()


async def test_a_mocked_chat_simulation_puts_no_tool_row_of_egmas_on_the_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole claim, at the seam the contract draws.

    A chat spec naming one mocked tool goes in as a document, held to the
    contract on the way in; a session in the typed room reports two tools
    and calls the mocked one; and what comes back carries no tool row of
    egma's for either of them. The seam served the answer — that is what
    the call to it proves — and the record of the call is the agent's own
    POV of the simulation.
    """
    hurry(monkeypatch)
    stub = ChatStub(greeting="Front desk.", replies=["Nothing free, I am afraid."])
    monkeypatch.setattr(chat_plug, "LiveKitChatRoomBackend", stub.driver)
    monkeypatch.setattr(
        service_module,
        "build_model_client",
        lambda spec: ScriptedModel(spec.scenario_instructions),
    )
    monkeypatch.setattr(
        service_module.SpeechProviders,
        "from_models",
        classmethod(lambda _cls, _models, *, vad: SCRIPTED_PAIR),
    )
    filed: list[dict] = []
    control_plane = _FilingControlPlane(filed)
    simulation = RunningSimulation(
        SimulationSpec.from_document(
            chat_spec(
                scenario="One point.",
                mock_tools=[
                    {
                        "tool_name": "check_availability",
                        "answer": {"answer": "Nothing free on Tuesday."},
                    }
                ],
            )
        ),
        client=control_plane,
        config=SimulatorConfig(
            control_plane_url="http://127.0.0.1:1",
            claimant="sim-under-test",
            capacity=1,
            heartbeat_seconds=3600.0,
            claim_wait_seconds=1.0,
            report_deadline_seconds=5.0,
            wal_dir=tmp_path / "wal",
            blob_dir=tmp_path / "blobs",
            log_level="INFO",
        ),
        secrets=SecretRegistry(),
        blobs=FilesystemBlobStore(tmp_path / "blobs"),
    )

    async def agent_side() -> None:
        # A room where the exchange was never offered has nothing to wait
        # for, which is what the far side would find on a live one.
        await stub.standing_ready.wait()
        assert control_plane.registered == [
            (A_SIMULATION, "sim-under-test", stub.rooms[0].name)
        ]
        await stub.says_hello("check_availability", "opening_hours")
        await stub.calls("check_availability", {"day": "Tuesday"})

    await asyncio.gather(simulation.run(), agent_side())

    authored = [
        span["name"]
        for document in filed
        for resource in document.get("resourceSpans", [])
        for scope in resource["scopeSpans"]
        for span in scope["spans"]
    ]
    assert "tool_call" not in authored, (
        "egma answered the call and must write no row for it"
    )

    facts = next(
        event["facts"]
        for document in filed
        for event in document.get("events", [])
        if event["status"] in ("completed", "failed", "canceled")
    )
    assert facts["ending"] == "persona_concluded"
    assert facts["audio"] is None, "a typed simulation put audio on the record"
    assert facts["provider_reference"] == stub.rooms[0].name


class _FilingControlPlane:
    """A control plane that files everything and directs nothing.

    The simulator's real reporter runs against it — the same write-ahead
    log, the same one ordered sender — so what lands here is the bytes that
    would have gone on the wire.
    """

    def __init__(self, filed: list[dict]) -> None:
        self.filed = filed
        self.registered: list[tuple[str, str, str]] = []

    async def register_provider_reference(
        self, simulation_id: str, claimant: str, provider_reference: str
    ) -> None:
        self.registered.append((simulation_id, claimant, provider_reference))

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        del simulation_id
        self.filed.append(json.loads(serialized))

    async def spans(self, simulation_id: str, serialized: bytes) -> None:
        del simulation_id
        self.filed.append(json.loads(serialized))

    async def heartbeat(self, simulation_id: str, claimant: str) -> str | None:
        del simulation_id, claimant
        return None


# -- Where a turn ends -------------------------------------------------------
#
# The one real design question chat has, and two facts settle it together.
# The agent has to be finished, which it says itself on `lk.agent.state`
# and which the quiet period stands in for where it does not. And every
# stream the turn opened has to have closed, because a stream closing is
# an end-of-*utterance* marker and never an end-of-turn one — an utterance
# still being written belongs to the turn it began in however late it
# lands. Everything below is one of those two, or the bound on the second.


async def test_one_agent_turn_may_arrive_in_several_utterances(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Two closed streams, back to back, are one turn on the record.

    A rule that ended the turn at the first close would put the first
    sentence on the record and the rest nowhere, and the persona would
    answer half an answer.
    """
    stub = ChatStub(
        greeting="Front desk.",
        replies=[["Let me look at Thursday.", "Thursday at 2:15 is free."]],
    )
    _conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point."
    )

    assert turns == [
        ("agent", "Front desk."),
        ("human", "One point."),
        ("agent", "Let me look at Thursday.\nThursday at 2:15 is free."),
        ("human", GOODBYE),
    ]


async def test_a_tool_call_pause_inside_a_turn_does_not_end_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The reason the quiet period exists, played out.

    An agent says a filler, goes away to call a tool, and comes back with
    the answer. The gap is real time and the driver really waits through
    it: a quiet period that expired inside it would end the turn on the
    filler alone.
    """
    stub = ChatStub(
        greeting="Front desk.",
        replies=[["One moment while I check.", "Thursday at 2:15 is free."]],
        pause_seconds=A_PAUSE,
    )
    _conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point."
    )

    assert turns[2] == (
        "agent",
        "One moment while I check.\nThursday at 2:15 is free.",
    )


async def test_an_utterance_left_over_from_the_last_turn_is_never_this_one_s(
    monkeypatch: pytest.MonkeyPatch,
):
    """Clear queued earlier-turn utterances before collecting the next answer.
    Do not assign old words to a new question; streams already open retain their turn.
    """
    hurry(monkeypatch)
    stub = ChatStub(greeting=None, replies=["The second answer."])
    plug = chat_room(stub)
    await plug.open()

    room = plug.backend._room
    assert room is not None
    # Stamped with the turn before this one: a stream that opened while the
    # first question was outstanding and only finished now. Put straight on
    # the queue rather than opened as a stream, because that is the state
    # this test is about — the words are here, nothing is still open, and
    # the room has nothing left to wait for. Its place in the open order is
    # first because it is the first stream this room ever saw.
    room.utterances.put_nowait(
        Utterance(text="The first answer, late.", spoken=False, turn=0, opened=1)
    )

    answered = await plug.deliver("The second question.")

    assert answered.text == "The second answer."
    await plug.close()


async def test_an_utterance_still_open_when_its_own_turn_ends_stays_on_the_record(
    monkeypatch: pytest.MonkeyPatch,
):
    """Drain both greeting streams even when the first closes after the quiet period.
    Join them in open order, preserving the opening words.
    """
    hurry(monkeypatch)
    stub = ChatStub(greeting=None, replies=[])
    plug = chat_room(stub)

    opening = asyncio.ensure_future(plug.open())
    await asyncio.sleep(0)
    room = stub.room

    # Both streams open while the greeting is outstanding, which is where
    # an agent's opening opens. The first is still being written when the
    # second has closed; the quiet period is measured from that close.
    still_open = asyncio.Event()
    room._agent_said(_Echo("Hi! I", closes_when=still_open), AGENT_IDENTITY)
    room._agent_said(
        _Echo("can help you book an appointment."), AGENT_IDENTITY
    )

    async def closes_after_the_quiet_period() -> None:
        """The held stream closes late — but still inside its own turn.

        Past the quiet period on purpose, because that is the moment the
        defect ends the greeting: a turn that stops at what has already
        arrived is over before this line runs, and these words then land
        in the turn after, which refuses them.
        """
        await asyncio.sleep(A_LATE_CLOSE)
        still_open.set()

    closing = asyncio.ensure_future(closes_after_the_quiet_period())

    # The record, written exactly as `conversation.conduct` writes it: the opening
    # if there was one, the persona's turn, then the answer's words.
    record: list[tuple[str, str]] = []
    greeting = await opening
    await closing
    if greeting is not None:
        record.append(("agent", greeting))
    record.append(("human", "Hi, my name is Starter."))

    delivering = asyncio.ensure_future(plug.deliver("Hi, my name is Starter."))
    await asyncio.sleep(0)
    room._agent_said(_Echo("That sounds good, Starter."), AGENT_IDENTITY)
    answered = await delivering
    if answered.text is not None:
        record.append(("agent", answered.text))
    await plug.close()

    said = [text for speaker, text in record if speaker == "agent"]
    assert said[0].startswith("Hi! I"), (
        "the record's first agent turn begins part-way through what the "
        f"agent said: {said[0]!r}. The stream carrying its opening words was "
        "stamped with the greeting, the greeting ended without waiting for "
        "it, and the turn after refused it for being older"
    )


async def test_a_turn_arrives_in_the_order_it_was_said_not_the_order_it_landed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """One turn, two utterances, and the first one closes last.

    An agent writes a long opening and a short line after it, and the
    short one finishes first. Both streams opened in the same turn, so
    both are the same turn's — and the record has to read the way the
    agent said them. Joining on arrival reversed them, which is the
    sentence the founder read: an agent turn beginning half-way through
    itself.
    """
    stub = ChatStub(
        greeting="Front desk.",
        replies=[
            [
                ClosesLate("Let me look at Thursday.", A_LATE_CLOSE),
                "Thursday at 2:15 is free.",
            ]
        ],
    )
    _conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point."
    )

    assert turns[2] == (
        "agent",
        "Let me look at Thursday.\nThursday at 2:15 is free.",
    )


async def test_a_stream_that_never_closes_bounds_the_turn_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Bound a stalled stream wait and log the room, turn, open-reader count,
    and last agent state. The diagnostic belongs in logs, not an invented report field.
    """
    caplog.set_level(logging.WARNING)
    stub = ChatStub(
        greeting="Front desk.",
        replies=[
            [
                "Let me look at Thursday.",
                ClosesLate("Thursday at 2:15 is free.", A_NEVER_CLOSES),
            ],
            "Booked.",
        ],
    )
    _conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point. Another point."
    )

    # The words that did arrive are on the record, and the ones still
    # being written are not — which is the honest half of a bad outcome.
    assert turns[2] == ("agent", "Let me look at Thursday.")

    bounded = [
        record.getMessage()
        for record in caplog.records
        if "open-stream path" in record.getMessage()
    ]
    assert len(bounded) == 1, caplog.text
    told = bounded[0]
    assert stub.rooms[0].name in told, "the log has to name the room"
    assert "turn 1" in told, "the log has to name the turn that lost the words"
    assert "nothing at all" in told, "this agent published no state, and so it says"


async def test_a_turn_of_slow_utterances_gives_every_stream_the_whole_bound(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Reset the drain budget as each utterance arrives. Five slow but progressing
    streams must complete instead of sharing one expiring turn-wide budget.
    """
    caplog.set_level(logging.WARNING)
    hurry(monkeypatch)
    stub = ChatStub(
        greeting=None,
        replies=[
            [
                ClosesLate("Let me look at Thursday.", A_LATE_CLOSE),
                ClosesLate("Checking the morning first.", A_LATE_CLOSE),
                ClosesLate("Nothing before eleven.", A_LATE_CLOSE),
                ClosesLate("The afternoon is better.", A_LATE_CLOSE),
                ClosesLate("Thursday at 2:15 is free.", A_LATE_CLOSE),
            ]
        ],
        pause_seconds=A_SLOW_TURN_PAUSE,
    )
    plug = chat_room(stub)
    assert await plug.open() is None

    answered = await plug.deliver("Anything on Thursday?")

    assert answered.text == (
        "Let me look at Thursday.\n"
        "Checking the morning first.\n"
        "Nothing before eleven.\n"
        "The afternoon is better.\n"
        "Thursday at 2:15 is free."
    ), (
        "words were dropped from a turn whose every stream closed on its "
        "own, so the bound was spent on the streams that had already "
        "finished rather than on the one still being written"
    )
    assert not [
        record
        for record in caplog.records
        if "open-stream path" in record.getMessage()
    ], "an agent writing steadily was filed as a stalled stream"
    await plug.close()


async def test_the_agents_own_state_ends_the_turn_without_the_quiet_period(
    monkeypatch: pytest.MonkeyPatch
):
    """A finished agent state must bypass the quiet fallback. Use a much larger quiet
    period here so scheduler noise cannot explain a fast return.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", A_LONG_QUIET)
    stub = ChatStub(
        greeting="Front desk.",
        replies=["Thursday at 2:15 is free."],
        agent_states=[["listening"], ["thinking", "speaking", "listening"]],
    )
    plug = chat_room(stub)
    await plug.open()

    began = asyncio.get_running_loop().time()
    answered = await plug.deliver("Anything on Thursday?")
    took = asyncio.get_running_loop().time() - began

    assert answered.text == "Thursday at 2:15 is free."
    assert took < A_LONG_QUIET / 2, (
        f"the turn took {took:.2f}s against a {A_LONG_QUIET:.1f}s quiet "
        "period, so it waited out a silence the agent had already broken"
    )
    await plug.close()


async def test_a_state_change_egma_never_saw_go_by_still_ends_the_turn(
    monkeypatch: pytest.MonkeyPatch
):
    """A listening-only transition must end a started turn without prior thinking
    or speaking events, which LiveKit can coalesce away.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", A_LONG_QUIET)
    stub = ChatStub(
        greeting="Front desk.",
        replies=["Thursday at 2:15 is free."],
        # One state for the whole turn, and it is the last one. This is
        # the wire egma really gets from a fast agent.
        agent_states=[[], ["listening"]],
    )
    plug = chat_room(stub)
    await plug.open()

    began = asyncio.get_running_loop().time()
    answered = await plug.deliver("Anything on Thursday?")
    took = asyncio.get_running_loop().time() - began

    assert answered.text == "Thursday at 2:15 is free."
    assert took < A_LONG_QUIET / 2, f"the turn waited {took:.2f}s to be told twice"
    await plug.close()


async def test_an_agent_that_publishes_no_state_is_no_worse_off_than_before(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The fallback, which is the whole of the rule for some agents.

    An agent that is not a LiveKit session publishes nothing on
    ``lk.agent.state``, and the quiet period is then the only thing that
    can end its turns. It still does, and it still waits through the pause
    a tool call leaves in the middle of one: the filler and the answer are
    one turn on the record, exactly as before any of this was read off the
    wire.
    """
    stub = ChatStub(
        greeting="Front desk.",
        replies=[["One moment while I check.", "Thursday at 2:15 is free."]],
        pause_seconds=A_PAUSE,
    )
    assert stub.agent_states is None, "this agent says nothing about itself"
    _conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point."
    )

    assert turns[2] == (
        "agent",
        "One moment while I check.\nThursday at 2:15 is free.",
    )


async def test_a_stateless_agent_may_take_a_slow_real_tool_inside_one_turn(
    monkeypatch: pytest.MonkeyPatch
):
    """Preserve the final answer after an unmocked-tool pause from a stateless agent.
    Scale the pause by the production quiet period so shortening that constant
    causes this regression test to fail.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", A_MEASURED_QUIET)
    stub = ChatStub(
        greeting=None,
        replies=[
            [
                "One moment while I check the calendar.",
                "Nothing is free on Tuesday.",
            ]
        ],
        pause_seconds=A_TOOL_PAUSE,
    )
    assert stub.agent_states is None, "this agent says nothing about itself"
    plug = chat_room(stub)
    assert await plug.open() is None

    answered = await plug.deliver("Anything on Tuesday?")

    assert answered.text == (
        "One moment while I check the calendar.\nNothing is free on Tuesday."
    ), (
        f"the answer was lost across a {A_TOOL_PAUSE:.2f}s gap inside one "
        f"turn — a {A_SLOW_TOOL:.0f}-second real backend lookup with a model "
        "round trip either side, on this suite's clock at the production "
        "ratio. The quiet period is the whole of the rule for an agent that "
        "publishes no state, so it has to outlast that gap"
    )
    await plug.close()


async def test_the_finish_line_is_the_answers_start_not_the_turns_end(
    monkeypatch: pytest.MonkeyPatch,
):
    """turn_response_latency ends when the answer starts, before the quiet wait.
    Check that deliver() pays the wait but the reported timestamp excludes it.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", A_MEASURED_QUIET)
    stub = ChatStub(greeting=None, replies=[["In person it is."]])
    assert stub.agent_states is None, "this agent says nothing about itself"
    plug = chat_room(stub)
    assert await plug.open() is None

    clock = asyncio.get_running_loop()
    asked_at = clock.time()
    answered = await plug.deliver("In person, please.")
    returned_at = clock.time()

    assert answered.answered_at is not None, (
        "this lane can see when the agent began answering — a stream's "
        "header is that moment — and a plug that reported nothing would "
        "send the loop back to timing its own call"
    )
    to_the_answer = answered.answered_at - asked_at
    to_the_return = returned_at - asked_at
    assert to_the_return >= A_MEASURED_QUIET, (
        "the quiet period was not actually paid, so this test is not "
        "holding the two instants apart at all"
    )
    assert to_the_answer < A_MEASURED_QUIET, (
        f"the answer began {to_the_answer:.3f}s in and the call returned "
        f"{to_the_return:.3f}s in: the finish line has to be the first, or "
        "every stateless agent is billed egma's whole quiet period"
    )
    await plug.close()


async def test_the_state_a_session_starts_in_never_ends_the_greeting(
    monkeypatch: pytest.MonkeyPatch
):
    """Startup listening must not end a greeting before its first words.
    Enable the finished-state signal only after output begins.
    """
    hurry(monkeypatch)
    stub = ChatStub(
        agent_state_at_start="listening",
        greeting=["Hello there.", "How can I help?"],
        replies=["Thursday at 2:15 is free."],
        answer_delay_seconds=A_PAUSE,
        pause_seconds=A_PAUSE,
    )
    plug = chat_room(stub)

    assert await plug.open() == "Hello there.\nHow can I help?"
    await plug.close()


async def test_a_greeting_that_never_comes_is_still_not_a_failure(
    monkeypatch: pytest.MonkeyPatch
):
    """The other half of the greeting's exemption, with a state on the wire.

    This agent announces itself listening and then waits to be spoken to,
    which is most agents. The greeting budget expires, ``open`` answers
    with nothing, and the conversation loop has the persona go first. Nothing about
    reading the agent's state may turn that ordinary answer into a fault.
    """
    hurry(monkeypatch)
    stub = ChatStub(agent_state_at_start="listening", replies=["Certainly."])
    plug = chat_room(stub)

    assert await plug.open() is None
    assert (await plug.deliver("One point.")).text == "Certainly."
    await plug.close()


async def test_a_finished_state_never_ends_a_turn_that_owes_itself_a_stream(
    monkeypatch: pytest.MonkeyPatch
):
    """The two halves in the one order that matters.

    An agent can say it has finished while a stream it opened is still
    being written — the state travels on one channel and the words on
    another, and nothing sequences the two. The finished state is not a
    licence to stop reading: a turn still owes itself every stream it
    opened, and the words that arrive late are still the answer to the
    question that prompted them.
    """
    hurry(monkeypatch)
    stub = ChatStub(greeting=None, replies=[])
    plug = chat_room(stub)
    assert await plug.open() is None
    room = stub.room

    delivering = asyncio.ensure_future(plug.deliver("Anything on Thursday?"))
    await asyncio.sleep(0)

    still_open = asyncio.Event()
    room._agent_said(_Echo("Let me check that."), AGENT_IDENTITY)
    room._agent_said(
        _Echo("Thursday at 2:15 is free.", closes_when=still_open), AGENT_IDENTITY
    )
    await asyncio.sleep(0)
    # The agent says it has finished while the second stream is still open.
    room.agent_publishes_state("listening")

    async def closes_after_the_quiet_period() -> None:
        await asyncio.sleep(A_LATE_CLOSE)
        still_open.set()

    closing = asyncio.ensure_future(closes_after_the_quiet_period())
    answered = await delivering
    await closing

    assert answered.text == "Let me check that.\nThursday at 2:15 is free."
    await plug.close()


@pytest.mark.parametrize(
    "state_first",
    [False, True],
    ids=["the trailer lands first", "the finished state lands first"],
)
async def test_a_finished_state_ends_the_turn_in_either_channel_order(
    monkeypatch: pytest.MonkeyPatch, state_first: bool
):
    """Accept finished state and the last stream trailer in either arrival order.
    Only a stream opened after the state clears the latch; earlier streams must
    not force another quiet wait when their trailers arrive later.
    """
    hurry(monkeypatch)
    monkeypatch.setattr(chat_plug, "TURN_QUIET_SECONDS", A_LONG_QUIET)
    stub = ChatStub(greeting=None, replies=[])
    plug = chat_room(stub)
    assert await plug.open() is None
    room = stub.room

    delivering = asyncio.ensure_future(plug.deliver("Anything on Thursday?"))
    await asyncio.sleep(0)
    closing = asyncio.Event()
    room._agent_said(
        _Echo("Thursday at 2:15 is free.", closes_when=closing), AGENT_IDENTITY
    )
    await asyncio.sleep(0)

    began = asyncio.get_running_loop().time()
    if state_first:
        # The state overtakes the trailer of the very utterance it is
        # about, which is an ordinary race and not a stale signal.
        room.agent_publishes_state("listening")
        closing.set()
    else:
        # The words really are on the record before the state goes out,
        # which is what makes this the other ordering and not the same
        # one. Waited on by the driver's own reader task rather than by a
        # sleep, so the ordering is a fact rather than a hope.
        reading = [
            task
            for task in asyncio.all_tasks()
            if task.get_name() == "livekit-agent-utterance"
        ]
        assert reading, "the driver opened no reader for this stream"
        closing.set()
        await asyncio.wait(reading)
        room.agent_publishes_state("listening")

    answered = await delivering
    took = asyncio.get_running_loop().time() - began

    assert answered.text == "Thursday at 2:15 is free."
    assert took < A_LONG_QUIET / 2, (
        f"the turn took {took:.2f}s against a {A_LONG_QUIET:.1f}s quiet "
        "period, so the agent said it had finished and egma waited the "
        "silence out anyway"
    )
    await plug.close()


async def test_the_server_dropping_egma_is_answered_at_once_not_after_the_drain(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """A room that is gone is not a turn that is slow.

    The bound on a still-open stream is spent so that words already on
    their way reach the record. Egma losing the room means nothing is on
    its way and there is no record to reach: the answer is the fault
    raised out of the turn, and paying the bound first would delay it by
    the whole drain and then file a line saying these words will be
    refused by the turn after — when the exchange has no turn after.
    """
    caplog.set_level(logging.WARNING)
    hurry(monkeypatch)
    stub = ChatStub(greeting=None, replies=[])
    plug = chat_room(stub)
    assert await plug.open() is None
    room = stub.room

    delivering = asyncio.ensure_future(plug.deliver("Anything on Thursday?"))
    await asyncio.sleep(0)
    # A stream opens and never closes, so the turn is owed an utterance —
    # and then the server drops egma out of the room.
    room._agent_said(_Echo("Thursday at", closes_when=asyncio.Event()), AGENT_IDENTITY)
    await asyncio.sleep(0)
    began = asyncio.get_running_loop().time()
    room.failed.set()

    with pytest.raises(PlugError) as dropped:
        await delivering
    took = asyncio.get_running_loop().time() - began

    assert failed_ending(dropped.value) == ERROR
    assert "while the exchange was under way" in str(dropped.value)
    assert took < DRAIN_SECONDS / 2, (
        f"the fault took {took:.2f}s to surface against a {DRAIN_SECONDS:.1f}s "
        "drain, so it waited out a bound meant for a stream still arriving"
    )
    assert not [
        record
        for record in caplog.records
        if "open-stream path" in record.getMessage()
    ], "a room that is gone owes no turn after, and nothing may say it does"
    await plug.close()


async def test_a_stream_that_cannot_be_read_says_which_path_lost_the_words(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """Distinguish unreadable streams from discarded stale-turn words in logs.
    Both diagnostics identify room and turn; unreadable content has no known length.
    """
    caplog.set_level(logging.WARNING)
    hurry(monkeypatch)
    stub = ChatStub(greeting=None, replies=[])
    plug = chat_room(stub)

    opening = asyncio.ensure_future(plug.open())
    await asyncio.sleep(0)
    stub.room._agent_said(_Unread(RuntimeError("the stream was reset")), AGENT_IDENTITY)

    assert await opening is None, "nothing was read, so nothing is on the record"
    await plug.close()

    unread = [
        record.getMessage()
        for record in caplog.records
        if "unread-stream path" in record.getMessage()
    ]
    assert len(unread) == 1, caplog.text
    told = unread[0]
    assert stub.rooms[0].name in told, "the log has to name the room"
    assert "turn 0" in told, "the log has to name the turn that lost the words"
    assert "not known" in told, "this path cannot name a length and must not"
    assert "stale-turn" not in told, "the two paths must not read alike"


async def test_a_speaking_agent_is_still_caught_when_it_publishes_its_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Reading the agent's state may not soften the one refusal that matters.

    An agent that never took the chat setup is caught at its first output,
    and the state channel is beside the point: it is the transcribed-track
    mark on the words that says the exchange is speech-paced. A turn-end
    rule that consulted the state first would have to hear the whole turn
    out before refusing it, and every further persona turn would spend
    more of the customer's speech budget proving the same thing twice.
    """
    stub = ChatStub(
        greeting="Lakeside Dental, good afternoon.",
        replies=["Thursday at 2:15 is free."],
        marks_speech=True,
        agent_states=[["speaking", "listening"], ["listening"]],
    )

    with pytest.raises(PlugError) as refused:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert "chat setup" in str(refused.value)
    assert stub.typed == [], "no persona turn was delivered after the refusal"


async def test_a_turn_the_agent_never_answers_stops_the_exchange(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """End the exchange when a persona turn receives no answer within its budget.
    A stream that opens after the next question could not be attributed safely.
    """
    stub = ChatStub(greeting="Front desk.", replies=[])

    with pytest.raises(PlugError) as unanswered:
        await chat_walk(
            tmp_path, stub, monkeypatch, scenario="One point. Another point."
        )

    assert failed_ending(unanswered.value) == ERROR
    told = str(unanswered.value)
    assert "said nothing at all" in told
    assert "never asked" in told, "the reason says what going on would risk"


async def test_a_greeting_that_never_comes_lets_the_persona_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Plenty of agents wait to be spoken to, and that is not a failure.

    The greeting budget expires, ``open`` answers with nothing, and the
    conversation loop has the persona go first — which is exactly what it does for
    every other plug that opens on silence.
    """
    stub = ChatStub(replies=["Certainly, Thursday it is."])
    conducted, turns, _assembled = await chat_walk(
        tmp_path, stub, monkeypatch, scenario="One point."
    )

    assert turns[0] == ("human", "One point.")
    assert conducted.ending == "persona_concluded"


async def test_the_agent_leaving_mid_exchange_is_the_agent_ending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The agent's participant leaving *is* the agent ending the exchange,
    and its last words stay on the record rather than being lost with it."""
    stub = ChatStub(
        greeting="Front desk.",
        replies=["I am afraid I have to go. Goodbye."],
        hangs_up_after_replies=True,
    )
    conducted, turns, _assembled = await chat_walk(
        tmp_path,
        stub,
        monkeypatch,
        scenario=" ".join(f"Sentence number {n}." for n in range(1, 41)),
    )

    assert conducted.status == "completed"
    assert conducted.ending == "agent_ended"
    assert turns == [
        ("agent", "Front desk."),
        ("human", "Sentence number 1."),
        ("agent", "I am afraid I have to go. Goodbye."),
    ]
    assert stub.deleted == [stub.rooms[0].name]


def test_the_waits_are_bounded_and_shorter_than_a_simulation():
    """The four budgets, pinned where the tests above shorten them.

    A wait that outran a simulation's duration limit would put
    ``limit_reached`` on a record whose real story is that the agent was
    still thinking, or never turned up at all.
    """
    assert 0 < chat_plug.AGENT_JOIN_SECONDS <= 60
    assert 0 < chat_plug.GREETING_SECONDS <= 30
    assert 0 < chat_plug.TURN_QUIET_SECONDS <= 15
    assert 0 < chat_plug.TURN_DRAIN_SECONDS <= chat_plug.AGENT_JOIN_SECONDS
    # The quiet period is the one paid on every turn an agent does not end
    # itself, so it is the one that has to stay smallest: a whole test
    # suite of chat simulations finishing in seconds is what this number
    # is spent against.
    assert chat_plug.TURN_QUIET_SECONDS < chat_plug.GREETING_SECONDS
    assert chat_plug.GREETING_SECONDS < chat_plug.AGENT_JOIN_SECONDS
    # And the drain has to be the larger of the pair, because it is paid
    # after the quiet period has already expired with a stream still open.
    # A drain shorter than the quiet period would mean a turn gave a
    # stream it could see was open less time than it gave the silence.
    assert chat_plug.TURN_QUIET_SECONDS < chat_plug.TURN_DRAIN_SECONDS


# -- An agent that never took the chat setup ---------------------------------
#
# The wire says which of the two states an agent is in and says it at the
# agent's first output, so the simulation ends there. Two routes, tested
# apart because either one alone is enough: the track it publishes, and
# the mark on its words.


@pytest.mark.parametrize(
    ("script", "how"),
    [
        ({"agent_publishes_audio_track": True}, "an audio track in the room"),
        ({"marks_speech": True}, "the transcribed-track mark on its words"),
    ],
)
async def test_an_agent_that_is_speaking_ends_the_simulation_at_its_first_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    script: dict,
    how: str,
):
    """A speech-paced exchange is never graded as a typed one.

    The reason names the setup that is missing rather than the symptom, so
    what the developer reads is the thing to go and fix. And nothing more
    is delivered: every further persona turn would spend more of the
    customer's speech budget proving the same thing twice.
    """
    stub = ChatStub(
        greeting="Lakeside Dental, good afternoon.",
        replies=["Thursday at 2:15 is free."],
        **script,
    )

    with pytest.raises(PlugError) as refused:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR, how
    assert "chat setup" in told
    assert "modality" in told
    assert stub.typed == [], "no persona turn was delivered after the refusal"
    # It was still a room somebody paid for, and it went away.
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_speaking_agent_is_caught_on_its_first_answer_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The same refusal one turn later, for the agent that greets nobody.

    A silent opening is not evidence of anything, so the first thing this
    agent produces is its answer to the persona — and that is where it is
    caught, with exactly one persona turn spent and no second one.
    """
    stub = ChatStub(replies=["Thursday at 2:15 is free.", "Booked."], marks_speech=True)

    with pytest.raises(PlugError) as refused:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One. Two. Three.")

    assert "chat setup" in str(refused.value)
    assert [typed.text for typed in stub.typed] == ["One."]


# -- Connections the plug does not understand --------------------------------


def test_the_plug_speaks_chat_only():
    """The plug carrying the speech legs is the one next door, and this
    one has no transport to give a pipeline."""
    with pytest.raises(PlugError) as refusal:
        LiveKitChat(
            modality="voice",
            access_variant="livekit_room.project_credentials",
            config={"url": A_URL, "agentName": AN_AGENT},
            credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
            simulation_id=A_SIMULATION,
        )
    assert "voice" in str(refusal.value)


async def test_a_chat_spec_through_a_token_endpoint_conducts_a_whole_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The chat lane on the other way in.

    The endpoint is asked for the *marked* room — spelled by hand here for
    the reason the mark test above spells it — by LiveKit's standard token
    request naming the worker; the token comes back; egma joins with it;
    the worker somebody else dispatched turns up typing; and the exchange
    is the one the key-pair shape conducts, word for word.
    """
    stub = ChatStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    written = {"tenant": "acme"}
    with serving(token="minted.by.the.customer") as endpoint:
        conducted, turns, assembled = await chat_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=chat_endpoint_spec,
            token_endpoint=endpoint.url,
            job_dispatch_metadata=written,
            scenario=(
                "I need to move my Tuesday cleaning to Thursday. "
                "My name is Margaret Hale."
            ),
        )

    assert turns == [
        ("agent", "Lakeside Dental, how can I help?"),
        ("human", "I need to move my Tuesday cleaning to Thursday."),
        ("agent", "Of course — could I take your name?"),
        ("human", "My name is Margaret Hale."),
        ("agent", "Booked for Thursday."),
        ("human", GOODBYE),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"
    assert assembled.conductor is None, "no speech leg was built"

    # One request, in the standard shape, for the marked room and the
    # named worker — and the token it answered is what egma joined with.
    assert len(endpoint.asked) == 1
    asked = endpoint.asked[0]
    assert asked.body["room_name"] == f"egma-sim-chat-{A_SIMULATION}"
    assert asked.body["room_name"].startswith("egma-sim-")
    assert asked.body["participant_identity"] == f"{PERSONA_IDENTITY}-{A_SIMULATION}"
    assert asked.body["room_config"] == {
        "agents": [
            {
                "agent_name": AN_AGENT,
                "metadata": json.dumps(written, separators=(",", ":")),
            }
        ]
    }
    assert asked.header("authorization") == "Bearer SENTINEL-chat-endpoint-bearer-2f7a"
    assert stub.joined_with[0].token == "minted.by.the.customer"

    # Nothing was created and nothing was dispatched by egma: it holds no
    # key pair here, and the room it typed in is the one it asked for.
    assert stub.rooms == []
    assert conducted.provider_reference == f"egma-sim-chat-{A_SIMULATION}"


def test_the_chat_plug_takes_a_token_endpoint_connection():
    """The refusal this variant used to draw is gone: the plug reads the
    endpoint shape the voice plug reads, and names the marked room."""
    stub = ChatStub()
    plug = LiveKitChat(
        modality="chat",
        access_variant="livekit_room.customer_token_endpoint",
        config={
            "tokenEndpoint": "https://acme.example/egma/livekit-token",
            "agentName": "front-desk",
        },
        credentials={"headers": AN_AUTH_HEADER},
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )
    assert plug.backend.room_name == f"egma-sim-chat-{A_SIMULATION}"


@pytest.mark.parametrize("agent_name", [None, "", "   "])
def test_a_chat_connection_that_names_no_agent_is_refused(agent_name: str | None):
    """The same demand the voice plug makes, and for the same reason:
    an explicit dispatch is what lets the record name the agent it
    graded, whichever modality the room conducts."""
    config: dict = {"url": A_URL}
    if agent_name is not None:
        config["agentName"] = agent_name
    with pytest.raises(PlugError) as refusal:
        LiveKitChat(
            modality="chat",
            access_variant="livekit_room.project_credentials",
            config=config,
            credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
            simulation_id=A_SIMULATION,
        )
    assert "agentName" in str(refusal.value)


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        chat_room(ChatStub(), agentNmae="a typo")
    assert "agentNmae" in str(refusal.value)


def test_a_refusal_about_a_credential_never_quotes_one():
    """A sentence about a secret must not carry one — on this plug as on
    the one next door, because it is the same reader."""
    with pytest.raises(PlugError) as refusal:
        LiveKitChat(
            modality="chat",
            access_variant="livekit_room.project_credentials",
            config={"url": A_URL, "agentName": AN_AGENT},
            credentials={"apiKey": A_KEY, "apiSecret": "   "},
            simulation_id=A_SIMULATION,
        )
    told = str(refusal.value)
    assert "apiSecret" in told
    assert A_SECRET not in told


# -- Every way a typed room fails to become a simulation ---------------------


async def test_a_worker_that_never_comes_is_never_the_agent_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The room opens, the dispatch goes out, and nobody arrives.

    Nothing was tested, so nothing is graded, and the reason is worded for
    whoever has to go and look at their worker.
    """
    monkeypatch.setattr(chat_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = ChatStub(agent_joins=False)

    with pytest.raises(PlugError) as never_came:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    told = str(never_came.value)
    assert AN_AGENT in told, "the name nobody registered has to be on the record"
    assert "worker" in told
    assert len(stub.dispatches) == 1
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_chat_worker_that_never_reports_to_egma_fails_the_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A chat room is a LiveKit simulation, and needs the SDK just as much.

    Same verb in the worker, same exchange in the room, same mocked tools
    answered over it. So a worker that joins, types and never says
    ``egma.hello`` isolated nothing here either — and a green record of
    that is the one outcome this rule exists to stop.
    """
    stub = ChatStub(greeting="Front desk.", replies=["Noted."], agent_reports=False)

    with pytest.raises(PlugError) as unreported:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(unreported.value) == AGENT_NEVER_JOINED
    told = str(unreported.value)
    assert "did not report to Egma" in told
    assert "egma.hello" in told
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_dispatch_the_platform_refuses_is_a_fault_in_its_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    stub = ChatStub(refuses_dispatch="no worker registered as 'front-desk'")

    with pytest.raises(PlugError) as refused:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(refused.value) == ERROR
    assert "no worker registered" in str(refused.value)
    assert stub.deleted == [stub.rooms[0].name]


async def test_the_room_is_deleted_however_the_chat_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A room that outlived its simulation would go on costing the
    customer, so it is deleted on every way out."""
    natural = ChatStub(greeting="Front desk.", replies=["Noted."])
    await chat_walk(tmp_path, natural, monkeypatch, scenario="One point.")
    assert natural.deleted == [natural.rooms[0].name]

    limited = ChatStub(greeting="Front desk.", replies=["One.", "Two.", "Three."])
    conducted, _turns, _assembled = await chat_walk(
        tmp_path,
        limited,
        monkeypatch,
        scenario="First. Second. Third. Fourth.",
        max_turns=3,
    )
    assert conducted.ending == "limit_reached"
    assert limited.deleted == [limited.rooms[0].name]

    faulted = ChatStub(refuses_room="room name already taken")
    with pytest.raises(PlugError):
        await chat_walk(tmp_path, faulted, monkeypatch, scenario="One.")
    assert faulted.deleted


async def test_closing_a_chat_that_never_opened_asks_for_nothing():
    """``close`` is called whatever happened, including before ``open`` —
    and a simulation that never made a room must not spend a request
    deleting one, because that request could only fail."""
    stub = ChatStub()
    plug = chat_room(stub)
    await plug.close()
    await plug.close()
    assert stub.rooms == [], "nothing was ever made"
    assert stub.deleted == [], "nothing was ever there to delete"


# -- The driver seam ---------------------------------------------------------


def test_the_fake_is_the_real_chat_driver_with_its_network_answered():
    """The claim the chat fake's fidelity rests on.

    The same four overrides as the voice fake, for the same reason: the
    room's network is answered here, and the token request is not — a chat
    connection that asks a customer's endpoint really asks the loopback
    fake, so the loopback route is the one exception to the production
    connector's policy, in both fakes alike.
    """
    stub = ChatStub()
    driver = stub.driver(
        settings=RoomSettings.from_connection(
            "livekit_room.project_credentials",
            {"url": A_URL, "agentName": AN_AGENT},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        simulation_id=A_SIMULATION,
    )
    assert isinstance(driver, LiveKitChatRoomBackend)
    overridden = {
        name
        for name in vars(type(driver))
        if not name.startswith("__") and hasattr(LiveKitChatRoomBackend, name)
    }
    assert overridden == {
        "_asked",
        "_joined_room",
        "_delete_room",
        "_endpoint_connector",
    }


async def test_egmas_own_words_are_never_read_back_as_the_agents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """An agent that transcribes what it was told sends that back on the
    same topic, and reading it would put the persona's own turn on the
    record twice — as the agent's answer to itself."""
    hurry(monkeypatch)
    stub = ChatStub(greeting="Front desk.")
    plug = chat_room(stub)
    assert await plug.open() == "Front desk."

    room = stub.room
    # Both streams open while the turn is outstanding, which is where a
    # real one opens: an agent answers after it has been asked, and an
    # utterance is stamped with the turn it opened in.
    delivering = asyncio.ensure_future(plug.deliver("One point."))
    await asyncio.sleep(0)
    room._agent_said(_Echo("One point."), PERSONA_IDENTITY)
    room._agent_said(_Echo("Certainly."), AGENT_IDENTITY)
    answered = await delivering

    assert answered.text == "Certainly."
    await plug.close()


class _Echo:
    """One transcription stream, read to its close without a LiveKit.

    ``closes_when`` holds the stream open until the test says otherwise,
    which is the one thing a stream really does that a queued utterance
    cannot show: the header is here and stamped, and the words are not.
    """

    def __init__(
        self,
        said: str,
        *,
        spoken: bool = False,
        closes_when: asyncio.Event | None = None,
    ) -> None:
        self.info = _StreamInfo(
            {SPOKEN_TRACK_ATTRIBUTE: "TR_0001"} if spoken else {}
        )
        self._said = said
        self._closes_when = closes_when

    async def read_all(self) -> str:
        if self._closes_when is not None:
            await self._closes_when.wait()
        return self._said


class _Unread:
    """One transcription stream that never reaches its close.

    The header arrived and was stamped, so the turn knows it is owed an
    utterance; the words never come. What a reset connection or a worker
    that died mid-sentence looks like from egma's seat.
    """

    def __init__(self, unread: Exception) -> None:
        self.info = _StreamInfo({})
        self._unread = unread

    async def read_all(self) -> str:
        raise self._unread


class _StreamInfo:
    def __init__(self, attributes: dict[str, str]) -> None:
        self.attributes = attributes
        self.topic = TRANSCRIPTION_TOPIC


# -- The golden fixture ------------------------------------------------------


async def test_the_golden_chat_fixture_is_a_connection_the_plug_accepts(
    tmp_path: Path,
):
    """The fixture the contract package carries is not decoration.

    The plug the simulator would really build for it builds, and the
    pipeline assembles around it — neither of which reaches anywhere, so
    nothing here needs the customer's LiveKit to exist. And the spec
    carries no speech key at all, which the schema demands of a chat spec
    and which is the same fact as no speech running.
    """
    spec = SimulationSpec.from_document(load_fixture_spec("chat-livekit.json"))
    assert spec.modality == "chat"
    assert spec.agent_platform == "livekit"
    assert spec.connection_type == "livekit_room"
    assert spec.access_variant == "livekit_room.project_credentials"

    plug = plug_for(spec.connection_type)(
        modality=spec.modality,
        access_variant=spec.access_variant,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    assert isinstance(plug, LiveKitChat)
    assert plug.provider_reference is None, "no room exists before one is made"
    assert plug.backend.room_name.startswith(f"{ROOM_PREFIX}-")

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR
    )
    assert assembled.plug is not None
    assert assembled.conductor is None, "a chat spec builds no speech pipeline"
    assert assembled.audio is None


# -- The credential, followed everywhere it could surface --------------------


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_chat_simulation_produces_carries_the_api_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    A whole chat simulation runs with the customer's secret really in the
    process, and then everything it produced is read for it: every log
    line, both metadata channels, every turn typed into the room, the
    driver printed out, the settings printed out, and the refusal with the
    exception under it.
    """
    caplog.set_level(logging.DEBUG)
    stub = ChatStub(
        greeting="Front desk.", replies=["Noted."], agent_joins=agent_joins
    )

    produced: list[str] = []
    try:
        _conducted, turns, _assembled = await chat_walk(
            tmp_path, stub, monkeypatch, scenario="One point."
        )
        produced += [text for _speaker, text in turns]
    except PlugError as refused:
        produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced += [created.metadata for created in stub.rooms]
    produced += [dispatch.metadata for dispatch in stub.dispatches]
    produced += [typed.text for typed in stub.typed]
    produced.append(repr(stub.backends[0]))
    produced.append(repr(stub.backends[0]._settings))

    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert A_SECRET not in piece


async def test_a_platform_that_says_the_secret_back_still_leaks_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A careless platform's own words can include the key pair it was
    just given, and nothing downstream may repeat a secret because
    somebody else did first."""
    from egma_simulator.redaction import REDACTED

    stub = ChatStub(refuses_dispatch=f"auth failed for key {A_KEY} secret {A_SECRET}")

    with pytest.raises(PlugError) as refused:
        await chat_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    told = str(refused.value)
    assert A_SECRET not in told
    assert REDACTED in told


async def test_a_cancel_directive_mid_exchange_still_leaves_no_room_behind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A directive really arrives on a heartbeat answer, mid-exchange."""

    class CancelsOnceUnderWay(ConversationControls):
        def __init__(self) -> None:
            super().__init__()
            self._steps = 0

        async def guard(self, coroutine):
            self._steps += 1
            if self._steps > 1:
                self.request_cancel()
            return await super().guard(coroutine)

    stub = ChatStub(greeting="Front desk.", replies=["Noted."])
    conducted, _turns, _assembled = await chat_walk(
        tmp_path,
        stub,
        monkeypatch,
        controls=CancelsOnceUnderWay(),
        scenario="One point.",
    )

    assert conducted.status == "canceled"
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_turn_delivered_while_the_agent_is_still_typing_waits_it_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The agent's own delay before it starts is inside the turn, not
    outside it: a driver that gave up before the first word would report
    an answer without words and hand the persona a turn it never got."""
    hurry(monkeypatch)
    stub = ChatStub(
        greeting="Front desk.",
        replies=["Thursday at 2:15 is free."],
        answer_delay_seconds=A_PAUSE,
    )
    plug = chat_room(stub)
    await plug.open()

    began = asyncio.get_running_loop().time()
    answered = await plug.deliver("Anything on Thursday?")

    assert answered.text == "Thursday at 2:15 is free."
    assert asyncio.get_running_loop().time() - began >= A_PAUSE
    await plug.close()
