"""One real phone call to a real number — opt-in.

Everything else about the phone plug is proved against the scripted media
backend, which says the lifecycle is right and nothing at all about
LiveKit, a SIP trunk, or a carrier. This file is the other half: a spec
naming a number goes in at the workbench, a real phone rings, a real
agent answers, and the record that comes back is read the same way the
offline acceptance suite reads one.

It is opt-in because CI holds no LiveKit deployment, no trunk and no
phone number, and it skips — visibly, never failing, never waiting on
anybody. A whole live deployment is what it takes, because a call that
was placed but spoken in a test codec would prove nothing about a phone
line::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_SIP_TRUNK_ID=ST_... \\
    TEST_PHONE_NUMBER=+1... \\
    TEST_DEEPGRAM_API_KEY=... TEST_ELEVENLABS_API_KEY=... \\
    uv run pytest tests/test_live_phone.py -v

A trunk arrives either as ``TEST_SIP_TRUNK_ID`` — one already stored in
LiveKit — or inline as ``TEST_SIP_TRUNK_ADDRESS`` with
``TEST_SIP_TRUNK_USERNAME`` and ``TEST_SIP_TRUNK_PASSWORD``, which is the
credential auth LiveKit documents for outbound. ``TEST_SIP_TRUNK_NUMBER``
is the number the call appears to come from. Each name falls back to the
``EGMA_SIMULATOR_*`` one a deployment already sets, so a machine that can
run the simulator for real can run this without a second copy of its
configuration.

What is asserted is *structure*, not content: a live agent says different
words every time and a carrier's latency is nobody's to pin. So this
checks that a conversation happened, that it ended honestly, that the
recording resolves with both speakers audible, and that no credential
appears in a single byte the simulator wrote.
"""

from __future__ import annotations

from pathlib import Path

import nltk
import pytest
from conftest import (
    assert_kept_secret,
    credential,
    has_terminal,
    measures_for,
    milliseconds_of,
    phone_spec,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.recording import channels_of

LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "EGMA_SIMULATOR_LIVEKIT_URL")
LIVEKIT_API_KEY = credential(
    "TEST_LIVEKIT_API_KEY", "EGMA_SIMULATOR_LIVEKIT_API_KEY"
)
LIVEKIT_API_SECRET = credential(
    "TEST_LIVEKIT_API_SECRET", "EGMA_SIMULATOR_LIVEKIT_API_SECRET"
)
TRUNK_ID = credential("TEST_SIP_TRUNK_ID", "EGMA_SIMULATOR_SIP_TRUNK_ID")
TRUNK_ADDRESS = credential(
    "TEST_SIP_TRUNK_ADDRESS", "EGMA_SIMULATOR_SIP_TRUNK_ADDRESS"
)
TRUNK_NUMBER = credential(
    "TEST_SIP_TRUNK_NUMBER", "EGMA_SIMULATOR_SIP_TRUNK_NUMBER"
)
TRUNK_USERNAME = credential(
    "TEST_SIP_TRUNK_USERNAME", "EGMA_SIMULATOR_SIP_TRUNK_USERNAME"
)
TRUNK_PASSWORD = credential(
    "TEST_SIP_TRUNK_PASSWORD", "EGMA_SIMULATOR_SIP_TRUNK_PASSWORD"
)
PHONE_NUMBER = credential("TEST_PHONE_NUMBER")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")
# The persona's own brain, required rather than optional — the same reason it
# is required of the room suite. Left unset the simulator takes its scripted
# default, whose turns are one sentence each, and a live call conducted that
# way proves the carrier and the wire while saying nothing about speech.
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")
MODEL_NAME = credential("TEST_MODEL_NAME") or "gpt-4o-mini"

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_PHONE_NUMBER": PHONE_NUMBER,
    "TEST_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
    "TEST_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
    "TEST_SIP_TRUNK_ID (or TEST_SIP_TRUNK_ADDRESS)": TRUNK_ID or TRUNK_ADDRESS,
    "TEST_MODEL_API_KEY": MODEL_API_KEY,
}
MISSING = sorted(name for name, value in REQUIRED.items() if not value)


def _corpus_root() -> str:
    """Where this machine keeps the sentence-tokenizer corpus.

    Named for the child because the harness hides the home directory it
    would otherwise be found through — and a real persona brain says more
    than one sentence in a breath, which is when the speaking leg needs it.
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
            "no live phone deployment: set "
            + ", ".join(MISSING)
            + " to dial a real number through a real LiveKit and a real trunk"
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
        TRUNK_PASSWORD,
        DEEPGRAM_API_KEY,
        ELEVENLABS_API_KEY,
    )
    if secret
)

# Short walls on purpose: a live call pays real seconds and real money per
# turn, and this proves the path works rather than that an agent can talk
# all day.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 90


def deployment() -> dict[str, str]:
    """The simulator's environment for one real call.

    Every variable a live phone deployment sets, in the shape the
    simulator reads them, built from the ``TEST_*`` names so that a
    machine keeps its test credentials apart from its working ones.
    """
    env = {
        # The backend selector first, and it is not a formality: without it
        # the simulator places no calls at all and refuses this spec at
        # claim time naming the variable — which is the correct behavior
        # and the wrong test. Every other variable below is required
        # *because* of this one.
        "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
        "EGMA_SIMULATOR_LIVEKIT_URL": LIVEKIT_URL,
        "EGMA_SIMULATOR_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
        "EGMA_SIMULATOR_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
        "EGMA_SIMULATOR_STT_PROVIDER": "deepgram",
        "EGMA_SIMULATOR_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
        "EGMA_SIMULATOR_TTS_PROVIDER": "elevenlabs",
        "EGMA_SIMULATOR_ELEVENLABS_API_KEY": ELEVENLABS_API_KEY,
        "EGMA_SIMULATOR_MODEL_PROVIDER": "openai",
        "EGMA_SIMULATOR_MODEL_NAME": MODEL_NAME,
        "EGMA_SIMULATOR_MODEL_API_KEY": MODEL_API_KEY,
        "NLTK_DATA": CORPUS_ROOT,
    }
    for name, value in (
        ("EGMA_SIMULATOR_SIP_TRUNK_ID", TRUNK_ID),
        ("EGMA_SIMULATOR_SIP_TRUNK_ADDRESS", TRUNK_ADDRESS),
        ("EGMA_SIMULATOR_SIP_TRUNK_NUMBER", TRUNK_NUMBER),
        ("EGMA_SIMULATOR_SIP_TRUNK_USERNAME", TRUNK_USERNAME),
        ("EGMA_SIMULATOR_SIP_TRUNK_PASSWORD", TRUNK_PASSWORD),
    ):
        if value:
            env[name] = value
    return env


async def test_the_simulator_dials_a_real_number_and_holds_a_conversation(
    workbench, start_simulator
):
    spec = phone_spec(
        "sim-phone-live-001",
        number=PHONE_NUMBER,
        backend="livekit",
        scenario=(
            "You are calling about an appointment. Ask whether it can be "
            "moved to Thursday, then thank them and finish."
        ),
        personality="Polite and brief; asks one thing at a time.",
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, extra_env=deployment())

    records = await workbench.wait_for(
        has_terminal("sim-phone-live-001"), within_seconds=180
    )
    terminal = terminal_event_for(records, "sim-phone-live-001")

    # The scan comes first, before anything about the conversation is
    # asserted, and that ordering is the point rather than tidiness. The
    # likeliest place a trunk password or a LiveKit secret reaches a log is
    # a *refusal* — somebody else's words, quoted into a reason, with the
    # credential they were refusing inside them. If this call went wrong,
    # that is exactly the path it went wrong on, and a scan written below
    # the status assertion would never run on it.
    simulator.stop()
    for secret in SECRETS:
        assert_kept_secret(secret, records=records, simulator=simulator)

    assert terminal["status"] == "completed", terminal["reason"]

    # A real agent said real words, and the transcript alternates the way a
    # conversation does. What was said is not pinned: a live agent answers
    # differently every time, and pinning it would be pinning the agent.
    spoken = turns_for(records, "sim-phone-live-001")
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    human_turns = [text for speaker, text in spoken if speaker == "human"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    assert human_turns, f"the persona never said anything: {spoken}"
    assert any(text.strip() for text in agent_turns), (
        "every agent turn came back empty; the far end was heard but not read"
    )

    facts = terminal["facts"]
    # Whatever happened, it is one of the deliberate endings — a call that
    # never became a conversation would have failed instead.
    assert facts["ending"] in ("persona_concluded", "agent_ended", "limit_reached")
    assert facts["turn_count"] == len(spoken)

    # LiveKit's own identity for the SIP participant: the one join between
    # this record and the platform's telemetry.
    assert facts["provider_reference"], "no SIP participant identity came back"

    # The recording resolves with both speakers audible. Its WAV header
    # carries the playback rate; the report stores no second rate.
    audio = facts["audio"]
    assert audio is not None, "a phone call with no audio on the record"
    assert set(audio) == {"recording"}
    recording = simulator.blob(audio["recording"])
    persona_audio, agent_audio, recording_rate_hz = channels_of(recording)
    assert recording_rate_hz > 0
    assert any(persona_audio), "the persona's channel is silent"
    assert any(agent_audio), "the agent's channel is silent"
    # The fourth place a credential could be, and the one nothing else
    # scans: the bytes this simulation wrote itself.
    for secret in SECRETS:
        assert secret.encode() not in recording, (
            "the recording carried a credential"
        )

    # Per-turn timings, measured off the real call, and never backwards.
    measures = measures_for(records, "sim-phone-live-001")
    assert "time_to_first_word" in measures
    assert "agent_speech_duration" in measures
    timed = [
        record["span"]
        for record in spans_for(records, "sim-phone-live-001")
        if record["span"]["name"] in measures
    ]
    assert all(milliseconds_of(span) >= 0 for span in timed)

    # Monotonic, in both the senses a live record has to be: no measurement
    # taken before the one taken ahead of it, and no turn beginning before
    # the turn beginning ahead of it. On a real line these are read from
    # real audio arriving in real time, so an ordering that went backwards
    # would mean the clock or the reader was wrong — which is exactly the
    # thing a latency number is trusted not to be.
    stamped = [int(span["endTimeUnixNano"]) for span in timed]
    assert stamped == sorted(stamped), "a measurement is taken out of order"
    observed = [
        int(record["span"]["endTimeUnixNano"])
        for record in spans_for(records, "sim-phone-live-001")
        if record["span"]["name"].endswith("_turn")
    ]
    assert observed == sorted(observed), "a turn was heard out of order"
