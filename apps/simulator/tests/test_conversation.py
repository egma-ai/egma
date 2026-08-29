"""The conversation loop on its own: fast, in-process, deterministic.

One conversation is one conducted exchange: the persona and a plug take turns
until somebody ends it — the persona concluding, the agent ending, a limit
tripping, or a cancel directive. Everything here drives the real loop with
the real persona on the scripted model, against the scripted counterpart
or a hand-rolled plug, and asserts on the turns that flowed and the ending
that was named.
"""

from __future__ import annotations

import asyncio

import pytest

from egma_simulator.conversation import Conducted, ConversationControls, conduct
from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.plugs import AgentReply
from egma_simulator.plugs.scripted import ScriptedCounterpart
from egma_simulator.spec import AuthoredPersona

AUTHORED = AuthoredPersona(
    name="Robin", personality="Terse test person.", language="en-US"
)


def persona_for(scenario: str) -> Persona:
    return Persona(
        authored=AUTHORED,
        scenario_instructions=scenario,
        model=ScriptedModel(scenario),
    )


def scripted_plug(config: dict) -> ScriptedCounterpart:
    return ScriptedCounterpart(
        modality="chat",
        access_variant="scripted.in_memory",
        config=config,
        credentials=None,
    )


def collect():
    turns: list[tuple[str, str]] = []

    async def on_turn(
        speaker: str, text: str, notes: tuple[str, ...] = ()
    ) -> None:
        turns.append((speaker, text))

    return turns, on_turn


def collect_with_notes():
    """The same, keeping what the platform said about each turn.

    Separate from :func:`collect` because almost every test here is about
    the conversation and would only be made harder to read by a third
    element that is empty in all of them.
    """
    turns: list[tuple[str, str, tuple[str, ...]]] = []

    async def on_turn(
        speaker: str, text: str, notes: tuple[str, ...] = ()
    ) -> None:
        turns.append((speaker, text, notes))

    return turns, on_turn


async def conversation(
    *,
    scenario: str = "One thing. Another thing.",
    plug_config: dict | None = None,
    plug=None,
    max_turns: int = 60,
    max_duration_seconds: float = 30,
    controls: ConversationControls | None = None,
    on_turn=None,
    on_timing=None,
) -> tuple[Conducted, list[tuple[str, str]]]:
    turns, recorder = collect()
    conducted = await conduct(
        persona=persona_for(scenario),
        plug=plug if plug is not None else scripted_plug(plug_config or {}),
        max_turns=max_turns,
        max_duration_seconds=max_duration_seconds,
        on_turn=on_turn or recorder,
        on_timing=on_timing,
        controls=controls or ConversationControls(),
        name="sim:test",
    )
    return conducted, turns


async def test_a_greeted_conversation_alternates_and_the_persona_concludes():
    conducted, turns = await conversation(
        scenario="First point. Second point.",
        plug_config={
            "greeting": "Front desk, hello.",
            "replies": ["Certainly.", "Done."],
        },
    )
    assert turns == [
        ("agent", "Front desk, hello."),
        ("human", "First point."),
        ("agent", "Certainly."),
        ("human", "Second point."),
        ("agent", "Done."),
        ("human", GOODBYE),
    ]
    assert conducted == Conducted(
        status="completed",
        ending="persona_concluded",
        reason="the persona concluded the scenario",
        provider_reference=None,
    )


async def test_an_ungreeted_conversation_opens_with_the_persona():
    _, turns = await conversation(
        scenario="Just this.", plug_config={"replies": ["Noted."]}
    )
    assert turns[0] == ("human", "Just this.")


async def test_the_agent_ending_with_final_words_is_the_agents_doing():
    conducted, turns = await conversation(
        scenario="A long scenario. With many sentences. That keep coming.",
        plug_config={
            "replies": ["All sorted, goodbye now."],
            "ends_after_replies": True,
        },
    )
    assert turns == [
        ("human", "A long scenario."),
        ("agent", "All sorted, goodbye now."),
    ]
    assert conducted.status == "completed"
    assert conducted.ending == "agent_ended"
    assert conducted.reason == "the agent ended the exchange"


async def test_the_agent_ending_silently_still_ends_the_conversation():
    conducted, turns = await conversation(
        plug_config={"replies": [], "ends_after_replies": True}
    )
    assert [speaker for speaker, _ in turns] == ["human"]
    assert conducted.ending == "agent_ended"


async def test_the_turn_limit_clips_the_conversation_and_names_itself():
    conducted, turns = await conversation(
        scenario="One. Two. Three. Four.",
        plug_config={"replies": ["R1.", "R2."]},
        max_turns=3,
    )
    # Three turns flowed — the budget counts both speakers — and the
    # persona's next turn was never asked for.
    assert turns == [("human", "One."), ("agent", "R1."), ("human", "Two.")]
    assert conducted.status == "completed"
    assert conducted.ending == "limit_reached"
    assert conducted.reason == "the turn limit (3 turns) tripped"


async def test_an_even_turn_limit_ends_before_an_unanswerable_turn():
    conducted, turns = await conversation(
        scenario="One. Two. Three. Four.",
        plug_config={"replies": ["R1.", "R2."]},
        max_turns=4,
    )
    assert turns == [
        ("human", "One."),
        ("agent", "R1."),
        ("human", "Two."),
        ("agent", "R2."),
    ]
    assert conducted.ending == "limit_reached"


async def test_the_duration_limit_ends_the_conversation_and_names_itself():
    conducted, turns = await conversation(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug_config={"turn_seconds": 0.1},
        max_turns=200,
        max_duration_seconds=0.35,
    )
    assert 0 < len(turns) < 40
    assert conducted.status == "completed"
    assert conducted.ending == "limit_reached"
    assert conducted.reason == "the duration limit (0.35s) tripped"


async def test_the_two_limits_report_distinguishably():
    by_turns, _ = await conversation(scenario="One. Two. Three.", max_turns=2)
    by_duration, _ = await conversation(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug_config={"turn_seconds": 0.1},
        max_duration_seconds=0.25,
    )
    assert by_turns.ending == by_duration.ending == "limit_reached"
    assert by_turns.reason != by_duration.reason
    assert "turn limit" in by_turns.reason
    assert "duration limit" in by_duration.reason


async def test_a_cancel_directive_stops_the_conversation_mid_exchange():
    controls = ConversationControls()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.25)
        controls.request_cancel()

    canceller = asyncio.create_task(cancel_soon())
    conducted, turns = await conversation(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug_config={"turn_seconds": 0.1},
        max_turns=200,
        controls=controls,
    )
    await canceller
    assert conducted.status == "canceled"
    assert conducted.ending == "canceled"
    assert 0 < len(turns) < 40


async def test_a_cancel_after_the_conversation_finished_changes_nothing():
    controls = ConversationControls()
    conducted, turns = await conversation(
        scenario="Only this.",
        plug_config={"replies": ["Noted."]},
        controls=controls,
    )
    controls.request_cancel()
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"
    assert len(turns) == 3


class NotingPlug:
    """A plug whose platform says things nobody said.

    The shape a platform takes when it reports more about an answer than
    the words in it — a flow announcing the node it moved to, a message in
    a role egma has never seen.
    """

    def __init__(self, *, opening: AgentReply, answers: list[AgentReply]) -> None:
        self.provider_reference = None
        self.delivered = 0
        self._opening = opening
        self._answers = answers

    async def open(self) -> AgentReply:
        return self._opening

    async def deliver(self, text: str) -> AgentReply:
        self.delivered += 1
        return self._answers.pop(0) if self._answers else AgentReply(text="Go on.")

    async def close(self) -> None:
        return None


async def test_what_the_platform_said_rides_the_record_and_not_the_turn():
    """The rule the chat-versus-voice diagnostic rests on.

    A transition is agent-side content and it is not speech. It reaches
    whoever writes the record, beside the turn; it never joins the words,
    because the words are what the persona is handed back and what a voice
    transcript of the same scenario is compared against.
    """
    turns, recorder = collect_with_notes()
    plug = NotingPlug(
        opening=AgentReply(text="Front desk.", platform_notes=("moved to greet",)),
        answers=[
            AgentReply(text="Certainly.", platform_notes=("moved to lookup",)),
        ],
    )

    await conduct(
        persona=persona_for("First point."),
        plug=plug,
        max_turns=60,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:test",
    )

    assert turns[0] == ("agent", "Front desk.", ("moved to greet",))
    assert turns[1] == ("human", "First point.", ())
    assert turns[2] == ("agent", "Certainly.", ("moved to lookup",))


async def test_an_agent_that_ends_on_its_greeting_ends_the_conversation_there():
    """"We are closed today" and a goodbye — rare, and real.

    The exchange is over before the persona has said anything, so nothing
    is asked of it: a turn taken after the agent had gone would be a line
    on the record nobody heard, and whichever ending tripped afterwards —
    the persona concluding, a limit — would be reported instead of the
    agent's own doing.
    """
    turns, recorder = collect_with_notes()
    plug = NotingPlug(
        opening=AgentReply(text="We are closed today. Goodbye.", ended=True),
        answers=[],
    )

    conducted = await conduct(
        persona=persona_for("First point."),
        plug=plug,
        max_turns=60,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:test",
    )

    assert turns == [("agent", "We are closed today. Goodbye.", ())]
    assert plug.delivered == 0, "the persona was asked to speak to nobody"
    assert conducted == Conducted(
        status="completed",
        ending="agent_ended",
        reason="the agent ended the exchange",
        provider_reference=None,
    )


async def test_an_agent_ending_on_a_wordless_greeting_still_ends_it():
    """The same, from a platform that ends without saying anything: there
    is no turn to record and the conversation is over all the same."""
    turns, recorder = collect_with_notes()
    plug = NotingPlug(opening=AgentReply(text=None, ended=True), answers=[])

    conducted = await conduct(
        persona=persona_for("First point."),
        plug=plug,
        max_turns=60,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:test",
    )

    assert turns == []
    assert plug.delivered == 0
    assert conducted.ending == "agent_ended"


async def test_a_greeting_that_did_not_end_anything_carries_on_as_ever():
    """The guard is on the flag and nothing else: an opening reply that
    says the exchange continues is the ordinary case, and it does."""
    turns, recorder = collect_with_notes()
    plug = NotingPlug(
        opening=AgentReply(text="Front desk."),
        answers=[AgentReply(text="Certainly.")],
    )

    conducted = await conduct(
        persona=persona_for("First point."),
        plug=plug,
        max_turns=60,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:test",
    )

    assert [speaker for speaker, _text, _notes in turns] == [
        "agent",
        "human",
        "agent",
        "human",
    ]
    assert plug.delivered == 1
    assert conducted.ending == "persona_concluded"


async def test_an_answer_with_no_words_the_platform_spoke_about_is_still_a_turn():
    """An answer that carried no words is not a turn — unless the platform
    said something about it, which is still the agent's side of the
    conversation and still has to land somewhere."""
    turns, recorder = collect_with_notes()
    plug = NotingPlug(
        opening=AgentReply(text=None),
        answers=[AgentReply(text=None, platform_notes=("moved to lookup",))],
    )

    await conduct(
        persona=persona_for("First point."),
        plug=plug,
        max_turns=4,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:test",
    )

    assert turns[0] == ("human", "First point.", ())
    assert turns[1] == ("agent", "", ("moved to lookup",))


class ObservantPlug:
    """A plug that records its lifecycle, for the promises about close()."""

    def __init__(
        self,
        *,
        replies: int = 100,
        hold_seconds: float = 0.0,
        fail_on: str | None = None,
    ) -> None:
        self.opened = 0
        self.closed = 0
        self.provider_reference = "observant-1"
        self._replies = replies
        self._hold = hold_seconds
        self._fail_on = fail_on

    async def open(self) -> str | None:
        if self._fail_on == "open":
            raise RuntimeError("the platform never picked up")
        self.opened += 1
        return None

    async def deliver(self, text: str) -> AgentReply:
        if self._fail_on == "deliver":
            raise RuntimeError("the platform hung up mid-answer")
        if self._hold:
            await asyncio.sleep(self._hold)
        self._replies -= 1
        return AgentReply(text="Go on.", ended=self._replies <= 0)

    async def close(self) -> None:
        self.closed += 1


async def test_the_plug_is_closed_after_a_natural_end():
    plug = ObservantPlug(replies=2)
    conducted, _ = await conversation(plug=plug)
    assert conducted.ending == "agent_ended"
    assert (plug.opened, plug.closed) == (1, 1)


async def test_the_plug_is_closed_after_a_cancel():
    controls = ConversationControls()
    plug = ObservantPlug(hold_seconds=0.1)

    async def cancel_soon() -> None:
        await asyncio.sleep(0.15)
        controls.request_cancel()

    canceller = asyncio.create_task(cancel_soon())
    conducted, _ = await conversation(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug=plug,
        controls=controls,
    )
    await canceller
    assert conducted.status == "canceled"
    assert plug.closed == 1


async def test_a_plug_fault_propagates_and_the_plug_still_closes():
    plug = ObservantPlug(fail_on="deliver")
    with pytest.raises(RuntimeError, match="hung up"):
        await conversation(plug=plug)
    assert plug.closed == 1


async def test_a_fault_opening_the_exchange_propagates():
    plug = ObservantPlug(fail_on="open")
    with pytest.raises(RuntimeError, match="never picked up"):
        await conversation(plug=plug)
    assert plug.closed == 1


async def test_the_loop_measures_each_answered_turn():
    measures: list[tuple[str, float]] = []

    async def on_timing(measure: str, milliseconds: float) -> None:
        measures.append((measure, milliseconds))

    _, turns = await conversation(
        scenario="One. Two.",
        plug_config={"replies": ["R1.", "R2."]},
        on_timing=on_timing,
    )
    answered = sum(1 for speaker, _ in turns if speaker == "agent")
    assert len(measures) == answered
    assert {name for name, _ in measures} == {"turn_response_latency"}
    assert all(milliseconds >= 0 for _, milliseconds in measures)


class SlowToFinishPlug:
    """A plug whose answer starts long before its ``deliver`` returns.

    The room-shaped lane, in miniature: the agent begins replying at once,
    and egma then spends real time establishing the turn is over before
    the persona may speak. A stub is right here because what is under test
    is the loop's arithmetic, not any driver's.
    """

    provider_reference = None

    def __init__(self, *, answers_in: float, waits: float, replies: int = 2) -> None:
        self._answers_in = answers_in
        self._waits = waits
        self._replies = replies

    async def open(self) -> str | None:
        return None

    async def deliver(self, text: str) -> AgentReply:
        clock = asyncio.get_running_loop()
        await asyncio.sleep(self._answers_in)
        answered_at = clock.time()
        await asyncio.sleep(self._waits)
        self._replies -= 1
        return AgentReply(
            text="Go on.", ended=self._replies <= 0, answered_at=answered_at
        )

    async def close(self) -> None:
        return None


class WordlessPlug:
    """An agent turn that only called a tool: no words, and no moment it
    began saying any."""

    provider_reference = None

    def __init__(self, *, replies: int = 2) -> None:
        self._replies = replies

    async def open(self) -> str | None:
        return None

    async def deliver(self, text: str) -> AgentReply:
        self._replies -= 1
        return AgentReply(text=None, ended=self._replies <= 0)

    async def close(self) -> None:
        return None


async def timings_of(plug) -> list[float]:
    measures: list[tuple[str, float]] = []

    async def on_timing(measure: str, milliseconds: float) -> None:
        measures.append((measure, milliseconds))

    await conversation(scenario="One. Two.", plug=plug, on_timing=on_timing)
    return [
        milliseconds
        for name, milliseconds in measures
        if name == "turn_response_latency"
    ]


ANSWERS_IN = 0.05
THEN_WAITS = 0.30


async def test_the_finish_line_is_where_the_answer_started():
    """A plug that saw the answer start is measured to that moment.

    The wait after it is egma establishing the agent has no more to say,
    which is egma's own turn-taking cost. Measuring through it reported
    egma's patience as the agent's speed, and on a real run that turned
    about a second of agent into 6890 ms on the page.
    """
    measured = await timings_of(
        SlowToFinishPlug(answers_in=ANSWERS_IN, waits=THEN_WAITS)
    )

    assert measured, "an answered turn takes a sample"
    whole_call = (ANSWERS_IN + THEN_WAITS) * 1000
    for milliseconds in measured:
        assert milliseconds < whole_call / 2, (
            f"{milliseconds:.0f} ms against an answer that started at "
            f"{ANSWERS_IN * 1000:.0f} ms and a call that returned at "
            f"{whole_call:.0f} ms: the wait after the finish line is in the "
            "measure, which is the defect this holds shut"
        )
        assert milliseconds >= ANSWERS_IN * 1000 * 0.5, (
            "the sample is below the time the answer actually took to "
            "start, so the starting line has moved too"
        )


async def test_a_plug_that_cannot_see_the_answer_start_is_timed_by_its_call():
    """Where ``deliver`` is a request and its response, the two instants
    are the same and the return is the finish line. Nothing is lost, and
    the lanes that answer this way keep measuring exactly as before."""
    measured = await timings_of(ObservantPlug(replies=2))

    assert measured, "a request-and-response plug still measures every turn"
    assert all(milliseconds >= 0 for milliseconds in measured)


async def test_a_turn_that_began_no_answer_takes_no_sample():
    """A turn that only called a tool has no moment the agent started
    replying. A wait that never happened is not a wait of zero, so no
    sample is taken — which is how the voice lane already answers."""
    assert await timings_of(WordlessPlug(replies=2)) == []


async def test_the_loop_carries_the_plugs_provider_reference():
    conducted, _ = await conversation(
        plug_config={
            "replies": ["Done."],
            "ends_after_replies": True,
            "provider_reference": "scripted-xyz",
        }
    )
    assert conducted.provider_reference == "scripted-xyz"
