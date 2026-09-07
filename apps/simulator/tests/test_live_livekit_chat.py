"""Opt-in chat simulation against the LiveKit fixture worker and local workbench.
Start fixtures/livekit-dumb-agent with chat setup before running this test.

Run: uv run pytest tests/test_live_livekit_chat.py -v
Set TEST_LIVEKIT_URL, TEST_LIVEKIT_API_KEY, TEST_LIVEKIT_API_SECRET,
TEST_LIVEKIT_AGENT_NAME, and TEST_MODEL_API_KEY. Standard LiveKit variables,
EGMA_DUMB_AGENT_NAME, and OPENAI_API_KEY are fallbacks. No STT or TTS key is needed.

Check completed transcript structure, room attribution, no recording, credential
redaction, and a loose text-pacing bound. Missing settings produce a skip.
"""

from __future__ import annotations

import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    direct_models,
    has_terminal,
    milliseconds_of,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.media.room import ROOM_PREFIX
from egma_simulator.plugs.livekit_chat import (
    AGENT_JOIN_SECONDS,
    TURN_QUIET_SECONDS,
)

LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "LIVEKIT_URL")
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
AGENT_NAME = credential("TEST_LIVEKIT_AGENT_NAME", "EGMA_DUMB_AGENT_NAME")
# The persona's brain, and the only model this run needs at all: it has no
# ears and no mouth, which is the whole point of it.
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_LIVEKIT_AGENT_NAME": AGENT_NAME,
    "TEST_MODEL_API_KEY": MODEL_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)

pytestmark = [
    pytest.mark.skipif(
        bool(MISSING),
        reason=(
            "no live LiveKit project: set "
            + ", ".join(MISSING)
            + " to conduct a real typed simulation against a real agent "
            "worker in a real room"
        ),
    )
]

SECRETS = tuple(
    secret for secret in (LIVEKIT_API_SECRET, MODEL_API_KEY) if secret
)

SIMULATION = "sim-livekit-chat-live-001"

# Short walls on purpose: a live exchange pays real model tokens per turn,
# and this proves the path works rather than that an agent can type all
# day. Roomier than a hermetic run's because the persona's own brain
# answers between the turns, and because a turn the agent does not end
# itself still waits out the quiet period.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 90

WITHIN_SECONDS = AGENT_JOIN_SECONDS + MAX_DURATION_SECONDS + 60

SPEECH_WORDS_PER_SECOND = 2.9
"""How fast a synthesised reply arrives, measured rather than guessed.

From the live run this lane's research recorded: an unmodified agent's
transcription is tied to its own speech playback, and the text arrives at
about this rate. It is the line between the two paths, so an answer that
arrived faster than its words could have been spoken is an answer nobody
spoke.
"""


def chat_spec() -> dict:
    """One spec whose connection names a real room, and says ``chat``.

    Exactly the block the control plane stores for a ``livekit``
    connection — the server and the agent's name in the config, the key
    pair in the credentials. The only thing that makes this a typed
    simulation rather than a spoken one is the modality, which is the
    claim the whole lane rests on.
    """
    return a_spec(
        SIMULATION,
        modality="chat",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": {"url": LIVEKIT_URL, "agentName": AGENT_NAME},
            "credentials": {
                "apiKey": LIVEKIT_API_KEY,
                "apiSecret": LIVEKIT_API_SECRET,
            },
        },
        scenario=(
            "You are asking about your check-up. Ask whether it can be "
            "moved to Thursday, then thank them and finish."
        ),
        personality=(
            "Polite and warm; explains yourself in two or three full "
            "sentences at a time rather than clipped answers."
        ),
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
        # No speech key of either kind, which the contract's schema demands
        # of a chat spec and which is the same fact as no speech running.
        models=direct_models(modality="chat", llm_key=MODEL_API_KEY),
    )


def deployment() -> dict[str, str]:
    """What the deployment supplies for a typed simulation: nothing.

    A room connection carries its own key pair, and a chat run has no
    speech legs and no voice activity detector to configure — so unlike
    every other live suite here there is nothing to hand the child but the
    workbench it already knows about.
    """
    return {}


# The suite's own wall is 120s, which is right for a hermetic test and
# short of one live simulation's honest worst case.
@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_the_simulator_types_a_whole_simulation_in_a_real_room(
    workbench, start_simulator
):
    await workbench.offer(chat_spec())
    simulator = start_simulator(
        workbench, extra_env=deployment(), direct_model=True
    )

    records = await workbench.wait_for(
        has_terminal(SIMULATION), within_seconds=WITHIN_SECONDS
    )
    terminal = terminal_event_for(records, SIMULATION)

    # The scan comes first, before anything about the exchange is
    # asserted, and that ordering is the point rather than tidiness: the
    # likeliest place a LiveKit secret reaches a log is a refusal, which
    # is exactly the path a run that went wrong went wrong on.
    simulator.stop()
    for secret in SECRETS:
        assert_kept_secret(secret, records=records, simulator=simulator)

    assert terminal["status"] == "completed", terminal["reason"]
    # The failure this lane exists to catch, named rather than implied: an
    # agent that had not taken the six lines would have been stopped at its
    # first output with this reason on the record.
    assert "chat setup" not in (terminal.get("reason") or "")

    spoken = turns_for(records, SIMULATION)
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never typed anything: {spoken}"
    assert human_turns, f"the persona never typed anything: {spoken}"

    facts = terminal["facts"]
    assert facts["ending"] in ("persona_concluded", "agent_ended", "limit_reached")
    assert facts["turn_count"] == len(spoken)

    # Nothing was synthesised, so there is nothing to store and nothing to
    # play back. This is the product claim as the record carries it.
    assert facts["audio"] is None, "a typed simulation put audio on the record"

    reference = facts["provider_reference"]
    assert reference, "no room name came back"
    assert reference.startswith(f"{ROOM_PREFIX}-"), reference

    # Compare a conservative latency estimate with estimated speaking time.
    # The subtraction below makes this a loose pacing check; it does not measure
    # transport overhead, which answer-start timestamps already exclude.
    answering = [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] in ("first_response_latency", "turn_response_latency")
    ]
    assert answering, "no answer was measured"
    thinking = sum(
        max(milliseconds_of(span) / 1000 - TURN_QUIET_SECONDS, 0.0)
        for span in answering
    )
    words = sum(len(text.split()) for text in agent_turns)
    assert words, "the agent typed no words to compare against"
    assert thinking < words / SPEECH_WORDS_PER_SECOND, (
        f"the agent took {thinking:.1f}s to produce {words} words, which is "
        "speech pace — this run was not text-paced"
    )
