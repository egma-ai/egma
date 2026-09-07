"""Opt-in voice simulation with a calendar-is-full mock and test-owned dispatch
metadata.
Start fixtures/livekit-dumb-agent with the Egma SDK first. The transcript must
follow the mocked calendar branch. Simulator tool rows stay empty because
LiveKit tool evidence belongs to the agent SDK. When its log is supplied,
check that the worker received the test's dispatch metadata.

Run: uv run pytest tests/test_live_mock_tools.py -v -s
Set TEST_LIVEKIT_URL, TEST_LIVEKIT_API_KEY, TEST_LIVEKIT_API_SECRET,
TEST_LIVEKIT_AGENT_NAME, and TEST_MODEL_API_KEY. Standard variables are fallbacks.
Optional TEST_DEEPGRAM_API_KEY and TEST_CARTESIA_API_KEY select those speech
providers; otherwise use OpenAI. Missing required settings produce a skip.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import nltk
import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    direct_models,
    has_terminal,
    spans_for,
    terminal_event_for,
    turns_for,
)

from egma_simulator.media.room import ROOM_PREFIX
from egma_simulator.plugs.livekit import AGENT_JOIN_SECONDS

LIVEKIT_URL = credential("TEST_LIVEKIT_URL", "LIVEKIT_URL")
LIVEKIT_API_KEY = credential("TEST_LIVEKIT_API_KEY", "LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = credential("TEST_LIVEKIT_API_SECRET", "LIVEKIT_API_SECRET")
AGENT_NAME = credential("TEST_LIVEKIT_AGENT_NAME", "EGMA_DUMB_AGENT_NAME")
DEEPGRAM_API_KEY = credential("TEST_DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY")
CARTESIA_API_KEY = credential("TEST_CARTESIA_API_KEY", "CARTESIA_API_KEY")
MODEL_API_KEY = credential("TEST_MODEL_API_KEY", "OPENAI_API_KEY")

REQUIRED = {
    "TEST_LIVEKIT_URL": LIVEKIT_URL,
    "TEST_LIVEKIT_API_KEY": LIVEKIT_API_KEY,
    "TEST_LIVEKIT_API_SECRET": LIVEKIT_API_SECRET,
    "TEST_LIVEKIT_AGENT_NAME": AGENT_NAME,
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
            + " to conduct a real simulation whose agent has a tool answered "
            "by a mock tool, in a real room, against the running "
            "fixtures/livekit-dumb-agent worker"
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
        CARTESIA_API_KEY,
        MODEL_API_KEY,
    )
    if secret
)

# The persona's mouth and ears. Cartesia and Deepgram when the machine holds
# keys for them, else the model provider's own voice and transcription, so
# fewer vendors stand between a developer and this proof; the mock-tool seam
# under test does not care who speaks or who listens.
PERSONA_VOICE = (
    {
        "provider": "cartesia",
        "voice_id": "794f9389-aac1-45b6-b726-9d9369183238",
        "speed": 1.0,
    }
    if CARTESIA_API_KEY
    else {"provider": "openai", "voice_id": "alloy", "speed": 1.0}
)

SIMULATION = "sim-livekit-mock-tools-live-001"

# The two tools `fixtures/livekit-dumb-agent` carries. Written out here
# rather than imported, because the point of the census is that egma
# learns these from the running agent rather than from a list somebody
# kept: if the fixture is renamed and this is not, the assertion below is
# supposed to fail.
BOOKING_TOOL = "check_availability"
UNMOCKED_TOOL = "opening_hours"

# What the fixture's own implementation answers with. It must never reach
# the caller in this test — that it does not is the difference between a
# simulation that was isolated and one that quietly was not.
FIXTURE_SLOTS = ("9:40", "2:15")

ALTERNATIVE_DAY = "Thursday"
CALENDAR_IS_FULL = (
    "There is nothing free on Tuesday; the calendar is completely full. "
    f"The next opening is {ALTERNATIVE_DAY} morning."
)

SAYS_IT_IS_FULL = (
    "nothing free",
    "no available",
    "no slots",
    "no openings",
    "no availability",
    "not available",
    "fully booked",
    "full",
    "booked up",
)
"""Ways a receptionist says the day the caller asked for is gone.

A vocabulary and not a sentence: what the agent says is the agent's, and
pinning a wording would be this test grading the model rather than
reading the record. What it does pin is that *something* in this family
was said — which cannot happen by accident on a day the fixture's own
implementation calls free.
"""

OFFERS_ANOTHER = (
    ALTERNATIVE_DAY.lower(),
    "another",
    "instead",
    "different day",
    "next opening",
    "would you like",
)
"""Ways the same receptionist offers the caller something else.

This is the half the mock exists for. A backend with a full calendar can
only be waited for; a mock tool orders that branch up on demand, and this
is where a reader sees the agent take it well rather than claim a booking
it never made.
"""

# The most a call egma answers may take. Its two ends are egma's own — the
# moment the call arrived and the moment the answer went back — so what
# sits between them is reading a small JSON object and writing one, which
# is microseconds. Egma serves at once now, so this is a ceiling and not a
# window: a second is room enough for a loaded machine and still tight
# enough that a driver that held an answer back would fail here.
SERVED_AT_ONCE_MS = 1000

# What this simulation answers `check_availability` with, and the only
# place this answer exists: the calendar-is-full shape a test orders up
# when it wants that branch. It comes from the test that wrote it — see
# the module docstring — so there is nothing here to resolve.
MOCKED_ANSWER = {
    "tool_name": BOOKING_TOOL,
    "answer": {"answer": CALENDAR_IS_FULL},
}

# The test's own env, and the value the fixture worker reads back and logs.
# An ordinary customer key: what is being proved is that a *test's* object
# reaches the channel LiveKit teaches an agent to read, so a key of egma's
# own would prove the wrong thing.
DISPATCHED_WORLD = {"tenant": "maple-street", "caller_id": "+15550100"}
SERIALISED_WORLD = '{"tenant":"maple-street","caller_id":"+15550100"}'
"""The exact string egma writes onto the dispatch: compact, key order as
written, and the same form the control plane measured its size cap on."""

WORKER_LOG = os.environ.get("EGMA_DUMB_AGENT_LOG", "").strip()
"""Where the fixture worker's own output was written, when the runner says.

The far side of the dispatch runs in a process this one did not start, so
the only way to prove the bytes crossed is to read what that process
wrote. ``calendar-is-full.sh`` hands the path over; a run started by hand
has none, and is told where to look instead of being failed for it.
"""

WORLD_READ_BACK = f"dispatched tenant={DISPATCHED_WORLD['tenant']!r}"
"""The line the fixture worker logs, written out here rather than imported.

The fixture is the customer's side and this is egma's: a constant shared
between them would let both move together and prove nothing. Rename the
line in ``fixtures/livekit-dumb-agent/agent.py`` and this is supposed to
go red.
"""

# Roomier than the sibling live test's walls, and for a reason found by
# running this one: a turn is where the transcriber heard a pause, so one
# spoken reply routinely lands as three or four turns. Walls tight enough
# for a conversation counted in replies cut this one off mid-sentence —
# and the sentence being cut was the agent offering the day the mock
# named, which is the thing this test exists to read.
MAX_TURNS = 16
MAX_DURATION_SECONDS = 120

# The wall this test waits behind, added up rather than picked: a claim,
# the worker being woken and heard, the conversation up to its own
# duration limit, then the room deleted and the last report delivered.
WITHIN_SECONDS = AGENT_JOIN_SECONDS + MAX_DURATION_SECONDS + 60


def mocked_spec() -> dict:
    """One spec, as one test wrote it: a real room, a real worker, one tool
    egma answers for, and the world the worker starts in."""
    config = {"url": LIVEKIT_URL, "agentName": AGENT_NAME}
    return a_spec(
        SIMULATION,
        modality="voice",
        connection={
            "agent_platform": "livekit",
            "connection_type": "livekit_room",
            "access_variant": "livekit_room.project_credentials",
            "config": config,
            "credentials": {
                "apiKey": LIVEKIT_API_KEY,
                "apiSecret": LIVEKIT_API_SECRET,
            },
        },
        scenario=(
            "You are calling to book a dental check-up. Ask whether there "
            "is anything free on Tuesday. If they say Tuesday is full, "
            "accept whatever day they offer instead. Then ask what time "
            "the practice opens, thank them and finish."
        ),
        personality=(
            "Polite and warm; explains yourself in two or three full "
            "sentences at a time rather than clipped answers."
        ),
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
        mock_tools=[MOCKED_ANSWER],
        job_dispatch_metadata=DISPATCHED_WORLD,
        models=direct_models(
            modality="voice",
            voice=PERSONA_VOICE,
            stt_provider="deepgram" if DEEPGRAM_API_KEY else "openai",
            llm_key=MODEL_API_KEY,
            stt_key=DEEPGRAM_API_KEY or MODEL_API_KEY,
            tts_key=CARTESIA_API_KEY or MODEL_API_KEY,
        ),
    )


def deployment() -> dict[str, str]:
    """The persona itself — brain, mouth and ears.

    Nothing about reaching the room is here: a room connection carries its
    own key pair. The corpus is named because the harness hides the home
    directory NLTK would otherwise find one through.
    """
    return {
        "EGMA_SIMULATOR_VAD_PROVIDER": "silero",
        "NLTK_DATA": CORPUS_ROOT,
    }


def _worker_wrote() -> str:
    """Everything the fixture worker printed, read off disk.

    Read in a thread by the caller: this is somebody else's process's log
    and the loop is conducting a live simulation while it is opened.
    """
    return Path(WORKER_LOG).read_text(encoding="utf-8", errors="replace")


def tool_calls_in(records: list[dict]) -> list[dict]:
    """Every tool row egma wrote, which must always be none of them.

    A simulation's tool record is the agent's own POV of the conversation,
    filed under the simulation by simulation ingestion. egma serves the
    answer and writes nothing, so this list being empty is the fact the
    test asserts rather than a gap it works around.
    """
    return [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] == "tool_call"
    ]


def hand_back(spoken: list[tuple[str, str]]) -> None:
    """Print the transcript when pytest uses -s. Tool-call evidence belongs to the
    agent POV and is not printed from the simulator's reports.
    """
    print("\n--- the transcript ---")
    for speaker, text in spoken:
        print(f"{speaker:>6}: {text}")
    print(
        "\n--- the test's own world, as egma wrote it onto the dispatch ---\n"
        f"{SERIALISED_WORLD}\n"
        "(the worker logs the tenant it read back; watch its output)"
    )


@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_a_mock_tool_answers_a_real_agent_in_a_real_room(
    workbench, start_simulator
):
    await workbench.offer(mocked_spec())
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
    # likeliest place a credential reaches a log is a *refusal* — somebody
    # else's words quoted into a reason, with the credential they were
    # refusing inside them. A scan written below the status assertion
    # would never run on the simulation that went wrong.
    simulator.stop()
    for secret in SECRETS:
        assert_kept_secret(secret, records=records, simulator=simulator)

    assert terminal["status"] == "completed", terminal["reason"]
    facts = terminal["facts"]
    assert facts["provider_reference"].startswith(f"{ROOM_PREFIX}-")

    # 1. The record counts nothing about the agent's tools. What egma
    #    answered is on it as the calls egma answered; what it did not
    #    answer for ran with egma nowhere near it, and a tally would be
    #    claiming an isolation nobody can vouch for.
    assert not [name for name in facts if "coverage" in name], facts

    # 2. And egma wrote no tool row of its own. The agent called its tool
    #    and egma answered — the conversation below is the proof of that —
    #    but the record of the call belongs to the agent's own POV of this
    #    simulation, which arrives by simulation ingestion. One call, one
    #    row, and never two that can disagree.
    assert tool_calls_in(records) == [], (
        "egma authored a tool row: the seam serves the answer and writes "
        "nothing, so the tool record can only be the agent's own"
    )
    spoken = turns_for(records, SIMULATION)

    # Handed back before anything else is asserted, because this is what
    # the one command exists to show — and a run that then fails an
    # assertion about it is exactly the run where seeing it matters.
    hand_back(spoken)

    # 5. The test's own env reached the worker, read back off the far
    #    side's own output. This is the only half of the run that happens
    #    inside the customer's process, so nothing in egma's record can
    #    stand in for it: what is asserted is the line the fixture logged
    #    after doing ``json.loads(ctx.job.metadata)``.
    if WORKER_LOG:
        wrote = await asyncio.to_thread(_worker_wrote)
        assert WORLD_READ_BACK in wrote, (
            f"the worker never logged {WORLD_READ_BACK!r}: the test's job "
            "dispatch metadata did not reach ctx.job.metadata, so an agent "
            "reading its per-session context found the wrong world (or "
            f"none). Its whole log is at {WORKER_LOG}"
        )
        print(f"\n--- the world the worker read back ---\n{WORLD_READ_BACK}")
    else:
        print(
            "\n--- the world the worker read back ---\n"
            "not checked: set EGMA_DUMB_AGENT_LOG to the worker's log, or "
            f"look in it by hand for {WORLD_READ_BACK!r}. "
            "calendar-is-full.sh passes the path for you"
        )

    # 6. And the conversation reads the way the test intended it to: the
    #    agent was told the calendar was full and behaved like it.
    #
    #    Read as one string rather than turn by turn, because a turn is
    #    where the transcriber heard a pause: one reply from the agent
    #    routinely arrives as "I'm sorry." then "There is nothing free on
    #    Tuesday." then "Would you like Thursday instead?", and a search
    #    per turn would be asking a sentence to survive being cut in two.
    agent_turns = [text for speaker, text in spoken if speaker == "agent"]
    assert agent_turns, f"the agent never said anything: {spoken}"
    said = " ".join(agent_turns).lower()

    # Vocabularies rather than sentences, and this is the one place this
    # file reads *content*. It has to: "the agent handled no free slots"
    # is the claim the mock exists to make provable, and no structural
    # fact can carry it. So what is pinned is the smallest thing that
    # cannot happen by accident — a way of saying the day is full, and a
    # way of offering something else — never a wording.
    assert any(word in said for word in SAYS_IT_IS_FULL), (
        "no agent turn said the day was full, so nothing in this "
        f"conversation shows the mock's answer reaching the caller: {agent_turns}"
    )
    assert any(word in said for word in OFFERS_ANOTHER), (
        "the agent said the day was full and offered nothing else — the "
        f"branch was forced and the agent handled it badly: {agent_turns}"
    )
    for slot in FIXTURE_SLOTS:
        assert slot not in said, (
            f"the agent offered {slot}, which is the fixture's own "
            "implementation answering: this call was never mocked at all"
        )

    # Nothing the simulator sent was refused on its way in.
    assert [record for record in records if record["kind"] == "refusal"] == []
