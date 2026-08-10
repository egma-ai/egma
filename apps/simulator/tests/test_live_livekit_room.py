"""One real simulation in a real LiveKit room — opt-in.

Everything else about the livekit plug is proved against a room-shaped
fake, which says the lifecycle is right and nothing at all about a real
LiveKit project, a real worker, or a real dispatch. This file is the
other half: a spec whose connection names a room goes in at the control
plane, egma makes the room in that project, a real agent worker is
dispatched into it, a genuine spoken exchange happens, and the record
that comes back is read the same way the offline acceptance suite reads
one.

Its first execution is on the record: 2026-08-08, against a LiveKit
Cloud project and the dumb-agent fixture, three simulations conducted
green — explicit dispatch by name twice (once against a cold worker) and
automatic dispatch once, every room deleted at teardown, the measured
band 16000 Hz in all three.

It is opt-in because CI holds no LiveKit project and no agent worker, and
it skips — visibly, never failing, never waiting on anybody::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_DEEPGRAM_API_KEY=... TEST_ELEVENLABS_API_KEY=... \\
    TEST_MODEL_API_KEY=... \\
    uv run pytest tests/test_live_livekit_room.py -v

Each name falls back to the plain one LiveKit's own tooling reads —
``LIVEKIT_URL``, ``LIVEKIT_API_KEY``, ``LIVEKIT_API_SECRET``, and
``OPENAI_API_KEY`` for the persona's brain — so the one environment that
starts the counterpart worker also runs this, and nobody keeps two copies
of the same project's coordinates.

The brain is required, not optional. Conducted with the scripted default
a live run proves the room and the wire and nothing about speech, because
a scripted turn is one sentence and one sentence never asks the speaking
leg where a sentence ends. That gap is what let a missing tokenizer
corpus survive a passing live test.

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

It reads that record through both of the simulator's doors, because the
record now travels by two: the lifecycle and its terminal facts come back
as report events, while the transcript and every measurement ride the
trace as spans. The turn count is the one fact that exists on both sides,
so a live run is the only place the two doors can be caught disagreeing.
"""

from __future__ import annotations

import re
from pathlib import Path

import nltk
import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    has_terminal,
    measures_for,
    milliseconds_of,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.media.livekit_room import ROOM_BAND_HZ
from egma_simulator.media.room import ROOM_PREFIX
from egma_simulator.plugs.livekit import AGENT_JOIN_SECONDS
from egma_simulator.recording import channels_of

LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "LIVEKIT_URL")
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
AGENT_NAME = credential("TEST_LIVEKIT_AGENT_NAME", "EGMA_DUMB_AGENT_NAME")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")
# The persona's own brain, and it is required rather than optional on
# purpose. Left unset, the simulator takes its scripted default, whose
# turns are one sentence each — and a live test conducted that way proves
# the room and the wire while saying nothing about speech, which is how a
# corpus the speaking leg genuinely needed stayed missing for three days.
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")
MODEL_NAME = credential("TEST_MODEL_NAME") or "gpt-4o-mini"

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
    "TEST_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
    "TEST_MODEL_API_KEY": MODEL_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)


def _corpus_root() -> str:
    """Where this machine keeps the sentence-tokenizer corpus.

    The image ships its own and names it; a developer's machine has one
    wherever NLTK put it. Either way the child is handed exactly the copy
    found here, because the harness hides the home directory it would
    otherwise be found through.
    """
    try:
        return str(Path(str(nltk.data.find("tokenizers/punkt_tab"))).parents[1])
    except LookupError:
        return ""


CORPUS_ROOT = _corpus_root()

pytestmark = [
    pytest.mark.skipif(
        bool(MISSING),
        reason=(
            "no live LiveKit project: set "
            + ", ".join(MISSING)
            + " to conduct a real simulation against a real agent worker in a "
            "real room"
        ),
    ),
    pytest.mark.skipif(
        not CORPUS_ROOT,
        reason=(
            "no sentence-tokenizer corpus on this machine: the image ships "
            "one, and speaking a turn of two sentences needs it — "
            "python -c \"import nltk; nltk.download('punkt_tab')\""
        ),
    ),
]

SECRETS = tuple(
    secret
    for secret in (
        LIVEKIT_API_SECRET,
        DEEPGRAM_API_KEY,
        ELEVENLABS_API_KEY,
        MODEL_API_KEY,
    )
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
        # Talkative on purpose. A turn of one sentence never asks the
        # speaking leg where a sentence ends, so a curt persona would
        # conduct a whole live simulation without touching the path this
        # test exists to walk.
        personality=(
            "Polite and warm; explains yourself in two or three full "
            "sentences at a time rather than clipped answers."
        ),
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
    )


def deployment() -> dict[str, str]:
    """The persona itself — brain, mouth and ears — which the deployment
    supplies whatever it is simulating.

    Nothing about reaching the room is here: a room connection carries
    its own key pair, so unlike a phone call there is no LiveKit in this
    simulator's environment at all.

    The brain is named rather than left to its default, and that is the
    whole difference between this test and one that only proves a wire.
    A scripted persona speaks the scenario back a sentence at a time; a
    real one answers the agent, at whatever length it chooses, which is
    what a customer's agent will actually hear.

    The corpus is named too, because the harness hides the home directory
    NLTK would otherwise find one through — deliberately, so the machine's
    own cache cannot quietly stand in for what the image ships.
    """
    return {
        "EGMA_SIMULATOR_MODEL_PROVIDER": "openai",
        "EGMA_SIMULATOR_MODEL_NAME": MODEL_NAME,
        "EGMA_SIMULATOR_MODEL_API_KEY": MODEL_API_KEY,
        "EGMA_SIMULATOR_STT_PROVIDER": "deepgram",
        "EGMA_SIMULATOR_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
        "EGMA_SIMULATOR_TTS_PROVIDER": "elevenlabs",
        "EGMA_SIMULATOR_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
        "NLTK_DATA": CORPUS_ROOT,
    }


def says_more_than_one_sentence(text: str) -> bool:
    """Whether a turn holds a sentence boundary with words after it.

    That is the exact shape the speaking leg used to refuse, and the
    reason it went unnoticed: the tokenizer is only asked where a
    sentence ends when something follows the punctuation, so a turn of
    one sentence never reaches it.
    """
    return bool(re.search(r"[.!?…]\s+\S", text.strip()))


# The suite's own wall is 120s, which is right for a hermetic test and
# short of one live simulation's honest worst case — so this test carries
# the wall it computed above rather than inheriting one it can trip while
# behaving correctly.
@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_the_simulator_holds_a_real_conversation_in_a_real_room(
    workbench, start_simulator
):
    await workbench.offer(room_spec())
    simulator = start_simulator(workbench, extra_env=deployment())

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
    #
    # The transcript is read where the transcript now lives — the turn
    # spans, off the trace door — because the report door carries the
    # lifecycle alone. The speaker rides the span's own name, so there is
    # no second field free to disagree with it.
    spoken = turns_for(records, SIMULATION)
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    assert human_turns, f"the persona never said anything: {spoken}"
    assert any(text.strip() for text in agent_turns), (
        "every agent turn came back empty; the room was joined but nothing "
        "in it was read"
    )

    # The persona said two sentences in one breath and they were spoken.
    # Without this the run can pass while never asking the speaking leg
    # where a sentence ends — which is how a missing tokenizer corpus hid
    # behind a scripted persona for three days.
    assert any(says_more_than_one_sentence(text) for text in human_turns), (
        "no persona turn held more than one sentence, so this run never "
        f"exercised the speaking leg's sentence regrouping: {human_turns}"
    )

    facts = terminal["facts"]
    # Whatever happened, it is one of the deliberate endings — a room
    # nobody joined would have failed instead, naming the worker.
    assert facts["ending"] in ("persona_concluded", "agent_ended", "limit_reached")
    # The count rides the terminal transition and the turns ride the trace,
    # so these two now arrive through different doors. That they still
    # agree is a thing only a real run can say.
    assert facts["turn_count"] == len(spoken)

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

    # Per-turn timings, measured off the real exchange, and never
    # backwards. A timing span is named for the measure it takes and its
    # own duration *is* the number, so there is no separate field to read
    # and none to disagree with.
    measures = measures_for(records, SIMULATION)
    assert "time_to_first_word" in measures
    assert "agent_speech_duration" in measures
    timed = [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] in measures
    ]
    assert all(milliseconds_of(span) >= 0 for span in timed)

    # Monotonic, on the one clock a live record can be held to: the moment
    # each thing was *finished*. Read from real audio arriving in real
    # time, an ordering that went backwards would mean the clock or the
    # reader was wrong — which is the thing a latency number is trusted
    # not to be.
    #
    # Ends rather than starts, and that is the claim changing rather than
    # its spelling: a voice turn's span opens backwards from the moment the
    # turn was observed, so two turns may legally overlap. That overlap is
    # barge-in, and it is a fact about the conversation rather than a fault
    # in the record.
    stamped = [int(span["endTimeUnixNano"]) for span in timed]
    assert stamped == sorted(stamped), "a measurement is stamped out of order"
    heard = [
        int(record["span"]["endTimeUnixNano"])
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"].endswith("_turn")
    ]
    assert heard == sorted(heard), "a turn was heard out of order"

    # Nothing the simulator sent was refused on its way in. On this door
    # that also catches a malformed export — a batch naming no simulation,
    # or one nobody claimed.
    assert [record for record in records if record["kind"] == "refusal"] == []
