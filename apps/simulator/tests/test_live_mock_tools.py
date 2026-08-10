"""The calendar is full, on a real voice call — opt-in.

The seam is proved offline against a room-shaped fake, which says the
exchange is right and nothing at all about whether a real agent's tool
call really reaches egma across a real room. This file is the other half,
and it is the effort's founder demo: a spec carrying one mocked tool goes
in at the control plane, egma makes a room in a real LiveKit project, the
dumb-agent worker is dispatched into it with the egma SDK wired in, a
persona asks about Tuesday out loud — and the agent is told, by egma, that
Tuesday is full.

Nothing about that answer exists anywhere but in this file. There is no
calendar behind the fixture and no calendar behind egma; the branch the
agent takes is a branch a test ordered up, which is the whole promise mock
tools make.

## What only a live run can say

Four things, and every one of them is on the record rather than in this
process's memory:

- **the census arrived** — the agent reported both of its tools by name
  at session start, so mock authoring could start from the real names;
- **the mocked call was answered from the test's own override** — not
  from the project's default answer, which says the opposite and is
  resolved away here exactly as the control plane resolves it;
- **the tool egma does not answer for is named uncovered** and has no
  span at all, which is how the record admits a simulation was not fully
  isolated;
- **the declared delay is the call's duration**, measured on a real
  round trip, because a mocked backend that answered instantly would make
  every latency number from a mocked run a flattering lie.

And the transcript reads the way the test intends: the agent says Tuesday
is full and offers the day the mock named instead, and never once offers
the two times the fixture's own implementation would have invented.

## Running it

The counterpart worker must be running: ``fixtures/livekit-dumb-agent``,
started with the same environment. A room with no worker registered for
it is the ``agent_never_joined`` refusal, correctly, and the wrong test.
The one command in that fixture's README starts the worker, runs this,
and hands back the transcript; by hand it is::

    TEST_LIVEKIT_URL=wss://... \\
    TEST_LIVEKIT_API_KEY=... TEST_LIVEKIT_API_SECRET=... \\
    TEST_DEEPGRAM_API_KEY=... TEST_ELEVENLABS_API_KEY=... \\
    TEST_MODEL_API_KEY=... \\
    uv run pytest tests/test_live_mock_tools.py -v -s

Each name falls back to the plain one the tool's own CLI reads, so one
environment starts the worker and runs this. It skips — visibly, never
failing, never waiting on anybody — when any of them is missing.
"""

from __future__ import annotations

import json
from pathlib import Path

import nltk
import pytest
from conftest import (
    a_spec,
    assert_kept_secret,
    credential,
    has_terminal,
    span_attribute,
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
ELEVENLABS_API_KEY = credential("TEST_ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY")
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
        ELEVENLABS_API_KEY,
        MODEL_API_KEY,
    )
    if secret
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

# Long enough to be unmistakably the declared delay rather than the wire,
# short enough that a live conversation still fits inside its walls. A
# real calendar lookup takes about this long, which is the point of the
# knob: a mocked run's latency numbers stay comparable to a real one's.
DECLARED_DELAY_MS = 1500

# The room trip is fast and egma's own serving is faster; anything past
# this on top of the declared delay means the duration is measuring
# something other than the delay, which is the reading this asserts.
DELAY_SLACK_MS = 8000

# The project's own answer for this tool: a calendar with room in it. The
# test overrides it, and this is here so that "the override answered" is a
# fact with an alternative rather than a label — if resolution ever
# stopped preferring the test, this answer would appear on the record.
PROJECT_DEFAULT = {
    "tool_name": BOOKING_TOOL,
    "answer": {"answer": "Tuesday has 11:00 and 3:30 free."},
    "delay_milliseconds": 0,
}

# The test's own override, which is test content and versions with the
# test exactly as an expected behaviour does.
TEST_OVERRIDE = {
    "tool_name": BOOKING_TOOL,
    "answer": {"answer": CALENDAR_IS_FULL},
    "delay_milliseconds": DECLARED_DELAY_MS,
}

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


def resolved_world() -> list[dict]:
    """The one world this simulation sees, worked out the way egma works it.

    Project defaults, with the test's own overrides laid over them by tool
    name — the control plane's rule, applied here because this test stands
    where the control plane stands. What arrives at a simulator is always
    already resolved: there is nothing left for it to merge, and nowhere
    downstream that a second answer could be reached.
    """
    overriding = {entry["tool_name"]: entry for entry in [TEST_OVERRIDE]}
    world = [overriding.pop(entry["tool_name"], entry) for entry in [PROJECT_DEFAULT]]
    return world + list(overriding.values())


def mocked_spec() -> dict:
    """One spec: a real room, a real worker, and one tool egma answers for."""
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
            "You are calling to book a dental check-up. Ask whether there "
            "is anything free on Tuesday. If they say Tuesday is full, "
            "accept whatever day they offer instead, then thank them and "
            "finish."
        ),
        personality=(
            "Polite and warm; explains yourself in two or three full "
            "sentences at a time rather than clipped answers."
        ),
        max_turns=MAX_TURNS,
        max_duration_seconds=MAX_DURATION_SECONDS,
        mock_tools=resolved_world(),
    )


def deployment() -> dict[str, str]:
    """The persona itself — brain, mouth and ears.

    Nothing about reaching the room is here: a room connection carries its
    own key pair. The corpus is named because the harness hides the home
    directory NLTK would otherwise find one through.
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


def tool_calls_in(records: list[dict]) -> list[dict]:
    """Every call egma answered, as the spans they landed as.

    A tool egma does not answer for has no span here at all, by design:
    egma is not in its path and never sees it. That absence is a fact this
    test asserts rather than a gap it works around.
    """
    return [
        record["span"]
        for record in spans_for(records, SIMULATION)
        if record["span"]["name"] == "tool_call"
    ]


def milliseconds_of(span: dict) -> float:
    return (int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])) / 1_000_000


def hand_back(spoken: list[tuple[str, str]], call: dict, coverage: dict) -> None:
    """Print what the founder asked to be handed: the transcript and the
    record showing the mock answered.

    On stdout rather than in an assertion message, because the point of
    the one command is watching it work rather than reading what failed.
    pytest keeps this to itself unless the run asks for it with ``-s``,
    which is what that command does.
    """
    print("\n--- the transcript ---")
    for speaker, text in spoken:
        print(f"{speaker:>6}: {text}")
    print("\n--- the mocked call, on the record ---")
    for attribute in (
        "egma.tool.name",
        "egma.tool.arguments",
        "egma.tool.result",
        "egma.tool.provenance",
        "egma.tool.mock_tool",
    ):
        print(f"{attribute}: {span_attribute(call, attribute)}")
    print(f"duration: {milliseconds_of(call):.0f}ms, declared {DECLARED_DELAY_MS}ms")
    print(f"\n--- the coverage stamp ---\n{json.dumps(coverage, indent=2)}")


@pytest.mark.timeout(WITHIN_SECONDS + 30)
async def test_a_mock_tool_answers_a_real_agent_in_a_real_room(
    workbench, start_simulator
):
    await workbench.offer(mocked_spec())
    simulator = start_simulator(workbench, extra_env=deployment())

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

    # 1. The census arrived. Both of the agent's tools, by the names the
    #    running process knows them by — which is what makes authoring
    #    start from the real names rather than somebody's memory of them.
    coverage = facts["mock_coverage"]
    assert coverage is not None, (
        "no coverage stamp on a livekit simulation: egma never stood in "
        "the tool path, so the agent's own tools ran"
    )
    assert set(coverage["discovered"]) == {BOOKING_TOOL, UNMOCKED_TOOL}, coverage

    # 2. The stamp names one tool covered and one not. The uncovered half
    #    is the only place a reader ever learns a simulation was not fully
    #    isolated, so it is asserted as loudly as the covered half.
    assert coverage["covered"] == [BOOKING_TOOL], coverage
    assert coverage["uncovered"] == [UNMOCKED_TOOL], coverage

    calls = tool_calls_in(records)
    assert calls, (
        "no tool call reached egma: the agent either never called its tool "
        "or the SDK never stood in front of it"
    )
    spoken = turns_for(records, SIMULATION)

    # Handed back before anything else is asserted, because this is what
    # the founder's one command exists to show — and a run that then fails
    # an assertion about it is exactly the run where seeing it matters.
    hand_back(spoken, calls[0], coverage)

    # 3. The unmocked tool has no span, in either direction. egma is not
    #    in its path and does not observe it, so a span naming it would
    #    mean the record had invented one.
    assert [span_attribute(call, "egma.tool.name") for call in calls] == [
        BOOKING_TOOL
    ] * len(calls), "a tool egma answers for nothing landed on the record"

    call = calls[0]
    assert span_attribute(call, "egma.tool.arguments"), (
        "the call arrived with no arguments: the stand-in lost the real "
        "tool's signature, and LiveKit trimmed the call to nothing"
    )
    assert "day" in json.loads(span_attribute(call, "egma.tool.arguments"))

    # 4. Answered from the test's own override, and provably not from the
    #    project's default — which says the opposite and would have been
    #    served by any resolution that preferred it.
    assert json.loads(span_attribute(call, "egma.tool.result")) == CALENDAR_IS_FULL
    assert PROJECT_DEFAULT["answer"]["answer"] not in (
        span_attribute(call, "egma.tool.result") or ""
    )
    assert span_attribute(call, "egma.tool.provenance") == "mocked"
    assert span_attribute(call, "egma.tool.mock_tool") == BOOKING_TOOL

    # 5. The declared delay is the call's own duration, measured across a
    #    real room. Bounded above as well as below: a duration that only
    #    cleared the floor could be measuring anything.
    took = milliseconds_of(call)
    assert DECLARED_DELAY_MS <= took < DECLARED_DELAY_MS + DELAY_SLACK_MS, (
        f"the mocked call took {took:.0f}ms against a declared delay of "
        f"{DECLARED_DELAY_MS}ms"
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
