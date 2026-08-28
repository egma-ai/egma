"""One real typed simulation in a real LiveKit room — opt-in.

The chat plug is proved offline against a room-shaped LiveKit, which says
the lifecycle and the turn rule are right and nothing at all about a real
project, a real worker, or a real agent that has taken the six lines. This
file is the other half: a spec whose connection names a room and says
``chat`` goes in at the control plane, egma makes the room in that
project, dispatches the fixture worker into it with ``modality: chat`` in
the dispatch metadata, types to it, reads its typed answers back, and the
record that comes back is read the way the offline acceptance suite reads
one.

It is opt-in because CI holds no LiveKit project and no agent worker, and
it skips — visibly, never failing, never waiting on anybody::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_LIVEKIT_AGENT_NAME=front-desk \\
    TEST_MODEL_API_KEY=... \\
    uv run pytest tests/test_live_livekit_chat.py -v

Each name falls back to the plain one LiveKit's own tooling reads, and
``TEST_LIVEKIT_AGENT_NAME`` falls back to ``EGMA_DUMB_AGENT_NAME`` — the
name the counterpart worker registers under — so one environment starts
the worker and runs this.

**Two things this needs that the spoken live test needs and this one does
not.** There is no speech key of either kind: the contract's schema
refuses ``models.stt.key`` and ``models.tts.key`` on a chat spec, which is
the same fact as no speech running. And there is no sentence-tokenizer
corpus, because nothing here speaks a sentence. The shorter skip list is
the product claim written as an environment.

The counterpart is ``fixtures/livekit-dumb-agent``, carrying the six lines
that read the modality egma sends. Start it first and leave it running.

## What is asserted

*Structure*, not content, as everywhere live. A conversation happened, it
ended honestly, the room's own name is the provider reference, no
credential appears in a byte the simulator wrote — and two things only a
typed run can say:

- **there is no audio on the record at all**, which is what a simulation
  that synthesised nothing looks like from the outside;
- **the turns were text-paced.** Said carefully, because the wire fact
  that distinguishes the two paths — LiveKit's transcribed-track mark — is
  read by the plug and written onto no record, so it cannot be asserted
  from here directly. What can be: the simulation did not end with the
  missing-chat-setup reason, which is the plug saying it never saw that
  mark or an audio track; and every second the agent spent answering,
  less the quiet period this plug pays on every turn by construction, adds
  up to less than speaking those same words would have taken.
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
# day. Roomier than a hermetic run's because the quiet period is paid once
# per turn and the persona's own brain answers between them.
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

    # Text-paced, on the one arithmetic a live run can be held to. Every
    # answer's own latency less the quiet period the plug pays by
    # construction is the time the agent really took, and all of it
    # together is less than speaking those same words would have cost.
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
