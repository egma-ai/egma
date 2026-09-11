"""Opt-in test that calls TEST_PHONE_NUMBER through real LiveKit SIP.
Run: uv run pytest tests/test_live_phone.py -v
Requires TEST_LIVEKIT_URL and its key pair, TEST_SIP_TRUNK_ADDRESS,
TEST_SIP_TRUNK_NUMBER, TEST_SIP_TRUNK_USERNAME, TEST_SIP_TRUNK_PASSWORD,
TEST_PHONE_NUMBER, TEST_DEEPGRAM_API_KEY, TEST_CARTESIA_API_KEY, and
TEST_MODEL_API_KEY, plus the tokenizer corpus.

The four carrier values go in the work order; TEST_SIP_TRUNK_NUMBER is caller ID.
Check transcript structure, ending, stereo recording, and credential redaction.
Missing prerequisites produce a skip.
"""

from __future__ import annotations

from pathlib import Path

import nltk
import pytest
from conftest import (
    assert_kept_secret,
    credential,
    direct_models,
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
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "EGMA_SIMULATOR_LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential(
    "TEST_LIVEKIT_API_SECRET", "EGMA_SIMULATOR_LIVEKIT_API_SECRET"
)
TRUNK_ADDRESS = credential("TEST_SIP_TRUNK_ADDRESS")
TRUNK_NUMBER = credential("TEST_SIP_TRUNK_NUMBER")
TRUNK_USERNAME = credential("TEST_SIP_TRUNK_USERNAME")
TRUNK_PASSWORD = credential("TEST_SIP_TRUNK_PASSWORD")
PHONE_NUMBER = credential("TEST_PHONE_NUMBER")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
CARTESIA_API_KEY = credential("TEST_CARTESIA_API_KEY", "CARTESIA_API_KEY")
# The persona's own brain, required rather than optional — the same reason it
# is required of the room suite. Left unset the simulator takes its scripted
# default, whose turns are one sentence each, and a live call conducted that
# way proves the carrier and the wire while saying nothing about speech.
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")
GPT_LIVE = credential("TEST_GPT_LIVE") == "1"

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_PHONE_NUMBER": PHONE_NUMBER,
    **({} if GPT_LIVE else {
        "TEST_DEEPGRAM_API_KEY": DEEPGRAM_API_KEY,
        "TEST_CARTESIA_API_KEY": CARTESIA_API_KEY,
    }),
    "TEST_SIP_TRUNK_ADDRESS": TRUNK_ADDRESS,
    "TEST_SIP_TRUNK_NUMBER": TRUNK_NUMBER,
    "TEST_SIP_TRUNK_USERNAME": TRUNK_USERNAME,
    "TEST_SIP_TRUNK_PASSWORD": TRUNK_PASSWORD,
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
        bool(MISSING) and not GPT_LIVE,
        reason=(
            "no live phone deployment: set "
            + ", ".join(MISSING)
            + " to dial a real number through a real LiveKit and a real trunk"
        ),
    ),
    pytest.mark.skipif(
        not CORPUS_ROOT and not GPT_LIVE,
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
        PHONE_NUMBER,
        TRUNK_PASSWORD,
        DEEPGRAM_API_KEY,
        CARTESIA_API_KEY,
        MODEL_API_KEY,
    )
    if secret
)

# Short walls on purpose: a live call pays real seconds and real money per
# turn, and this proves the path works rather than that an agent can talk
# all day.
MAX_TURNS = 8
MAX_DURATION_SECONDS = 90


def deployment() -> dict[str, str]:
    """The bridge environment for one real call.

    It has no carrier fields. Those ride the work order below.
    """
    return {
        # The backend selector first, and it is not a formality: without it
        # the simulator places no calls at all and refuses this spec at
        # claim time naming the variable — which is the correct behavior
        # and the wrong test. Every other variable below is required
        # *because* of this one.
        "EGMA_SIMULATOR_MEDIA_BACKEND": "livekit",
        "EGMA_SIMULATOR_LIVEKIT_URL": LIVEKIT_URL,
        "EGMA_SIMULATOR_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
        "EGMA_SIMULATOR_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
        "EGMA_SIMULATOR_VAD_PROVIDER": "silero",
        "NLTK_DATA": CORPUS_ROOT,
    }


def platform() -> dict:
    """The only carrier source: the platform block on the work order."""
    return {
        "carrier": {
            "trunk_address": TRUNK_ADDRESS,
            "trunk_number": TRUNK_NUMBER,
            "trunk_username": TRUNK_USERNAME,
            "trunk_password": TRUNK_PASSWORD,
        }
    }


async def test_the_simulator_dials_a_real_number_and_holds_a_conversation(
    workbench, start_simulator
):
    if GPT_LIVE and MISSING:
        pytest.fail("TEST_GPT_LIVE requires " + ", ".join(MISSING))
    models = (
        {
            "mode": "live",
            "llm": {
                "provider": "openai",
                "model": "gpt-4o-mini",
                "adapter": "openai_chat_completions",
                "key": MODEL_API_KEY,
            },
            "live": {
                "provider": "openai",
                "model": "gpt-live-1",
                "adapter": "openai_live",
                "voice_id": "marin",
                "key": MODEL_API_KEY,
            },
        }
        if GPT_LIVE
        else direct_models(
            modality="voice",
            voice={
                "provider": "cartesia",
                "voice_id": "794f9389-aac1-45b6-b726-9d9369183238",
                "speed": 1.0,
            },
            llm_key=MODEL_API_KEY,
            stt_key=DEEPGRAM_API_KEY,
            tts_key=CARTESIA_API_KEY,
        )
    )
    spec = phone_spec(
        "sim-phone-live-001",
        number=PHONE_NUMBER,
        backend="livekit",
        scenario=(
            "Ask which weekday the office is closed, then thank them and finish. "
            "Do not ask for, offer, or repeat a phone number or other contact "
            "detail. If asked for one, politely decline."
        ),
        personality=(
            "Polite and brief; asks one thing at a time and keeps contact "
            "details private."
        ),
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
        platform=platform(),
        models=models,
    )
    if GPT_LIVE:
        spec["contract_version"] = 7
        spec["persona"].pop("language", None)
        spec["persona"]["parameters"] = {
            "language": "en-US",
            "emotion": "neutral",
            "accent": "voice_default",
            "speech_speed": "normal",
            "tts_speed": 1,
            "speech_volume": 1,
            "interruption_level": "none",
            "execution_policy_version": 2,
        }
    await workbench.offer(spec)
    simulator = start_simulator(
        workbench,
        extra_env=deployment(),
        direct_model=True,
        direct_speech=not GPT_LIVE,
    )

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
        assert secret.encode() not in recording, "the recording carried a credential"

    # Per-turn timings, measured off the real call, and never backwards.
    measures = measures_for(records, "sim-phone-live-001")
    assert "turn_response_latency" in measures
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
