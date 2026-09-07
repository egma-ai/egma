"""Opt-in voice simulation against a real LiveKit worker and the local workbench.
This verifies the simulator path, not the production API.

Start fixtures/livekit-dumb-agent before the test. Set TEST_LIVEKIT_AGENT_NAME
(or EGMA_DUMB_AGENT_NAME), TEST_DEEPGRAM_API_KEY, TEST_CARTESIA_API_KEY, and
TEST_MODEL_API_KEY; standard provider keys are fallbacks.
Run: uv run pytest tests/test_live_livekit_room.py -v

TEST_LIVEKIT_URL and its key pair select an existing server. Without them,
the fixture starts a dev server at ws://127.0.0.1:7880 with devkey/secret;
configure the worker for that address.

Check transcript and terminal-report agreement, room attribution, resolvable
stereo audio, and credential redaction. Use a real persona model and tokenizer
corpus so multi-sentence speech is exercised. Missing prerequisites skip.
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
    direct_models,
    has_terminal,
    measures_for,
    milliseconds_of,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.media.room import ROOM_PREFIX
from egma_simulator.plugs.livekit import AGENT_JOIN_SECONDS
from egma_simulator.recording import channels_of

AGENT_NAME = credential("TEST_LIVEKIT_AGENT_NAME", "EGMA_DUMB_AGENT_NAME")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
CARTESIA_API_KEY = credential("TEST_CARTESIA_API_KEY", "CARTESIA_API_KEY")
# The persona's own brain, and it is required rather than optional on
# purpose. Left unset, the simulator takes its scripted default, whose
# turns are one sentence each — and a live test conducted that way proves
# the room and the wire while saying nothing about speech, which is how a
# corpus the speaking leg genuinely needed stayed missing for three days.
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")

# The LiveKit coordinates are deliberately not here. A server is not an
# account: where none is named, the `live_livekit` fixture starts the one
# this repository deploys, so what stands between a developer and this test
# is the speech and model providers alone — the three that genuinely cannot
# be started on a laptop.
REQUIRED = {
    # Not a credential: the name the counterpart worker registers under.
    # Required because egma dispatches by name and only by name, so a blank
    # one is a run the simulator would refuse rather than a run to conduct.
    "TEST_LIVEKIT_AGENT_NAME": AGENT_NAME,
    "TEST_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
    "TEST_CARTESIA_API_KEY": CARTESIA_API_KEY,
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
            "not enough to conduct against a real worker: set "
            + ", ".join(MISSING)
            + ". The LiveKit itself needs no account — one is started where "
            "none is named — so what is left is the speech and model "
            "providers, and the name the worker registers under"
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

def secrets_for(live) -> tuple[str, ...]:
    """Every value that must appear in no output of this run.

    The LiveKit half is whichever server this conducted against, because a
    started server's pair is as much a credential to keep out of a log as a
    project's is — and a scan that only knew about the named one would go
    quiet on the very path a developer runs most.
    """
    return tuple(
        secret
        for secret in (
            live.api_secret,
            DEEPGRAM_API_KEY,
            CARTESIA_API_KEY,
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


def room_spec(live) -> dict:
    """One spec whose connection names a real room in a real project.

    Exactly the block the control plane stores for a ``livekit``
    connection — the server and the agent's name in the config, the key
    pair in the credentials — and nothing this test invented for itself.
    """
    config = {"url": live.url, "agentName": AGENT_NAME}
    return a_spec(
        SIMULATION,
        modality="voice",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": config,
            "credentials": {
                "apiKey": live.api_key,
                "apiSecret": live.api_secret,
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
        models=direct_models(
            modality="voice",
            voice={
                "provider": "cartesia",
                "voice_id": "794f9389-aac1-45b6-b726-9d9369183238",
                "speed": 1.0,
            },
            llm_key=MODEL_API_KEY,
            stt_key=DEEPGRAM_API_KEY,
            tts_key=CARTESIA_API_KEY,
        ),
    )


def deployment() -> dict[str, str]:
    """Configure Silero and the tokenizer corpus explicitly. The harness hides the
    normal home cache, and connection credentials arrive in the spec.
    """
    return {
        "EGMA_SIMULATOR_VAD_PROVIDER": "silero",
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
    workbench, start_simulator, live_livekit
):
    await workbench.offer(room_spec(live_livekit))
    simulator = start_simulator(
        workbench,
        extra_env=deployment(),
        direct_model=True,
        direct_speech=True,
    )

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
    for secret in secrets_for(live_livekit):
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

    # The recording resolves and both speakers are audible in it. Its WAV
    # header carries the playback rate; the report stores no second rate.
    audio = facts["audio"]
    assert audio is not None, "a simulation in a room with no audio on the record"
    assert set(audio) == {"recording"}
    recording = simulator.blob(audio["recording"])
    persona_audio, agent_audio, recording_rate_hz = channels_of(recording)
    assert recording_rate_hz > 0
    assert any(persona_audio), "the persona's channel is silent"
    assert any(agent_audio), "the agent's channel is silent"
    # The fourth place a credential could be, and the one nothing else
    # scans: the bytes this simulation wrote itself.
    for secret in secrets_for(live_livekit):
        assert secret.encode() not in recording, "the recording carried a credential"

    # Per-turn timings, measured off the real exchange, and never
    # backwards. A timing span is named for the measure it takes and its
    # own duration *is* the number, so there is no separate field to read
    # and none to disagree with.
    measures = measures_for(records, SIMULATION)
    assert "turn_response_latency" in measures
    assert "agent_speech_duration" in measures
    timed = [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] in measures
    ]
    assert all(milliseconds_of(span) >= 0 for span in timed)

    # Check completion-time ordering. Voice turn starts may overlap during interruption,
    # so start-time ordering would reject valid audio evidence.
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
