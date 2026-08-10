"""The livekit plug, and the room driver it stands on.

An agent that lives in a LiveKit room is reached by getting into that room
in the customer's own project, holding the exchange there, and being
honest about everything that can go wrong on the way. What is pinned here
is that whole story, against a room-shaped LiveKit on this machine: no
server, no project, no worker and no network — see :mod:`room_stub`, which
stands in for the places the driver reaches a LiveKit and leaves every
other line of it real.

Both shapes of the connection are here, and the second half of the file is
the second one: a connection that names a customer's own token endpoint
rather than carrying their key pair. That endpoint is not stood in for at
all — it is a real HTTP server on loopback serving the contract the public
docs publish (:mod:`token_endpoint_stub`), so what is proved about the
request egma sends and the answers it takes is proved over a socket.

The failure paths get the same treatment, because a room where nothing
turned up is the outcome this plug has to be most honest about: it is
never the agent failing, and the record has to say so — including whose
job the missing half was, which is not the same answer in both shapes.
"""

from __future__ import annotations

import inspect
import json
import logging
from pathlib import Path

import pytest
from conftest import (
    A_PERSONALITY,
    A_SCENARIO,
    a_spec,
    assert_one_speaker_to_a_channel,
    carry,
    hear,
    speech_in_the_recording,
)
from room_stub import AGENT_IDENTITY, RoomStub
from token_endpoint_stub import serving

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.conductor import LINE_SLICE_SAMPLES
from egma_simulator.contract import AGENT_NEVER_JOINED, ERROR, contract_dir
from egma_simulator.media import MediaBackend, MediaBackendError, MediaSession
from egma_simulator.media import room as room_module
from egma_simulator.media.livekit_room import (
    ROOM_BAND_HZ,
    LiveKitRoomBackend,
    RoomSettings,
    dispatch_metadata,
)
from egma_simulator.media.room import PERSONA_IDENTITY, ROOM_PREFIX, RoomSession
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.pipeline import assemble
from egma_simulator.plugs import DuplexLine, PlugError, failed_ending, plug_for
from egma_simulator.plugs import livekit as livekit_plug
from egma_simulator.plugs.livekit import LiveKitRoom
from egma_simulator.recording import channels_of
from egma_simulator.redaction import REDACTED
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import decode_speech, encode_speech, leading_silence_seconds
from egma_simulator.walk import Conducted, WalkControls

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


A_HEADER_SECRET = "SENTINEL-endpoint-bearer-8c41d7"
"""The auth header the endpoint shape sends. A sentinel for the same
reason the api secret is: whoever holds it can ask the customer's endpoint
for a token, so every path below is scanned for it."""

AN_AUTH_HEADER = f'{{"Authorization":"Bearer {A_HEADER_SECRET}"}}'


def livekit_endpoint_spec(
    simulation_id: str = A_SIMULATION,
    *,
    url: str = A_URL,
    token_endpoint: str = "https://acme.example/egma/livekit-token",
    credentials: object = None,
    scenario: str = A_SCENARIO,
    max_turns: int = 60,
    max_duration_seconds: int = 600,
) -> dict:
    """One voice spec whose connection asks an endpoint for its token.

    The same shape as the builder above and different in one key, which is
    the whole of the difference between the two ways a livekit connection
    is reached.
    """
    return a_spec(
        simulation_id,
        modality="voice",
        connection={
            "type": "livekit",
            "config": {"url": url, "tokenEndpoint": token_endpoint},
            "credentials": (
                {"headers": AN_AUTH_HEADER} if credentials is None else credentials
            ),
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


def endpoint_room(
    stub: RoomStub,
    token_endpoint: str,
    *,
    url: str = A_URL,
    credentials: object = None,
) -> LiveKitRoom:
    """One livekit plug that asks an endpoint for its way into the room."""
    return LiveKitRoom(
        modality="voice",
        config={"url": url, "tokenEndpoint": token_endpoint},
        credentials=(
            {"headers": AN_AUTH_HEADER} if credentials is None else credentials
        ),
        simulation_id=A_SIMULATION,
        driver=stub.driver,
    )


THREE_SECONDS_OF_SLICES = round(3.0 * ROOM_BAND_HZ / LINE_SLICE_SAMPLES)
"""Long enough for anything the agent has queued to have crossed the room."""


async def room_walk(
    tmp_path: Path,
    stub: RoomStub,
    monkeypatch: pytest.MonkeyPatch,
    *,
    controls: WalkControls | None = None,
    built_by=livekit_spec,
    spans: list[tuple[str, str, int, int]] | None = None,
    **overrides: object,
) -> tuple[Conducted, list[tuple[str, str]], list[tuple[str, float, int]], object]:
    """One room simulation, conducted the way the service conducts it.

    The spec goes in at the top — through the plug registry and the
    pipeline the service assembles — so what is exercised below the fake
    is every line the service would run, including the Pipecat conductor
    that drives the room. ``built_by`` is which of the two connection
    shapes the spec names; everything else is the same, which is the point.

    Each measurement comes back as its name, the milliseconds its own span
    holds, and the instant it closed — which is where a voice measure's
    number lives now that both ends are read off the audio. A test that
    wants a turn's two instants as well passes ``spans`` to be filled.
    """
    monkeypatch.setattr(livekit_plug, "LiveKitRoomBackend", stub.driver)
    spec = SimulationSpec.from_document(built_by(**overrides))
    turns: list[tuple[str, str]] = []
    measures: list[tuple[str, float, int]] = []

    async def on_utterance(speaker: str, text: str, began: int, ended: int) -> None:
        turns.append((speaker, text))
        if spans is not None:
            spans.append((speaker, text, began, ended))

    async def on_measured(measure: str, began: int, ended: int) -> None:
        measures.append((measure, (ended - began) / 1_000_000, ended))

    assembled = assemble(spec, blobs=FilesystemBlobStore(tmp_path))
    assert assembled.conductor is not None
    conducted = await assembled.conductor.conduct(
        persona=Persona(
            traits=spec.persona_traits,
            scenario_instructions=spec.scenario_instructions,
            model=ScriptedModel(spec.scenario_instructions),
        ),
        max_turns=spec.limits.max_turns,
        max_duration_seconds=spec.limits.max_duration_seconds,
        controls=controls if controls is not None else WalkControls(),
        name="sim:room-test",
        on_utterance=on_utterance,
        on_measured=on_measured,
    )
    return conducted, turns, measures, assembled


def test_the_registry_knows_the_livekit_plug():
    assert plug_for("livekit") is LiveKitRoom


def test_a_room_is_a_full_duplex_line():
    """The seam it wears is what decides which conductor it gets, so the
    verbs are the thing to pin — and a room has them now, exactly as the
    loopback counterpart does."""
    assert isinstance(room(RoomStub()), DuplexLine)


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

    # Measured, and measured per turn: the agent's quiet and speech on
    # each of its three turns, the persona's on each of its two, and the
    # answer latencies every simulation reports.
    named = [measure for measure, _, _ in measures]
    assert named.count("time_to_first_word") == 3
    assert named.count("agent_speech_duration") == 3
    assert named.count("persona_speech_duration") == 2
    assert named.count("first_response_latency") == 1
    assert named.count("turn_response_latency") == 2
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


async def test_a_room_turn_span_is_anchored_to_the_audio_timeline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The same claim the loopback and the phone make, over a room.

    A turn's span is not the moment the simulator noticed the turn: both
    of its ends are positions on the exchange's own sample timeline. So
    every stretch of speech a listener can find in the recording is one
    span, at the same distance from every other, to the sample.
    """
    stub = RoomStub(
        greeting="Front desk, hello.",
        replies=["Certainly.", "Done."],
        answer_delay_seconds=0.3,
    )
    spans: list[tuple[str, str, int, int]] = []
    _conducted, _turns, _measures, assembled = await room_walk(
        tmp_path,
        stub,
        monkeypatch,
        spans=spans,
        scenario="First point. Second point.",
    )

    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    heard = speech_in_the_recording(recording)
    # Every turn but the persona's concluding goodbye, which was never
    # spoken into the room and is honestly an instant.
    spoken = [span for span in spans if span[2] != span[3]]
    assert [speaker for speaker, _began, _ended in heard] == [
        speaker for speaker, _text, _began, _ended in spoken
    ]

    def since_the_first(positions: list[int]) -> list[int]:
        return [position - positions[0] for position in positions]

    def in_samples(instants: list[int]) -> list[int]:
        return [
            round((instant - instants[0]) * ROOM_BAND_HZ / 1_000_000_000)
            for instant in instants
        ]

    assert since_the_first([began for _speaker, began, _ended in heard]) == (
        in_samples([began for _speaker, _text, began, _ended in spoken])
    )
    assert since_the_first([ended for _speaker, _began, ended in heard]) == (
        in_samples([ended for _speaker, _text, _began, ended in spoken])
    )


# -- The plug's own lifecycle, turn by turn -----------------------------------


async def test_the_plug_joins_converses_and_leaves():
    """The three steps the conductor drives, against a room-shaped LiveKit.

    The line is driven one slice at a time, both directions at once,
    because that is the only door a voice plug has — where a turn falls is
    the conductor's reading of the audio and none of this file's business.
    """
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    plug = room(stub, agentName="front-desk")
    assert plug.provider_reference is None, "no room exists before one is made"

    await plug.open()
    assert plug.provider_reference == stub.rooms[0].name

    assert await hear(plug) == "Lakeside Dental, how can I help?"
    assert not plug.far_end_left
    assert await hear(plug, "I need to move my cleaning.") == (
        "Of course — could I take your name?"
    )
    assert await hear(plug, "Margaret Hale.") == "Booked for Thursday."
    await plug.close()

    # And the room's side of the same story: both stretches of persona
    # speech really went out over it, in order, and the room did not
    # outlive them.
    heard = [
        decode_speech(pcm, ROOM_BAND_HZ) for pcm in stub.sessions[0].heard
    ]
    assert heard == ["I need to move my cleaning.", "Margaret Hale."]
    assert stub.deleted == [stub.rooms[0].name]


async def test_an_agent_that_joins_and_says_nothing_carries_quiet():
    """A room somebody is in but nobody is talking in is ordinary, and it
    is not a fault. The line carries the quiet, which is how the conductor
    learns nobody is going to speak first."""
    stub = RoomStub(replies=["Go on."])
    plug = room(stub)
    await plug.open()
    assert await carry(plug, slices=20) == bytes(20 * LINE_SLICE_SAMPLES * 2)
    await plug.close()


async def test_a_stretch_of_speech_the_agent_answers_with_nothing_stays_quiet():
    """The budget for quiet is spent in audio, so this costs CI nothing.

    Without it a spent script would leave the line waiting on an agent
    that never speaks until the simulation's duration limit, and the
    record would say "limit reached" about a room nobody was talking in.
    """
    stub = RoomStub(replies=["Only one thing to say."])
    plug = room(stub)
    await plug.open()
    assert await hear(plug, "First point.") == "Only one thing to say."
    assert await hear(plug, "Second point.") == ""
    assert not plug.far_end_left
    await plug.close()


async def test_the_quiet_before_the_first_word_is_carried_as_quiet():
    """Time-to-first-word is read out of the audio the line carries, so
    the quiet the room really had has to be in it — at its real length,
    and as quiet rather than as whatever else was on the line."""
    stub = RoomStub(greeting="Hello there.", answer_delay_seconds=0.4)
    plug = room(stub)
    await plug.open()
    heard = await carry(plug, slices=THREE_SECONDS_OF_SLICES)
    await plug.close()

    asked_for = round(0.4 * ROOM_BAND_HZ)
    quiet = round(leading_silence_seconds(heard, ROOM_BAND_HZ) * ROOM_BAND_HZ)
    assert asked_for <= quiet < asked_for + LINE_SLICE_SAMPLES
    assert decode_speech(heard, ROOM_BAND_HZ) == "Hello there."


async def test_agent_speech_arriving_while_the_persona_speaks_is_heard():
    """The drop is gone, and this is the test that says so.

    The agent starts talking while the persona is still mid-sentence. The
    room used to wait out the persona's own audio and throw away
    everything that arrived meanwhile, so an agent talking over the
    persona vanished from the record entirely. Now both directions cross
    in the same slices.
    """
    stub = RoomStub(greeting="Talking over you now.", replies=["And on we go."])
    plug = room(stub)
    await plug.open()

    said_over = encode_speech(
        "A long sentence the persona is still in the middle of saying.",
        ROOM_BAND_HZ,
    )
    heard = await carry(plug, said_over)

    assert len(heard) == len(said_over), "the two directions left the same clock"
    assert decode_speech(heard, ROOM_BAND_HZ) == "Talking over you now."

    # Conducted on, rather than merely survived: the exchange goes to its
    # next answer with nothing lost in between.
    assert await hear(plug, "And I carried on.") == "And on we go."
    await plug.close()


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
            '{"clinic":"lakeside","locale":"en-GB"}',
            '{"clinic":"lakeside","locale":"en-GB"}',
        ),
        ('{"already":"json"}', '{"already":"json"}'),
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
    through untouched, and it never carries anything of egma's.

    The door only ever stores metadata as a JSON object in a string, so a
    string is the whole product shape: it rides byte for byte."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    await room_walk(
        tmp_path, stub, monkeypatch, metadata=configured, scenario="One point."
    )

    assert stub.rooms[0].metadata == carried
    assert A_SIMULATION not in stub.rooms[0].metadata


@pytest.mark.parametrize("configured", [{"clinic": "lakeside"}, [1, 2], 7])
def test_metadata_that_is_not_the_doors_own_string_is_refused(configured: object):
    """A spec is the door's word, and the door stores metadata as a JSON
    object in a string. Anything else never came through it, and the
    driver names the mistake rather than papering over it."""
    from egma_simulator.media.livekit_room import _configured_json

    with pytest.raises(MediaBackendError) as refused:
        _configured_json(configured)

    assert "a JSON object in a string" in str(refused.value)


# -- Every way a room fails to become a simulation ---------------------------


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
    assert assembled.conductor is not None
    assert assembled.audio is None, "nothing was conducted, so nothing was measured"


# -- The second way in: the customer mints the token -------------------------
#
# A connection that names a token endpoint keeps the secret that signs
# tokens for the customer's whole LiveKit project on the customer's side.
# egma invents a room and an identity, asks for a token scoped to exactly
# those, joins, and waits — and dispatching is the endpoint's job, because
# egma holds no power to do it.
#
# The endpoint below is not a fake in the sense the room is: it is a real
# HTTP server on loopback, and the driver really posts to it. What is
# proved here about the request and about every answer is therefore proved
# about the code, over a socket.


async def test_a_token_endpoint_spec_conducts_a_whole_simulation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The whole story, end to end, with no LiveKit and no network.

    A spec whose connection names an endpoint becomes a conversation: the
    endpoint is asked, the token comes back, egma joins with it, the agent
    somebody else dispatched turns up, and the record carries the room.
    """
    stub = RoomStub(
        greeting="Lakeside Dental, how can I help?",
        replies=["Of course — could I take your name?", "Booked for Thursday."],
    )
    with serving(token="minted.by.the.customer") as endpoint:
        conducted, turns, _measures, assembled = await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
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

    # One request, and the token it answered is what egma joined with.
    assert len(endpoint.asked) == 1
    assert stub.joined_with[0].token == "minted.by.the.customer"

    # Nothing was created and nothing was dispatched: egma has no power to
    # do either, and the room it joined is the one it asked for a token
    # into.
    assert stub.rooms == []
    assert stub.dispatches == []
    assert conducted.provider_reference == f"{ROOM_PREFIX}-{A_SIMULATION}"

    # And a recording that resolves, exactly as the other shape produces.
    recording = (tmp_path / assembled.audio["recording"]).read_bytes()
    assert_one_speaker_to_a_channel(
        recording, [turn for turn in turns if turn[1] != GOODBYE]
    )


async def test_the_endpoint_is_asked_for_the_room_and_identity_egma_will_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The request, exactly as the published contract spells it.

    Both names are egma's own invention and both carry the simulation's
    id, so the endpoint can mint a token for exactly the identity egma
    will join as and exactly the room it will join — and refuse anything
    else. The room's prefix is fixed and recognisable on purpose: it is
    what an endpoint allowlists so that nobody can ask it for a token into
    a production room.
    """
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            scenario="One point.",
        )

    asked = endpoint.asked[0]
    assert asked.body == {
        "room_name": f"{ROOM_PREFIX}-{A_SIMULATION}",
        "participant_name": f"{PERSONA_IDENTITY}-{A_SIMULATION}",
    }
    assert asked.body["room_name"].startswith(f"{ROOM_PREFIX}-")
    assert asked.header("content-type") == "application/json"

    # The identity egma joins with is the one it asked a token for, and it
    # is never the agent's.
    assert asked.body["participant_name"] != AGENT_IDENTITY


async def test_the_endpoints_auth_headers_are_sent_and_go_nowhere_else(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The credential is used for the one thing it is for."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            scenario="One point.",
        )

    assert endpoint.asked[0].header("authorization") == f"Bearer {A_HEADER_SECRET}"


async def test_an_endpoint_that_wants_no_credential_is_asked_without_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """An endpoint on a private network can be open to egma alone. The
    docs say not to leave it that way; the driver does not refuse to work
    with what it is given."""
    stub = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        conducted, _turns, _measures, _assembled = await room_walk(
            tmp_path,
            stub,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            credentials={},
            scenario="One point.",
        )

    assert conducted.ending == "persona_concluded"
    assert endpoint.asked[0].header("authorization") is None


@pytest.mark.parametrize("alias", ["token", "participantToken", "accessToken"])
async def test_a_token_under_any_of_the_three_names_is_taken(alias: str):
    """Accepting the spread is what makes the endpoints already out there
    reusable as they are, rather than each team writing a second handler
    for egma."""
    stub = RoomStub(greeting="Front desk.")
    with serving(token="under.this.name", alias=alias) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].token == "under.this.name"


async def test_the_endpoints_own_server_url_is_where_egma_joins():
    """The override: an endpoint that knows which of several LiveKit
    projects this agent lives in says so, and egma goes there."""
    stub = RoomStub(greeting="Front desk.")
    with serving(server_url="wss://elsewhere.livekit.cloud") as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].url == "wss://elsewhere.livekit.cloud"


async def test_the_connections_own_url_is_where_egma_joins_without_one():
    """And where the answer names none, the connection's url stands."""
    stub = RoomStub(greeting="Front desk.")
    with serving() as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        await plug.open()
        await plug.close()

    assert stub.joined_with[0].url == A_URL


# -- Every way an endpoint answers badly -------------------------------------


@pytest.mark.parametrize(
    ("named", "scripted", "quoted"),
    [
        (
            "a refusal",
            {"status": 401, "raw": '{"error":"that key is not ours"}'},
            "that key is not ours",
        ),
        (
            "a server that broke",
            {"status": 500, "raw": "<html><title>Internal Server Error</title>"},
            "Internal Server Error",
        ),
        (
            "something that is not JSON at all",
            {"raw": "<html><body>proxy: no upstream</body></html>"},
            "no upstream",
        ),
        (
            "JSON that is not an object",
            {"raw": '["a token would go here"]'},
            "a token would go here",
        ),
        (
            "an object with no token under any of the names it could be",
            {"body": {"jwt": "wrong-key-entirely"}},
            "wrong-key-entirely",
        ),
        (
            "a token that is there and blank",
            {"body": {"token": "   "}},
            "token",
        ),
        (
            "a serverUrl that is not a string",
            {"body": {"token": "fine.token.here", "serverUrl": 7}},
            "serverUrl",
        ),
        (
            "a serverUrl egma cannot join",
            {"body": {"token": "fine.token.here", "serverUrl": "sip:acme.example"}},
            "serverUrl",
        ),
    ],
)
async def test_an_endpoint_that_answers_badly_is_a_fault_in_its_own_words(
    named: str, scripted: dict, quoted: str
):
    """An endpoint outside the contract is somebody's own handler to fix,
    so what it really said is quoted back — the fix is a line in their
    code, and they need to see what came out of it."""
    stub = RoomStub()
    with serving(**scripted) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.open()
        await plug.close()
        served = endpoint.url

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert served in told, "the reason has to name what was asked"
    assert quoted in told, f"{named}: its own words are the diagnosis"
    assert A_HEADER_SECRET not in told


async def test_a_token_the_endpoint_minted_is_never_quoted_back():
    """The leak that lives between a good token and a bad answer.

    An endpoint may hand over a working token and still say something
    egma cannot use — here a ``serverUrl`` that is not a string. The
    refusal quotes the whole answer back, because that is what makes a
    handler's own mistake fixable, and the whole answer contains the
    token. A token registered only after that quoting would reach a
    reason, a log line and the traceback under it, and it opens a room in
    the customer's project.
    """
    minted = "a.working.token.nobody.should.read"
    stub = RoomStub()
    with serving(body={"token": minted, "serverUrl": 17}) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.open()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "serverUrl" in told, "the handler still has to see what to fix"
    assert minted not in told, "the endpoint's token was quoted back"
    assert A_HEADER_SECRET not in told


@pytest.mark.parametrize(
    ("named", "status"),
    [("a server error", 500), ("a refusal", 403), ("a redirect", 302)],
)
async def test_a_token_in_a_failing_answer_is_never_quoted_back(
    named: str, status: int
):
    """An endpoint can fail and still have minted a working credential.

    A 500 whose body carries a token, a 403 that echoes one back, a
    redirect that answers with one — all three are quoted from a branch
    that runs long before anything reads a token out of the body. The
    token is protected where the quoting happens rather than where the
    reading does, so a path that fails early is covered by the same door
    as one that fails late.
    """
    minted = "a.token.the.failure.still.carried"
    stub = RoomStub()
    with serving(status=status, body={"token": minted}) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.open()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert str(status) in told, f"{named}: the status is the diagnosis"
    assert minted not in told, f"{named}: a minted token was quoted back"
    assert A_HEADER_SECRET not in told


async def test_an_endpoint_that_redirects_is_answered_rather_than_followed():
    """A redirect is an answer, not an instruction.

    Following one would carry the customer's own auth headers to a host
    they never configured, chosen by whoever answered — so egma reads the
    status and stops, and says so in the same words it uses for any other
    status it cannot work with.
    """
    stub = RoomStub()
    with serving(
        status=302, body={"token": "never.minted.here"}
    ) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.open()
        await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "302" in told, "the status it stopped on is the diagnosis"
    assert A_HEADER_SECRET not in told


async def test_an_endpoint_that_answers_nowhere_is_a_fault_naming_it():
    """A closed port on loopback: the failure a wrong address really hits,
    hermetically and through the real driver."""
    stub = RoomStub()
    plug = endpoint_room(stub, "http://127.0.0.1:1/egma/livekit-token")

    with pytest.raises(PlugError) as refused:
        await plug.open()
    await plug.close()

    told = str(refused.value)
    assert failed_ending(refused.value) == ERROR
    assert "127.0.0.1:1" in told
    assert "could not be reached" in told
    assert A_HEADER_SECRET not in told


async def test_a_token_the_server_rejects_is_a_fault_in_the_servers_words(
    monkeypatch: pytest.MonkeyPatch,
):
    """The endpoint answered, and the server would not take what it minted.

    The real driver the whole way: a real endpoint mints a token, and the
    real transport takes it to a LiveKit that is not there. Nothing is
    stubbed here at all, which is what makes the sentence the one a
    customer would read.
    """
    # Only the tidying-up budget is shortened, and only because nothing
    # here is under test after the refusal. The wait for the server is
    # left as it ships: a closed port refuses at once, so the real budget
    # costs this test nothing and shortening it would prove less.
    monkeypatch.setattr(room_module, "TEARDOWN_SECONDS", 1.0)

    with serving(token="a.token.the.server.will.not.take") as endpoint:
        settings = RoomSettings.from_connection(
            {"url": "ws://127.0.0.1:1", "tokenEndpoint": endpoint.url},
            {"headers": AN_AUTH_HEADER},
        )
        room_driver = LiveKitRoomBackend(
            settings=settings, band_hz=ROOM_BAND_HZ, simulation_id=A_SIMULATION
        )

        with pytest.raises(MediaBackendError) as refusal:
            await room_driver.create_session()
        await room_driver.teardown()

    told = str(refusal.value)
    assert failed_ending(refusal.value) == ERROR
    assert "127.0.0.1:1" in told, "the reason names the server that said no"
    assert A_HEADER_SECRET not in told
    assert A_HEADER_SECRET not in repr(refusal.value.__cause__)


async def test_the_agent_nobody_dispatched_is_the_endpoints_duty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The room opened, the token was minted, and nobody came.

    Nothing was tested, so nothing is graded — and the reason says whose
    job the missing half was, because on this shape it was never egma's.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    stub = RoomStub(agent_joins=False)

    with serving() as endpoint:
        with pytest.raises(PlugError) as never_came:
            await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )

    assert failed_ending(never_came.value) == AGENT_NEVER_JOINED
    assert AGENT_NEVER_JOINED in FAILED_ENDINGS
    told = str(never_came.value)
    assert "token endpoint minted a token" in told
    assert "nothing dispatched the agent" in told
    assert "the endpoint's own job" in told
    # And never the advice from the other shape, which nobody here can act
    # on: there is no key pair to dispatch with.
    assert "automatic dispatch" not in told


# -- A room egma cannot delete is left, not deleted --------------------------


async def test_a_room_egma_cannot_delete_is_left_however_the_simulation_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A token minted to join one room carries no power to delete it.

    So egma leaves and the room stands empty for a moment, and the
    customer's own empty timeout on ``egma-sim-`` rooms closes it. Trying
    the delete anyway would spend a request to be refused and write a log
    line about a failure that was never one — on every path out, which is
    what this walks.
    """
    for named, overrides, expected in [
        ("a natural end", {}, "persona_concluded"),
        ("a limit", {"max_turns": 3}, "limit_reached"),
    ]:
        stub = RoomStub(greeting="Front desk.", replies=["One.", "Two.", "Three."])
        with serving() as endpoint:
            conducted, _turns, _measures, _assembled = await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="First. Second. Third.",
                **overrides,
            )
        assert conducted.ending == expected, named
        assert stub.deleted == [], named

    canceled = RoomStub(greeting="Front desk.", replies=["Noted."])
    with serving() as endpoint:
        conducted, _turns, _measures, _assembled = await room_walk(
            tmp_path,
            canceled,
            monkeypatch,
            built_by=livekit_endpoint_spec,
            token_endpoint=endpoint.url,
            controls=CancelsOnceUnderWay(),
            scenario="One point.",
        )
    assert conducted.status == "canceled"
    assert canceled.deleted == []

    # And the fault path, where the endpoint itself said no: nothing was
    # ever joined, so there is nothing to leave and nothing to delete.
    faulted = RoomStub()
    with serving(status=503, raw="upstream is down") as endpoint:
        with pytest.raises(PlugError):
            await room_walk(
                tmp_path,
                faulted,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )
    assert faulted.deleted == []


# -- The endpoint's credential, followed everywhere it could surface ---------


@pytest.mark.parametrize("agent_joins", [True, False])
async def test_nothing_a_token_endpoint_simulation_produces_carries_the_header(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    agent_joins: bool,
):
    """The sentinel scan, on the path that works and the path that does not.

    An ``Authorization: Bearer …`` header is a reusable credential:
    whoever holds it can ask the customer's endpoint for a token. So a
    whole simulation runs with it really in the process, and then
    everything it produced is read for it — every log line, the settings
    and the driver printed out, the refusal and the exception under it,
    and, where there was one, every byte of the recording.
    """
    monkeypatch.setattr(livekit_plug, "AGENT_JOIN_SECONDS", 0.05)
    caplog.set_level(logging.DEBUG)
    stub = RoomStub(
        greeting="Front desk.", replies=["Noted."], agent_joins=agent_joins
    )

    produced: list[str] = []
    with serving() as endpoint:
        try:
            _conducted, _turns, _measures, assembled = await room_walk(
                tmp_path,
                stub,
                monkeypatch,
                built_by=livekit_endpoint_spec,
                token_endpoint=endpoint.url,
                scenario="One point.",
            )
            recording = (tmp_path / assembled.audio["recording"]).read_bytes()
            produced.append(recording.decode("latin-1"))
        except PlugError as refused:
            produced += [str(refused), repr(refused.__cause__)]

    produced += [record.getMessage() for record in caplog.records]
    produced.append(repr(stub.backends[0]))
    produced.append(repr(stub.backends[0]._settings))

    assert any(produced), "there was nothing to scan, which always passes"
    for piece in produced:
        assert A_HEADER_SECRET not in piece


async def test_an_endpoint_that_says_the_header_back_still_leaks_nothing():
    """A careless endpoint can echo the header it was just sent straight
    into its own error body. The driver is what has to survive that."""
    stub = RoomStub()
    with serving(
        status=403, raw=f"forbidden for Bearer {A_HEADER_SECRET}"
    ) as endpoint:
        plug = endpoint_room(stub, endpoint.url)
        with pytest.raises(PlugError) as refused:
            await plug.open()
        await plug.close()

    told = str(refused.value)
    assert A_HEADER_SECRET not in told
    assert REDACTED in told


def test_the_settings_never_show_the_endpoints_headers_when_printed():
    """A dataclass printed into a log line is the easiest way to leak a
    credential, so this one does not carry one either."""
    settings = RoomSettings.from_connection(
        {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
        {"headers": AN_AUTH_HEADER},
    )
    assert A_HEADER_SECRET not in repr(settings)
    # The whole header value, not the part after the scheme: that is how
    # it goes on the wire and how an endpoint would echo it back.
    assert settings.secrets == (f"Bearer {A_HEADER_SECRET}",)


# -- Connections of the second shape that the plug cannot use ----------------


@pytest.mark.parametrize(
    "connection",
    [
        # An endpoint egma cannot post to: the two url keys the wrong way
        # round, which is the mistake this shape invites.
        ({"url": A_URL, "tokenEndpoint": "wss://acme.livekit.cloud"}, None),
        ({"url": A_URL, "tokenEndpoint": "acme.example/token"}, None),
        ({"url": A_URL, "tokenEndpoint": "   "}, None),
        # No server to join, whatever the endpoint mints.
        ({"tokenEndpoint": "https://acme.example/token"}, None),
        # Powers this shape does not have, refused rather than ignored.
        (
            {
                "url": A_URL,
                "tokenEndpoint": "https://acme.example/token",
                "agentName": "front-desk",
            },
            None,
        ),
        (
            {
                "url": A_URL,
                "tokenEndpoint": "https://acme.example/token",
                "metadata": '{"tenant":"acme"}',
            },
            None,
        ),
        # A key pair has no place on it, and headers that egma cannot send
        # are a connection nobody can use.
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"apiKey": A_KEY, "apiSecret": A_SECRET},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": "Authorization: Bearer x"},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": '{"Authorization":""}'},
        ),
        (
            {"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            {"headers": "{}"},
        ),
    ],
)
def test_a_token_endpoint_connection_the_plug_cannot_use_is_refused(
    connection: tuple,
):
    config, credentials = connection
    with pytest.raises(PlugError):
        LiveKitRoom(
            modality="voice",
            config=config,
            credentials=credentials,
            simulation_id=A_SIMULATION,
        )


def test_a_refusal_about_the_endpoints_headers_never_quotes_one():
    with pytest.raises(PlugError) as refusal:
        LiveKitRoom(
            modality="voice",
            config={"url": A_URL, "tokenEndpoint": "https://acme.example/token"},
            credentials={"headers": f"Bearer {A_HEADER_SECRET}"},
            simulation_id=A_SIMULATION,
        )
    told = str(refusal.value)
    assert "headers" in told
    assert A_HEADER_SECRET not in told


async def test_the_golden_token_endpoint_fixture_is_a_connection_the_plug_accepts(
    tmp_path: Path,
):
    """The second shape's fixture in the contract package, built for real."""
    from conftest import load_fixture_spec

    spec = SimulationSpec.from_document(
        load_fixture_spec("voice-livekit-token-endpoint.json")
    )
    assert spec.connection_type == "livekit"

    plug = plug_for(spec.connection_type)(
        modality=spec.modality,
        config=spec.connection_config,
        credentials=spec.credentials,
        simulation_id=spec.simulation_id,
    )
    assert isinstance(plug, LiveKitRoom)
    assert plug.sample_rate_hz == ROOM_BAND_HZ
    # Named after the simulation, because the endpoint being asked has to
    # be able to check the name against its own rules.
    assert plug.backend.room_name == f"{ROOM_PREFIX}-{spec.simulation_id}"

    assembled = assemble(spec, blobs=FilesystemBlobStore(tmp_path))
    assert assembled.conductor is not None
