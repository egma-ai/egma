"""The livekit plug, and the room driver it stands on.

An agent that lives in a LiveKit room is reached by making a room in the
customer's own project, joining it, asking for the agent, and holding the
exchange there. What is pinned here is that whole story, against a
room-shaped LiveKit on this machine: no server, no project, no worker and
no network — see :mod:`room_stub`, which stands in for the three places
the driver reaches a LiveKit and leaves every other line of it real.

The failure paths get the same treatment, because a room where nothing
turned up is the outcome this plug has to be most honest about: it is
never the agent failing, and the record has to say so.
"""

from __future__ import annotations

import inspect
import json
import logging
from datetime import datetime
from pathlib import Path

import pytest
from conftest import A_PERSONALITY, A_SCENARIO, a_spec, assert_one_speaker_to_a_channel
from room_stub import AGENT_IDENTITY, RoomStub

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, contract_dir
from egma_simulator.media import MediaBackend, MediaBackendError, MediaSession
from egma_simulator.media.livekit_room import (
    ROOM_BAND_HZ,
    LiveKitRoomBackend,
    RoomSettings,
    dispatch_metadata,
)
from egma_simulator.media.room import ROOM_PREFIX, RoomSession
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble, channels_of
from egma_simulator.plugs import PlugError, Utterance, failed_ending, plug_for
from egma_simulator.plugs import livekit as livekit_plug
from egma_simulator.plugs.livekit import LiveKitRoom
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import decode_speech, encode_speech, silence
from egma_simulator.walk import Conducted, WalkControls, conduct

A_URL = "wss://lakeside-dental.livekit.cloud"
A_KEY = "APIlakeside0000"
A_SECRET = "SENTINEL-livekit-api-secret-7f3b0c19d2a4"
"""The customer's key pair. The secret is a sentinel because every path
below is scanned for it, on the way through and on the way out."""

A_SIMULATION = "sim-room-001"

FAILED_ENDINGS = frozenset(
    json.loads(
        (contract_dir() / "schemas" / "simulation-report.v1.schema.json").read_text(
            encoding="utf-8"
        )
    )["$defs"]["failed_facts"]["properties"]["ending"]["enum"]
)
"""The endings a failed simulation may honestly claim, read off the
contract itself rather than spelled again here — a plug that invented a
variant would be refused at the door, and this says so early."""


def livekit_spec(
    simulation_id: str = A_SIMULATION,
    *,
    url: str = A_URL,
    agent_name: str | None = None,
    metadata: object = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One voice spec whose connection names a room, and nothing else.

    Deliberately the same shape as the phone and loopback builders: a room
    simulation differs from every other voice one by its connection block
    and by nothing else.
    """
    config: dict = {"url": url}
    if agent_name is not None:
        config["agentName"] = agent_name
    if metadata is not None:
        config["metadata"] = metadata
    return a_spec(
        simulation_id,
        modality="voice",
        connection={
            "type": "livekit",
            "config": config,
            "credentials": {"apiKey": A_KEY, "apiSecret": A_SECRET},
        },
        scenario=scenario,
        personality=A_PERSONALITY,
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
    )


def room(stub: RoomStub, **config: object) -> LiveKitRoom:
    """One livekit plug against a room-shaped LiveKit."""
    return LiveKitRoom(
        modality="voice",
        config={"url": A_URL} | config,
        credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )


def said(speech) -> str:
    """What one answered turn actually carried, read out of its samples."""
    return decode_speech(speech.audio.pcm, speech.audio.sample_rate_hz)


def an_utterance(text: str) -> Utterance:
    return Utterance(pcm=encode_speech(text, ROOM_BAND_HZ), sample_rate_hz=ROOM_BAND_HZ)


async def room_walk(
    tmp_path: Path,
    stub: RoomStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    controls: WalkControls | None = None,
    **overrides: object,
) -> tuple[Conducted, list[tuple[str, str]], list[tuple[str, float, datetime]], object]:
    """One room simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — so what is exercised below the fake
    is every line the service would run.
    """
    monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", stub.driver)
    spec = SimulationSpec.from_document(livekit_spec(**overrides))
    turns: list[tuple[str, str]] = []
    measures: list[tuple[str, float, datetime]] = []

    async def on_turn(speaker: str, text: str) -> None:
        turns.append((speaker, text))

    async def on_timing(measure: str, milliseconds: float) -> None:
        measures.append((measure, milliseconds, datetime.now()))

    assembled = assemble(
        spec, blobs=FilesystemBlobStore(tmp_path), on_timing=on_timing
    )
    conducted = await conduct(
        persona=Persona(
            traits=spec.persona_traits,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        plug=assembled.plug,
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        on_turn=on_turn,
        on_timing=on_timing,
        controls=controls if controls is not None else WalkControls(),
        name="sim:room-test",
    )
    return conducted, turns, measures, assembled


def test_the_registry_knows_the_livekit_plug():
    assert plug_for("livekit") is LiveKitRoom


# -- One whole simulation ----------------------------------------------------


async def test_a_livekit_spec_conducts_a_whole_simulation_in_a_room(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Everything a voice simulation owes its record, from a spec alone.

    A spec whose connection names a room becomes a conversation, and what
    comes back is a transcript, a distinct ending, per-turn measurements
    that never run backwards, the band the audio was really carried at,
    a dual-channel recording that resolves, and the room's own name as the
    join to the platform's telemetry.
    """
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
        answer_delay_seconds=0.3,
    )
    conducted, turns, measures, assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
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

    # The room this was held in is the provider reference — one room, one
    # simulation, and the one join between egma's record and LiveKit's.
    assert conducted.provider_reference == stub.rooms[0].name
    assert conducted.provider_reference.startswith(f"{ROOM_PREFIX}-")

    # Measured, and measured per turn, in the order the turns happened:
    # the agent's quiet and speech on each of its three turns, the
    # persona's on each of its two, and the wall clock around each answer.
    a_turn = [
        "persona_speech_duration",
        "time_to_first_word",
        "agent_speech_duration",
        "turn_response_latency",
    ]
    assert [measure for measure, _, _ in measures] == [
        "time_to_first_word",
        "agent_speech_duration",
        *a_turn,
        *a_turn,
    ]
    # The agent was quiet for exactly as long as it waits before speaking,
    # on every one of its turns — measured out of the audio, so this costs
    # CI nothing and would cost a live room nine tenths of a second.
    assert [
        milliseconds
        for measure, milliseconds, _ in measures
        if measure == "time_to_first_word"
    ] == [300.0, 300.0, 300.0]
    # And nothing was stamped before the measurement reported ahead of it.
    stamped = [at for _, _, at in measures]
    assert stamped == sorted(stamped)

    # The band on the record is the one that flowed, read off the audio
    # the recorder saw rather than copied out of a config.
    audio = assembled.audio
    assert audio["measured_sample_rate_hz"] == ROOM_BAND_HZ == 16000

    # The reference is a reference: no bytes on the wire, and it resolves
    # to a recording with one speaker to a channel.
    assert "://" not in audio["recording"]
    recording = (tmp_path / audio["recording"]).read_bytes()
    assert channels_of(recording)[2] == ROOM_BAND_HZ
    assert_one_speaker_to_a_channel(
        recording, [turn for turn in turns if turn[1] != GOODBYE]
    )

    # And the room was not left behind.
    assert stub.deleted == [stub.rooms[0].name]


# -- The plug's own lifecycle, turn by turn -----------------------------------


async def test_the_plug_joins_converses_and_leaves():
    """The three steps the walk drives, against a room-shaped LiveKit."""
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    plug = room(stub, agentName="front-desk")
    assert plug.provider_reference is None, "no room exists before one is made"

    answered = await plug.open()
    assert said(answered) == "Lakeside Dental, how can I help?"
    assert answered.ended is False
    assert plug.provider_reference == stub.rooms[0].name

    first = await plug.deliver(an_utterance("I need to move my cleaning."))
    assert said(first) == "Of course — could I take your name?"
    second = await plug.deliver(an_utterance("Margaret Hale."))
    assert said(second) == "Booked for Thursday."
    await plug.close()

    # And the room's side of the same story: both persona turns really
    # went out over it, in order, and the room did not outlive them.
    heard = [
        decode_speech(pcm, ROOM_BAND_HZ) for pcm in stub.sessions[0].heard
    ]
    assert heard == ["I need to move my cleaning.", "Margaret Hale."]
    assert stub.deleted == [stub.rooms[0].name]


async def test_an_agent_that_joins_and_says_nothing_lets_the_persona_speak_first():
    """A room somebody is in but nobody is talking in is ordinary, and it
    is not a fault."""
    stub = RoomStub(replies=["Go on."])
    plug = room(stub)
    answered = await plug.open()
    assert answered.audio is None
    assert answered.ended is False
    await plug.close()


async def test_a_turn_the_agent_answers_with_nothing_is_a_turn_without_words():
    """The budget for quiet is spent in audio, so this costs CI nothing.

    Without it the turn would wait on an agent that never speaks until the
    simulation's duration limit, and the record would say "limit reached"
    about a room nobody was talking in.
    """
    stub = RoomStub(replies=["Only one thing to say."])
    plug = room(stub)
    await plug.open()
    assert said(await plug.deliver(an_utterance("First point."))) == (
        "Only one thing to say."
    )

    spent = await plug.deliver(an_utterance("Second point."))
    assert spent.audio is None
    assert spent.ended is False
    await plug.close()


async def test_the_quiet_before_the_first_word_is_handed_up_as_quiet():
    """Time-to-first-word is read out of the audio a plug returns, so the
    quiet the room really carried has to be in it — at its real length,
    and as quiet rather than as whatever else was on the line."""
    stub = RoomStub(greeting="Hello there.", answer_delay_seconds=0.4)
    plug = room(stub)
    answered = await plug.open()
    await plug.close()

    band = answered.audio.sample_rate_hz
    assert answered.audio.pcm == silence(0.4, band) + encode_speech(
        "Hello there.", band
    )


# -- Getting the agent into the room -----------------------------------------


async def test_a_named_agent_is_dispatched_by_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The explicit path: the connection names an agent, so egma asks the
    project for that agent by name."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
    )

    assert len(stub.dispatches) == 1
    dispatch = stub.dispatches[0]
    assert dispatch.agent_name == "front-desk"
    assert dispatch.room == stub.rooms[0].name


@pytest.mark.parametrize("agent_name", [None, "", "   "])
async def test_an_unnamed_agent_takes_the_automatic_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_name: str | None
):
    """The automatic path: a worker registered without a name is given
    every new room in the project, so making the room *was* the request
    and egma asks for nothing more."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    conducted, turns, _measures, _assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name=agent_name,
        scenario="One point.",
    )

    assert conducted.ending == "persona_concluded"
    assert turns[0] == ("agent", "Front desk.")
    assert stub.dispatches == [], "nothing is dispatched when nothing is named"
    assert len(stub.rooms) == 1


async def test_the_dispatch_carries_egmas_context_and_none_of_the_test(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """What an agent is told when it is asked for: which simulation this
    is and that it is a voice one — and nothing whatever about what it is
    going to be asked, because an agent that reads its script stops being
    under test."""
    scenario = "Ask to move the Tuesday cleaning to Thursday. Say you are Margaret."
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        agent_name="front-desk",
        scenario=scenario,
    )

    carried = json.loads(stub.dispatches[0].metadata)
    assert carried == {"simulationId": A_SIMULATION, "modality": "voice"}
    for word in ("Tuesday", "Thursday", "Margaret", "cleaning", A_PERSONALITY):
        assert word not in stub.dispatches[0].metadata


def test_egmas_context_is_the_same_string_wherever_it_is_built():
    """Written out once, so the sentence a worker parses cannot drift."""
    assert json.loads(dispatch_metadata("sim_01ABC")) == {
        "simulationId": "sim_01ABC",
        "modality": "voice",
    }


@pytest.mark.parametrize(
    ("configured", "carried"),
    [
        (
            {"clinic": "lakeside", "locale": "en-GB"},
            '{"clinic":"lakeside","locale":"en-GB"}',
        ),
        ('{"already":"json"}', '{"already":"json"}'),
        ([1, 2], "[1,2]"),
        (None, ""),
    ],
)
async def test_the_room_carries_the_connections_own_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    configured: object,
    carried: str,
):
    """The customer's metadata channel: theirs to write, egma's to pass
    through untouched, and it never carries anything of egma's."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, metadata=configured, scenario="One point."
    )

    assert stub.rooms[0].metadata == carried
    assert A_SIMULATION not in stub.rooms[0].metadata


# -- Every way a room fails to become a conversation -------------------------


async def test_a_worker_that_never_comes_is_never_the_agent_failing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The room opens, the dispatch goes out, and nobody arrives.

    Nothing was tested, so nothing is graded: the ending says the agent
    never joined, and the reason is worded for whoever has to go and look
    at their worker.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_joins=False)

    with pytest.raises(PlugError) as never_came:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    # What the record would carry, asked the way the service asks it: a
    # failed simulation whose ending says nothing was tested, so there is
    # nothing for a grader to judge the agent on.
    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert AGENT_NEVER_JOINED in FAILED_ENDINGS
    told = str(never_came.value)
    assert "front-desk" in told, "the name nobody registered has to be on the record"
    assert "worker" in told
    # It was asked for before it was given up on, and the room went away.
    assert len(stub.dispatches) == 1
    assert stub.deleted == [stub.rooms[0].name]


async def test_an_unnamed_worker_that_never_comes_says_where_to_look(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The automatic path fails differently and has to read differently:
    there is no name to check, so the reason names the other two things
    that could be wrong."""
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_joins=False)

    with pytest.raises(PlugError) as never_came:
        await room_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert "automatic dispatch" in str(never_came.value)


async def test_a_worker_that_joins_and_publishes_nothing_never_joined_either(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A participant with no audio is a worker that crashed on its first
    frame. Conducting against it would grade an agent that never spoke."""
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_publishes_audio=False)

    with pytest.raises(PlugError) as silent:
        await room_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(silent.value) == AGENT_NEVER_JOINED
    assert "audio" in str(silent.value)
    assert stub.deleted == [stub.rooms[0].name]


def test_the_wait_for_a_worker_is_bounded_and_shorter_than_a_simulation():
    """The budget itself, pinned where the tests above shorten it: a wait
    that outran a simulation's duration limit would put ``limit_reached``
    on a record whose real story is that nothing turned up."""
    assert 0 < livekit_plug.AGENT_JOIN_SECONDS <= 60


async def test_the_agent_leaving_mid_exchange_is_the_agent_ending_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The agent's participant leaving is the agent ending the exchange,
    and everything said up to that moment stays on the record."""
    stub = RoomStub(
        greeting="Front desk.",
        replies=["I am afraid I have to go. Goodbye."],
        hangs_up_after_replies=True,
    )
    conducted, turns, _measures, assembled = await room_walk(
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
    # A simulation cut short still leaves the audio it had.
    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(recording, turns)


async def test_a_dispatch_the_platform_refuses_is_a_fault_in_its_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A project that will not dispatch is somebody's to fix, and what it
    said is the whole diagnosis."""
    stub = RoomStub(refuses_dispatch="no worker registered as 'front-desk'")

    with pytest.raises(PlugError) as refused:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "no worker registered" in told
    assert stub.deleted == [stub.rooms[0].name]


async def test_a_room_the_platform_refuses_is_a_fault_in_its_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    stub = RoomStub(refuses_room="room name already taken")

    with pytest.raises(PlugError) as refused:
        await room_walk(tmp_path, stub, monkeypatch, scenario="One point.")

    assert failed_ending(refused.value) == ERROR
    assert "room name already taken" in str(refused.value)
    # Nothing was joined, and the room is still asked about: a delete that
    # finds nothing is cheaper than a room left running.
    assert stub.deleted


async def test_a_livekit_that_answers_nowhere_fails_without_a_credential(
    caplog: pytest.LogCaptureFixture,
):
    """The failure a wrong URL really hits, hermetically and through the
    real driver: a closed port on loopback, a real key pair in hand, and a
    refusal that names what could not be reached and no secret at all.

    Tearing down then asks the same unreachable server to delete a room it
    never made, which is the one path in this driver that logs the
    platform's words rather than raising them — so the log line it writes
    is scanned here too.
    """
    caplog.set_level(logging.INFO)
    settings = RoomSettings.from_connection(
        {"url": "http://127.0.0.1:1"},
        {"apiKey": A_KEY, "apiSecret": A_SECRET},
    )
    driver = LiveKitRoomBackend(
        settings=settings, band_hz=ROOM_BAND_HZ, simulation_id=A_SIMULATION
    )

    with pytest.raises(MediaBackendError) as refusal:
        await driver.create_session()
    await driver.teardown()

    told = str(refusal.value)
    assert "127.0.0.1:1" in told, "the reason has to name what could not be reached"
    assert failed_ending(refusal.value) == ERROR
    assert A_SECRET not in told
    assert A_SECRET not in repr(refusal.value.__cause__)

    logged = [record.getMessage() for record in caplog.records]
    assert any("was not deleted" in line for line in logged), logged
    for line in logged:
        assert A_SECRET not in line


async def test_a_platform_that_says_the_secret_back_still_leaks_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A careless platform's own words can include the key pair it was
    just given. The driver is what has to survive that: nothing downstream
    may repeat a secret because somebody else did first."""
    stub = RoomStub(
        refuses_dispatch=f"auth failed for key {A_KEY} secret {A_SECRET}"
    )

    with pytest.raises(PlugError) as refused:
        await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )

    told = str(refused.value)
    assert A_SECRET not in told
    assert REDACTED in told


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_simulation_produces_carries_the_api_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    A whole simulation runs with the customer's secret really in the
    process, and then everything it produced is read for it: every log
    line, both metadata channels, the driver printed out, the refusal and
    the exception under it, and — where there was one — every byte of the
    recording.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG)
    stub = RoomStub(
        greeting="Front desk.", replies=["Noted."], agent_joins=agent_joins
    )

    produced: list[str] = []
    try:
        _conducted, _turns, _measures, assembled = await room_walk(
            tmp_path, stub, monkeypatch, agent_name="front-desk", scenario="One point."
        )
        recording = (tmp_path / assembled.audio["recording"]).read_bytes()
        produced.append(recording.decode("latin-1"))
    except PlugError as refused:
        produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced += [created.metadata for created in stub.rooms]
    produced += [dispatch.metadata for dispatch in stub.dispatches]
    produced.append(repr(stub.backends[0]))

    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert A_SECRET not in piece


# -- The room is always cleaned up -------------------------------------------


async def test_the_room_is_deleted_however_the_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A room that outlived its simulation would go on costing the
    customer, so it is deleted on every way out: the natural end, a limit,
    a cancel directive, and a fault."""
    natural = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(tmp_path, natural, monkeypatch, scenario="One point.")
    assert natural.deleted == [natural.rooms[0].name]

    limited = RoomStub(greeting="Front desk.", replies=["One.", "Two.", "Three."])
    conducted, _turns, _measures, _assembled = await room_walk(
        tmp_path,
        limited,
        monkeypatch,
        scenario="First. Second. Third. Fourth.",
        max_turns=3,
    )
    assert conducted.ending == "limit_reached"
    assert limited.deleted == [limited.rooms[0].name]

    canceled = RoomStub(greeting="Front desk.", replies=["Noted."])
    conducted, _turns, _measures, _assembled = await room_walk(
        tmp_path,
        canceled,
        monkeypatch,
        controls=CancelsOnceUnderWay(),
        scenario="One point.",
    )
    assert conducted.status == "canceled"
    assert canceled.deleted == [canceled.rooms[0].name]

    faulted = RoomStub(refuses_dispatch="the project is over its agent quota")
    with pytest.raises(PlugError):
        await room_walk(
            tmp_path, faulted, monkeypatch, agent_name="front-desk", scenario="One."
        )
    assert faulted.deleted == [faulted.rooms[0].name]


class CancelsOnceUnderWay(WalkControls):
    """A cancel directive that lands after the exchange has opened.

    A directive really arrives on a heartbeat answer, mid-exchange; a walk
    canceled before it opened would never have made a room, and would
    prove nothing about deleting one.
    """

    def __init__(self) -> None:
        super().__init__()
        self._steps = 0

    async def guard(self, coroutine):
        self._steps += 1
        if self._steps > 1:
            self.request_cancel()
        return await super().guard(coroutine)


async def test_closing_a_simulation_that_never_opened_asks_for_nothing():
    """``close`` is called whatever happened, including before ``open`` —
    and a simulation that never made a room must not spend a call
    deleting one, because that call could only fail."""
    stub = RoomStub()
    plug = room(stub)
    await plug.close()
    await plug.close()
    assert stub.rooms == [], "nothing was ever made"
    assert stub.deleted == [], "nothing was ever there to delete"


# -- The band ----------------------------------------------------------------


def test_a_room_is_wideband_and_nothing_can_ask_it_not_to_be():
    """A band a connection could ask for would be a band declared, and
    what a record stamps has to be a band the audio really carried."""
    assert room(RoomStub()).sample_rate_hz == ROOM_BAND_HZ == 16000
    with pytest.raises(PlugError) as refusal:
        room(RoomStub(), sample_rate_hz=8000)
    assert "sample_rate_hz" in str(refusal.value)


# -- Connections the plug does not understand --------------------------------


@pytest.mark.parametrize(
    "connection",
    [
        ({}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": ""}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": 7}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": "livekit.cloud"}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": A_URL, "agentName": 7}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": A_URL, "metadata": 7}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": A_URL, "urls": A_URL}, {"apiKey": A_KEY, "apiSecret": A_SECRET}),
        ({"url": A_URL}, None),
        ({"url": A_URL}, {}),
        ({"url": A_URL}, {"apiKey": A_KEY}),
        ({"url": A_URL}, {"apiKey": A_KEY, "apiSecret": ""}),
        ({"url": A_URL}, {"apiKey": A_KEY, "apiSecret": A_SECRET, "token": "x"}),
    ],
)
def test_a_connection_the_plug_cannot_use_is_refused(connection: tuple):
    config, credentials = connection
    with pytest.raises(PlugError):
        LiveKitRoom(
            modality="voice",
            config=config,
            credentials=credentials,
            simulation_id=A_SIMULATION,
        )


def test_a_config_typo_is_named_in_the_refusal():
    with pytest.raises(PlugError) as refusal:
        room(RoomStub(), agentNmae="a typo")
    assert "agentNmae" in str(refusal.value)


def test_a_refusal_about_a_credential_never_quotes_one():
    """The refusal a blank secret gets says which field, never what was in
    it — a sentence about a secret must not carry one."""
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="voice",
            config={"url": A_URL},
            credentials={"apiKey": A_KEY, "apiSecret": "   "},
            simulation_id=A_SIMULATION,
        )
    told = str(refusal.value)
    assert "apiSecret" in told
    assert A_SECRET not in told


def test_the_plug_speaks_voice_only():
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="chat",
            config={"url": A_URL},
            credentials={"apiKey": A_KEY, "apiSecret": A_SECRET},
            simulation_id=A_SIMULATION,
        )
    assert "chat" in str(refusal.value)


def test_the_room_is_made_fresh_and_never_reused():
    """One room per simulation: a room that outlived its own would put two
    simulations on one line."""
    settings = RoomSettings.from_connection(
        {"url": A_URL}, {"apiKey": A_KEY, "apiSecret": A_SECRET}
    )
    built = [
        LiveKitRoomBackend(
            settings=settings, band_hz=ROOM_BAND_HZ, simulation_id=A_SIMULATION
        ).room_name
        for _ in range(2)
    ]
    assert all(name.startswith(f"{ROOM_PREFIX}-") for name in built)
    assert built[0] != built[1]


def test_the_settings_never_show_the_secret_when_they_are_printed():
    """A dataclass printed into a log line is the easiest way to leak
    one, so this one does not carry it."""
    settings = RoomSettings.from_connection(
        {"url": A_URL}, {"apiKey": A_KEY, "apiSecret": A_SECRET}
    )
    assert A_SECRET not in repr(settings)
    assert settings.secrets == (A_SECRET,)


# -- The driver seam ---------------------------------------------------------


def taken_by(method) -> list[tuple[str, object]]:
    return [
        (name, parameter.annotation)
        for name, parameter in inspect.signature(method).parameters.items()
    ]


def test_the_room_driver_is_behind_the_four_verb_seam():
    """The same four verbs every media driver has, in the same order and
    with the same shapes — except ``dial``, which reaches for nothing here
    because who to reach is the room's own configuration."""
    for name in ("create_session", "dial", "wait_answered", "teardown"):
        method = getattr(LiveKitRoomBackend, name, None)
        assert method is not None, f"the room driver has no {name}"
        assert inspect.iscoroutinefunction(method), name
        if name == "dial":
            assert taken_by(method) == [("self", inspect.Parameter.empty)]
            continue
        assert taken_by(method) == taken_by(getattr(MediaBackend, name)), name


def test_a_room_session_is_the_same_surface_every_driver_answers_with():
    for name in ("send", "receive"):
        assert taken_by(getattr(RoomSession, name)) == taken_by(
            getattr(MediaSession, name)
        ), name
    for name in ("sample_rate_hz", "far_end_left", "carrying_audio"):
        assert isinstance(getattr(RoomSession, name), property), name


def test_the_fake_is_the_real_driver_with_its_network_answered():
    """The claim the fake's fidelity rests on: everything CI exercises
    above the three calls it stands in for is the driver a customer's
    server will run."""
    stub = RoomStub()
    driver = stub.driver(
        settings=RoomSettings.from_connection(
            {"url": A_URL}, {"apiKey": A_KEY, "apiSecret": A_SECRET}
        ),
        band_hz=ROOM_BAND_HZ,
        simulation_id=A_SIMULATION,
    )
    assert isinstance(driver, LiveKitRoomBackend)
    overridden = {
        name
        for name in vars(type(driver))
        if not name.startswith("__") and hasattr(LiveKitRoomBackend, name)
    }
    assert overridden == {"_asked", "_joined_room", "_delete_room"}


# -- The golden fixture ------------------------------------------------------


async def test_the_golden_livekit_fixture_is_a_connection_the_plug_accepts(
    tmp_path: Path,
):
    """The fixture the contract package carries is not decoration.

    The plug the simulator would really build for it builds, and the
    pipeline assembles around it — neither of which reaches anywhere, so
    nothing here needs the customer's LiveKit to exist.
    """
    from conftest import load_fixture_spec

    spec = SimulationSpec.from_document(load_fixture_spec("voice-livekit.json"))
    assert spec.connection_type == "livekit"

    plug = plug_for(spec.connection_type)(
        modality=spec.modality,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    assert isinstance(plug, LiveKitRoom)
    assert plug.sample_rate_hz == ROOM_BAND_HZ
    assert plug.provider_reference is None, "no room exists before one is made"
    assert plug.backend.room_name.startswith(f"{ROOM_PREFIX}-")

    assembled = assemble(spec, blobs=FilesystemBlobStore(tmp_path))
    assert assembled.voice is not None
    assert assembled.audio is None, "nothing was conducted, so nothing was measured"


def test_the_agent_in_the_room_is_only_ever_the_one_under_test():
    """The identities in a room say who is whom, and the persona's is
    never the agent's."""
    from egma_simulator.media.room import PERSONA_IDENTITY

    assert PERSONA_IDENTITY != AGENT_IDENTITY
