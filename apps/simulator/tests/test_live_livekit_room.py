"""One real simulation in a real LiveKit room — opt-in.

Everything else about the livekit plug is proved against a room-shaped
fake, which says the lifecycle is right and nothing at all about a real
LiveKit project, a real worker, or a real dispatch. This file is the
other half: a spec whose connection names a room goes in at the control
plane, egma makes the room in that project, a real agent worker is
dispatched into it, a real conversation happens, and the record that
comes back is read the same way the offline acceptance suite reads one.

It is opt-in because CI holds no LiveKit project and no agent worker, and
it skips — visibly, never failing, never waiting on anybody::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_DEEPGRAM_API_KEY=... TEST_ELEVENLABS_API_KEY=... \\
    uv run pytest tests/test_live_livekit_room.py -v

Each name falls back to the plain one LiveKit's own tooling reads —
``LIVEKIT_URL``, ``LIVEKIT_API_KEY``, ``LIVEKIT_API_SECRET`` — so the one
environment that starts the counterpart worker also runs this, and
nobody keeps two copies of the same project's coordinates.

The standing counterpart is ``fixtures/livekit-dumb-agent``: a
deliberately boring receptionist on one OpenAI key. Start it first and
leave it running — a room with no worker registered for it is the
``agent_never_joined`` refusal, correctly, and the wrong test.

## How much of the product this is

All of it that exists. The spec is offered at the control plane, a real
simulator process claims it, conducts it and reports it — the whole seam
the simulator speaks, end to end, over a real room. The control plane
here is the workbench, because the claim endpoints are the workbench's
until they land in the API (see
:mod:`egma_simulator.workbench.app`); a simulator cannot tell the two
apart, which is the point of a contract. The connection block below is
byte for byte what the door stores for a ``livekit`` connection, so what
this conducts against is what a registered connection would hand it.

## Both dispatch styles, one test

Which style is exercised is the environment's to say, because it is the
*worker's* to say: a worker registered without a name takes every new
room in the project (automatic dispatch), and one registered with a name
takes only rooms whose dispatch asks for it. ``TEST_LIVEKIT_AGENT_NAME``
blank is the first; set is the second. The counterpart fixture reads
``EGMA_DUMB_AGENT_NAME`` for the same choice and this falls back to it,
so one variable moves both halves and the two cannot disagree.

## What is asserted

*Structure*, not content: a live agent says different words every time,
and a model's latency is nobody's to pin. So this checks that a
conversation happened, that it ended honestly, that the band was
measured and came back wideband, that the room's own name is the
provider reference, that the recording resolves with one speaker to a
channel, and that no credential appears in a single byte the simulator
wrote.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    events_for,
    has_terminal,
    terminal_event_for,
)

from egma_simulator.media.livekit_room import ROOM_BAND_HZ
from egma_simulator.media.room import ROOM_PREFIX
from egma_simulator.pipeline import channels_of
from egma_simulator.plugs.livekit import AGENT_JOIN_SECONDS

LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "LIVEKIT_URL")
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
AGENT_NAME = credential("TEST_LIVEKIT_AGENT_NAME", "EGMA_DUMB_AGENT_NAME")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
    "TEST_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)

pytestmark = pytest.mark.skipif(
    bool(MISSING),
    reason=(
        "no live LiveKit project: set "
        + ", ".join(MISSING)
        + " to conduct a real simulation against a real agent worker in a "
        "real room"
    ),
)

SECRETS = tuple(
    secret
    for secret in (LIVEKIT_API_SECRET, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY)
    if secret
)

SIMULATION = "sim-livekit-room-live-001"

# Short walls on purpose: a live exchange pays real seconds and real model
# tokens per turn, and this proves the path works rather than that an
# agent can talk all day.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 90

# The wall this test waits behind, added up rather than picked: a claim,
# then the worker being woken and heard (bounded by the driver's own
# AGENT_JOIN_SECONDS), then the conversation up to its duration limit,
# then the room being deleted and the last report delivered.
WITHIN_SECONDS = AGENT_JOIN_SECONDS + MAX_DURATION_SECONDS + 60


def room_spec() -> dict:
    """One spec whose connection names a real room in a real project.

    Exactly the block the control plane stores for a ``livekit``
    connection — the server and, where the worker registers one, the
    agent's name in the config; the key pair in the credentials — and
    nothing this test invented for itself.
    """
    config: dict = {"url": LIVEKIT_URL}
    if AGENT_NAME:
        config["agentName"] = AGENT_NAME
    return a_spec(
        SIMULATION,
        modality="voice",
        connection={
            "type": "livekit",
            "config": config,
            "credentials": {
                "apiKey": LIVEKIT_API_KEY,
                "apiSecret": LIVEKIT_API_SECRET,
            },
        },
        scenario=(
            "You are calling about your check-up. Ask whether it can be "
            "moved to Thursday, then thank them and finish."
        ),
        personality="Polite and brief; asks one thing at a time.",
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
    )


def speech() -> dict[str, str]:
    """The persona's own voice, which a room simulation needs and the
    deployment supplies.

    Nothing about reaching the room is here: a room connection carries
    its own key pair, so unlike a phone call there is no LiveKit in this
    simulator's environment at all. What is left is the persona's two
    speech legs, which belong to the deployment whatever it is
    simulating.
    """
    return {
        "EGMA_SIMULATOR_STT_PROVIDER": "deepgram",
        "EGMA_SIMULATOR_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
        "EGMA_SIMULATOR_TTS_PROVIDER": "elevenlabs",
        "EGMA_SIMULATOR_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
    }


# The suite's own wall is 120s, which is right for a hermetic test and
# short of one live simulation's honest worst case — so this test carries
# the wall it computed above rather than inheriting one it can trip while
# behaving correctly.
@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_the_simulator_holds_a_real_conversation_in_a_real_room(
    workbench, start_simulator
):
    await workbench.offer(room_spec())
    simulator = start_simulator(workbench, extra_env=speech())

    records = await workbench.wait_for(
        has_terminal(SIMULATION), within_seconds=WITHIN_SECONDS
    )
    terminal = terminal_event_for(records, SIMULATION)

    # The scan comes first, before anything about the conversation is
    # asserted, and that ordering is the point rather than tidiness. The
    # likeliest place a LiveKit secret reaches a log is a *refusal* —
    # somebody else's words, quoted into a reason, with the credential
    # they were refusing inside them. If this simulation went wrong, that
    # is exactly the path it went wrong on, and a scan written below the
    # status assertion would never run on it.
    simulator.stop()
    for secret in SECRETS:
        assert_kept_secret(secret, records=records, simulator=simulator)

    assert terminal["status"] == "completed", terminal["reason"]

    # A real agent said real words, and the transcript alternates the way
    # a conversation does. What was said is not pinned: a live agent
    # answers differently every time, and pinning it would be pinning the
    # agent rather than egma.
    turns = events_for(records, SIMULATION, "turn")
    spoken = [(turn["speaker"], turn["text"]) for turn in turns]
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    assert human_turns, f"the persona never said anything: {spoken}"
    assert any(text.strip() for text in agent_turns), (
        "every agent turn came back empty; the room was joined but nothing "
        "in it was read"
    )

    facts = terminal["facts"]
    # Whatever happened, it is one of the deliberate endings — a room
    # nobody joined would have failed instead, naming the worker.
    assert facts["ending"] in ("persona_concluded", "agent_ended", "limit_reached")
    assert facts["turn_count"] == len(turns)

    # The room egma made is the provider reference: one room, one
    # simulation, and the one join between this record and the project's
    # own telemetry.
    reference = facts["provider_reference"]
    assert reference, "no room name came back"
    assert reference.startswith(f"{ROOM_PREFIX}-"), reference

    # The band was measured on the wire, and it is the wideband a room
    # carries where a phone call is narrowband. The recording resolves and
    # both sides of the exchange are audible in it.
    audio = facts["audio"]
    assert audio is not None, "a simulation in a room with no audio on the record"
    band = audio["measured_sample_rate_hz"]
    assert band == ROOM_BAND_HZ, (
        f"the room was carried at {band}Hz, not the {ROOM_BAND_HZ}Hz the "
        "driver assembles the pipeline at"
    )
    recording = simulator.blob(audio["recording"])
    persona_audio, agent_audio, recorded_band = channels_of(recording)
    assert recorded_band == band
    assert any(persona_audio), "the persona's channel is silent"
    assert any(agent_audio), "the agent's channel is silent"
    # The fourth place a credential could be, and the one nothing else
    # scans: the bytes this simulation wrote itself.
    for secret in SECRETS:
        assert secret.encode() not in recording, (
            "the recording carried a credential"
        )

    # Per-turn timings, measured off the real exchange, and never backwards.
    timings = events_for(records, SIMULATION, "timing")
    measures = [event["measure"] for event in timings]
    assert "time_to_first_word" in measures
    assert "agent_speech_duration" in measures
    assert all(event["milliseconds"] >= 0 for event in timings)

    # Monotonic, in both the senses a live record has to be: no
    # measurement stamped before the one reported ahead of it, and no turn
    # beginning before the turn beginning ahead of it. In a real room
    # these are read from real audio arriving in real time, so an ordering
    # that went backwards would mean the clock or the reader was wrong —
    # which is exactly the thing a latency number is trusted not to be.
    stamped = [datetime.fromisoformat(event["at"]) for event in timings]
    assert stamped == sorted(stamped), "a measurement is stamped out of order"
    began = [datetime.fromisoformat(turn["started_at"]) for turn in turns]
    assert began == sorted(began), "a turn began before the one before it"
