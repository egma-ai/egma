"""One real voice exchange through real speech providers — opt-in.

Everything else in this suite speaks the scripted codec, which proves the
pipeline carries audio and nothing at all about a provider. This file is
the other half: a whole voice simulation whose persona speaks with an
ElevenLabs voice and hears with Deepgram's ears, conducted the way the
local workbench story conducts one — a real simulator process, configured
only through its environment, and every assertion read back off the
records it reported.

No telephony is involved. The counterpart is the loopback's echo test
line, so what the persona says in a real voice is what comes back for
real ears to read, and the whole round trip is provable without dialling
anybody.

Each leg is also proved on its own — ``test_live_elevenlabs.py`` and
``test_live_deepgram.py`` — so a failure there names one provider. This
one is the pair working together, which neither of those can show.

It is opt-in because CI holds no provider account. With no credentials in
the environment it skips — visibly, never failing, never waiting on
anybody::

    DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... \\
    uv run pytest tests/test_live_speech.py -v

``TEST_DEEPGRAM_API_KEY`` and ``TEST_ELEVENLABS_API_KEY`` are read first,
for a machine that keeps its test credentials apart from its working ones.
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
    words_of,
)

from egma_simulator.pipeline import AGENT_CHANNEL, PERSONA_CHANNEL, channels_of
from egma_simulator.speech import decode_speech

DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")

pytestmark = pytest.mark.skipif(
    not (DEEPGRAM_API_KEY and ELEVENLABS_API_KEY),
    reason=(
        "no live speech credentials: set TEST_DEEPGRAM_API_KEY and "
        "TEST_ELEVENLABS_API_KEY to conduct a real spoken exchange"
    ),
)

SIMULATION_ID = "sim-live-speech-001"

FIRST = "Move my Tuesday cleaning to Thursday, please."
SECOND = "And confirm the new time."
"""Two sentences, so the persona speaks twice and the exchange is a
conversation rather than one utterance. Short on purpose: a live exchange
pays a real provider by the word."""

# Short walls: this proves the path works, not that a persona can talk
# all day. Wide enough for a websocket handshake and two syntheses.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 90


async def test_a_real_voice_speaks_and_real_ears_read_it_back(
    workbench, start_simulator
):
    spec = loopback_spec(
        SIMULATION_ID,
        scenario=f"{FIRST} {SECOND}",
        personality="Polite and brief; asks one thing at a time.",
        echoes_what_it_hears=True,
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
    )
    await workbench.offer(spec)
    # The providers arrive the one way they ever do: this deployment's
    # environment. Nothing about the spec, the plug, or the persona knows
    # which pair of legs it got.
    simulator = start_simulator(
        workbench,
        # The loudest the simulator gets, for the two reasons the offline
        # sentinel tests use it: a real provider's refusal is only
        # diagnosable if it was written down, and the most likely place a
        # key would leak is the chattiest one.
        log_level="DEBUG",
        extra_env={
            "EGMA_SIMULATOR_STT_PROVIDER": "deepgram",
            "EGMA_SIMULATOR_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
            "EGMA_SIMULATOR_TTS_PROVIDER": "elevenlabs",
            "EGMA_SIMULATOR_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
        },
    )

    records = await workbench.wait_for(
        has_terminal(SIMULATION_ID), within_seconds=180
    )
    terminal = terminal_event_for(records, SIMULATION_ID)
    assert terminal["status"] == "completed", terminal["reason"]

    # The transcript's agent turns were never written down anywhere: they
    # exist only because a transcriber listened to synthesized speech and
    # wrote what it heard. Each one is the persona turn it echoed, as far
    # as a real transcriber and a real voice agree on anything.
    spoken = turns_for(records, SIMULATION_ID)
    heard_back = [text for speaker, text in spoken if speaker == "agent"]
    assert len(heard_back) >= 2, spoken
    for said, transcribed in zip((FIRST, SECOND), heard_back, strict=False):
        expected = words_of(said)
        survived = expected & words_of(transcribed)
        assert len(survived) >= len(expected) * 0.6, (
            f"the transcriber heard {transcribed!r} where the persona said "
            f"{said!r}"
        )

    audio = terminal["facts"]["audio"]
    assert audio is not None, terminal["facts"]
    recording = simulator.blob(audio["recording"])
    persona_channel, agent_channel, band = channels_of(recording)
    assert band == audio["measured_sample_rate_hz"]
    assert (PERSONA_CHANNEL, AGENT_CHANNEL) == (0, 1)

    # Both sides carry sound, and it is not the test codec: what is on
    # this recording is a synthesizer's own samples, which the scripted
    # reader cannot make words of.
    for channel in (persona_channel, agent_channel):
        assert set(channel) != {0}, "a channel of the recording is silent"
        read_as_tones = decode_speech(channel, band)
        assert FIRST not in read_as_tones, (
            "the recording decodes as the scripted codec, so the speaking "
            "leg was not the real one"
        )

    simulator.stop()

    # Both keys conducted the whole exchange and appear nowhere: not in a
    # report, not in a log line, not in the write-ahead log — and not in
    # the recording either, which is bytes this simulation wrote itself.
    for secret in (DEEPGRAM_API_KEY, ELEVENLABS_API_KEY):
        assert_kept_secret(secret, records=records, simulator=simulator)
        assert secret.encode() not in recording
