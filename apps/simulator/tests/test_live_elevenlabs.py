"""One real voice, proved on its own — opt-in.

The speaking leg has one job: put a human voice where the scripted tone
was. This test proves exactly that and nothing else, so a failure here
names the mouth. The ears stay scripted, and the counterpart reads its
usual script, which means the recording is the answer: one channel is a
synthesizer's own samples and the other is still the test codec, read
back word for word.

It is opt-in because CI holds no ElevenLabs account, and it skips —
visibly — on that one credential alone::

    ELEVENLABS_API_KEY=... uv run pytest tests/test_live_elevenlabs.py -v

``TEST_ELEVENLABS_API_KEY`` is read first, for a machine that keeps its
test credentials apart from its working ones.
"""

from __future__ import annotations

import pytest
from conftest import (
    assert_kept_secret,
    credential,
    has_terminal,
    loopback_spec,
    terminal_event_for,
    turns_for,
)

from egma_simulator.recording import AGENT_CHANNEL, PERSONA_CHANNEL, channels_of
from egma_simulator.speech import decode_speech

ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")

pytestmark = pytest.mark.skipif(
    not ELEVENLABS_API_KEY,
    reason=(
        "no live ElevenLabs credential: set TEST_ELEVENLABS_API_KEY to hear "
        "the persona speak for real"
    ),
)

SIMULATION_ID = "sim-live-elevenlabs-001"
SAID = "Move my Tuesday cleaning to Thursday, please."
ANSWERED = "Certainly, I can move that for you."


async def test_the_persona_speaks_with_a_real_voice(workbench, start_simulator):
    spec = loopback_spec(
        SIMULATION_ID,
        scenario=SAID,
        personality="Polite and brief.",
        replies=[ANSWERED],
        max_turns=6,
        max_duration_seconds=60,
    )
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench,
        log_level="DEBUG",
        extra_env={
            "EGMA_SIMULATOR_TTS_PROVIDER": "elevenlabs",
            "EGMA_SIMULATOR_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
        },
    )

    records = await workbench.wait_for(
        has_terminal(SIMULATION_ID), within_seconds=120
    )
    terminal = terminal_event_for(records, SIMULATION_ID)
    assert terminal["status"] == "completed", terminal["reason"]

    # The transcript is what it always was: only the mouth changed, and
    # the persona brain never learned that its words were spoken aloud.
    spoken = turns_for(records, SIMULATION_ID)
    assert (SAID in [text for speaker, text in spoken if speaker == "human"]), spoken
    assert ANSWERED in [text for speaker, text in spoken if speaker == "agent"]

    recording = simulator.blob(terminal["facts"]["audio"]["recording"])
    persona_channel, agent_channel, band = channels_of(recording)
    assert (PERSONA_CHANNEL, AGENT_CHANNEL) == (0, 1)

    # The persona's channel carries sound that the scripted reader cannot
    # make words of, because it is a voice rather than a tone; the agent's
    # channel is still the codec and reads back exactly. One leg was
    # replaced, and the recording shows which.
    assert set(persona_channel) != {0}, "the persona channel is silent"
    assert SAID not in decode_speech(persona_channel, band), (
        "the persona channel decodes as the scripted codec, so the real "
        "speaking leg was not the one that spoke"
    )
    assert ANSWERED in decode_speech(agent_channel, band)

    simulator.stop()
    assert_kept_secret(ELEVENLABS_API_KEY, records=records, simulator=simulator)
    assert ELEVENLABS_API_KEY.encode() not in recording
