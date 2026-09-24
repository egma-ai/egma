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
from egma_simulator.model import ModelFailure, PersonaReply, ScriptedModel
from egma_simulator.persona import SILENCE_WAIT_SECONDS, Persona
from egma_simulator.plugs import AgentReply, PlugError
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


class NotingPlug:
    """A plug whose platform says things nobody said.

    The shape a platform takes when it reports more about an answer than
    the words in it — a flow announcing the node it moved to, a message in
    a role egma has never seen.
    """

    def __init__(self, *, opening: AgentReply, answers: list[AgentReply]) -> None:
        self.provider_reference = None
        self.delivered = 0
        self.finished = 0
        self._opening = opening
        self._answers = answers

    async def open(self) -> AgentReply:
        return self._opening

    async def deliver(self, text: str) -> AgentReply:
        self.delivered += 1
        return self._answers.pop(0) if self._answers else AgentReply(text="Go on.")

    async def finish(self, text: str) -> None:
        del text
        self.finished += 1

    async def close(self) -> None:
        return None


class FixedModel:
    model_name = "fixed"

    def __init__(self, reply: PersonaReply) -> None:
        self._reply = reply

    async def reply(self, _context) -> PersonaReply:
        return self._reply

    async def close(self) -> None:
        return None


class TerminalPlug:
    provider_reference = None

    def __init__(self, final_answer: AgentReply | None = None) -> None:
        self.ended = asyncio.Event()
        self.failed = asyncio.Event()
        self.final_answer = final_answer
        self.sent: list[str] = []

    async def open(self) -> None:
        return None

    async def deliver(self, text: str) -> AgentReply:
        self.sent.append(text)
        return AgentReply(text="continue")

    async def finish(self, text: str) -> AgentReply | None:
        self.sent.append(text)
        return self.final_answer

    async def wait_ended(self) -> None:
        await self.ended.wait()

    async def wait_failed(self) -> None:
        await self.failed.wait()
        self.raise_if_failed()

    def raise_if_failed(self) -> None:
        if self.failed.is_set():
            raise PlugError("the chat transport failed")

    @property
    def has_ended(self) -> bool:
        return self.ended.is_set() and not self.failed.is_set()

    async def close(self) -> None:
        return None


def fixed_persona(reply: PersonaReply) -> Persona:
    return Persona(
        authored=AUTHORED,
        scenario_instructions="One point.",
        model=FixedModel(reply),
    )


async def test_a_textless_end_action_makes_no_turn_or_delivery():
    turns, recorder = collect()
    plug = TerminalPlug()
    reply = PersonaReply(text="", concluded=True)
    conducted = await conduct(
        persona=fixed_persona(reply),
        plug=plug,
        max_turns=10,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:textless-terminal",
    )
    assert plug.sent == []
    assert turns == []
    assert conducted.ending == "persona_concluded"


SILENT = PersonaReply(text="", concluded=False)
"""A persona reply with no words and no end_call: the persona stays silent."""


class SequenceModel:
    """Persona replies in order, then a textless end_call."""

    model_name = "sequence"

    def __init__(self, replies: list[PersonaReply]) -> None:
        self._replies = replies

    async def reply(self, _context) -> PersonaReply:
        if self._replies:
            return self._replies.pop(0)
        return PersonaReply(text="", concluded=True)

    async def close(self) -> None:
        return None


class ListeningPlug:
    """A chat plug that can also hear the agent without a persona turn."""

    provider_reference = None

    def __init__(
        self, *, answers: list[AgentReply], heard: list[AgentReply | None]
    ) -> None:
        self.sent: list[str] = []
        self.listened: list[float] = []
        self._answers = answers
        self._heard = heard

    async def open(self) -> None:
        return None

    async def deliver(self, text: str) -> AgentReply:
        self.sent.append(text)
        return self._answers.pop(0)

    async def listen(self, seconds: float) -> AgentReply | None:
        self.listened.append(seconds)
        return self._heard.pop(0)

    async def finish(self, text: str) -> None:
        self.sent.append(text)

    async def close(self) -> None:
        return None


async def conducted_in_order(
    plug, *replies: PersonaReply, on_timing=None
) -> tuple[Conducted, list[tuple[str, str]]]:
    turns, recorder = collect()
    conducted = await conduct(
        persona=Persona(
            authored=AUTHORED,
            scenario_instructions="One point.",
            model=SequenceModel(list(replies)),
        ),
        plug=plug,
        max_turns=10,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=on_timing,
        controls=ConversationControls(),
        name="sim:silent-persona",
    )
    return conducted, turns


async def test_a_silent_persona_turn_waits_for_the_agent_to_go_on():
    """The persona may say nothing, as a caller does while the agent looks
    something up. Nothing is sent, and the agent's next words continue the
    exchange. They take no latency sample: nobody asked for them."""
    measures: list[str] = []

    async def on_timing(measure: str, _milliseconds: float) -> None:
        measures.append(measure)

    plug = ListeningPlug(
        answers=[AgentReply(text="Give me a moment to pull up your policy.")],
        heard=[AgentReply(text="Found it. You are covered in Mexico.")],
    )
    conducted, turns = await conducted_in_order(
        plug,
        PersonaReply(text="Am I covered in Mexico?", concluded=False),
        SILENT,
        PersonaReply(text="Great, thank you. Goodbye.", concluded=True),
        on_timing=on_timing,
    )

    assert turns == [
        ("human", "Am I covered in Mexico?"),
        ("agent", "Give me a moment to pull up your policy."),
        ("agent", "Found it. You are covered in Mexico."),
        ("human", "Great, thank you. Goodbye."),
    ]
    assert plug.sent == ["Am I covered in Mexico?", "Great, thank you. Goodbye."]
    assert plug.listened == [SILENCE_WAIT_SECONDS]
    assert measures == ["turn_response_latency"]
    assert conducted.ending == "persona_concluded"


async def test_a_silent_persona_turn_ends_the_exchange_when_the_agent_stays_quiet():
    """Silence on both sides ends the conversation, as the persona's end_call
    would have after the goodbyes."""
    plug = ListeningPlug(
        answers=[AgentReply(text="You're welcome. Goodbye.")], heard=[None]
    )
    conducted, turns = await conducted_in_order(
        plug, PersonaReply(text="Thank you. Goodbye.", concluded=False), SILENT
    )

    assert turns == [
        ("human", "Thank you. Goodbye."),
        ("agent", "You're welcome. Goodbye."),
    ]
    assert plug.sent == ["Thank you. Goodbye."]
    assert plug.listened == [SILENCE_WAIT_SECONDS]
    assert conducted == Conducted(
        status="completed",
        ending="persona_concluded",
        reason="the persona concluded the scenario",
        provider_reference=None,
    )


async def test_a_silent_persona_turn_ends_the_exchange_where_nothing_can_listen():
    """A platform that answers only a sent turn will say nothing more."""
    plug = TerminalPlug()
    conducted, turns = await conducted_in_order(
        plug, PersonaReply(text="Thank you. Goodbye.", concluded=False), SILENT
    )

    assert plug.sent == ["Thank you. Goodbye."]
    assert turns == [("human", "Thank you. Goodbye."), ("agent", "continue")]
    assert conducted.ending == "persona_concluded"


async def test_the_agent_leaving_while_the_persona_is_silent_ends_the_exchange():
    plug = ListeningPlug(
        answers=[AgentReply(text="You're welcome. Goodbye.")],
        heard=[AgentReply(text=None, ended=True)],
    )
    conducted, turns = await conducted_in_order(
        plug, PersonaReply(text="Thank you. Goodbye.", concluded=False), SILENT
    )

    assert turns == [
        ("human", "Thank you. Goodbye."),
        ("agent", "You're welcome. Goodbye."),
    ]
    assert conducted.ending == "agent_ended"


async def test_customer_end_cancels_pending_persona_work_without_a_late_turn():
    class PendingModel:
        model_name = "pending"

        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.canceled = asyncio.Event()

        async def reply(self, _context) -> PersonaReply:
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise

        async def close(self) -> None:
            return None

    model = PendingModel()
    persona = Persona(
        authored=AUTHORED, scenario_instructions="One point.", model=model
    )
    plug = TerminalPlug()
    turns, recorder = collect()
    running = asyncio.create_task(
        conduct(
            persona=persona,
            plug=plug,
            max_turns=10,
            max_duration_seconds=30,
            on_turn=recorder,
            on_timing=None,
            controls=ConversationControls(),
            name="sim:customer-ended",
        )
    )
    await model.started.wait()
    plug.ended.set()
    conducted = await running
    assert model.canceled.is_set()
    assert turns == []
    assert plug.sent == []
    assert conducted.ending == "agent_ended"


async def test_customer_end_observed_first_beats_a_failure_ready_before_resume():
    class RacingModel:
        model_name = "racing"

        def __init__(self) -> None:
            self.reply_future = asyncio.get_running_loop().create_future()
            self.started = asyncio.Event()

        async def reply(self, _context) -> PersonaReply:
            self.started.set()
            return await self.reply_future

        async def close(self) -> None:
            return None

    model = RacingModel()
    persona = Persona(
        authored=AUTHORED, scenario_instructions="One point.", model=model
    )
    plug = TerminalPlug()
    turns, recorder = collect()
    running = asyncio.create_task(
        conduct(
            persona=persona,
            plug=plug,
            max_turns=10,
            max_duration_seconds=30,
            on_turn=recorder,
            on_timing=None,
            controls=ConversationControls(),
            name="sim:ordered-customer-end",
        )
    )
    await model.started.wait()
    plug.ended.set()
    model.reply_future.set_exception(ModelFailure("late blank response"))
    conducted = await running
    assert conducted.ending == "agent_ended"
    assert turns == []


@pytest.mark.parametrize("immediate", ["reply"])
async def test_an_already_observed_customer_end_starts_no_persona_work(immediate):
    class ImmediateModel:
        model_name = "immediate"

        def __init__(self) -> None:
            self.called = False

        async def reply(self, _context) -> PersonaReply:
            self.called = True
            return PersonaReply(text="too late", concluded=False)

        async def close(self) -> None:
            return None

    model = ImmediateModel()
    persona = Persona(
        authored=AUTHORED, scenario_instructions="One point.", model=model
    )
    plug = TerminalPlug()
    plug.ended.set()
    turns, recorder = collect()

    conducted = await conduct(
        persona=persona,
        plug=plug,
        max_turns=10,
        max_duration_seconds=30,
        on_turn=recorder,
        on_timing=None,
        controls=ConversationControls(),
        name="sim:already-ended",
    )

    assert conducted.ending == "agent_ended"
    assert model.called is False
    assert plug.sent == []
    assert turns == []


async def test_an_immediate_persona_failure_without_a_customer_end_still_fails():
    class FailingModel:
        model_name = "failing"

        async def reply(self, _context) -> PersonaReply:
            raise ModelFailure("actual persona failure")

        async def close(self) -> None:
            return None

    persona = Persona(
        authored=AUTHORED,
        scenario_instructions="One point.",
        model=FailingModel(),
    )
    with pytest.raises(ModelFailure, match="actual persona failure"):
        await conduct(
            persona=persona,
            plug=TerminalPlug(),
            max_turns=10,
            max_duration_seconds=30,
            on_turn=collect()[1],
            on_timing=None,
            controls=ConversationControls(),
            name="sim:actual-failure",
        )


async def test_an_already_failed_transport_starts_no_persona_work():
    model = FixedModel(PersonaReply(text="too late", concluded=False))
    persona = Persona(
        authored=AUTHORED, scenario_instructions="One point.", model=model
    )
    plug = TerminalPlug()
    plug.failed.set()
    turns, recorder = collect()

    with pytest.raises(PlugError, match="transport failed"):
        await conduct(
            persona=persona,
            plug=plug,
            max_turns=10,
            max_duration_seconds=30,
            on_turn=recorder,
            on_timing=None,
            controls=ConversationControls(),
            name="sim:already-failed",
        )
    assert plug.sent == []
    assert turns == []


async def test_transport_failure_then_departure_cancels_pending_persona_work():
    class PendingModel:
        model_name = "pending"

        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.canceled = asyncio.Event()

        async def reply(self, _context) -> PersonaReply:
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise

        async def close(self) -> None:
            return None

    model = PendingModel()
    persona = Persona(
        authored=AUTHORED, scenario_instructions="One point.", model=model
    )
    plug = TerminalPlug()
    turns, recorder = collect()
    running = asyncio.create_task(
        conduct(
            persona=persona,
            plug=plug,
            max_turns=10,
            max_duration_seconds=30,
            on_turn=recorder,
            on_timing=None,
            controls=ConversationControls(),
            name="sim:failed-then-left",
        )
    )
    await model.started.wait()
    plug.failed.set()
    plug.ended.set()

    with pytest.raises(PlugError, match="transport failed"):
        await running
    assert model.canceled.is_set()
    assert plug.sent == []
    assert turns == []


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


async def test_a_turn_that_began_no_answer_takes_no_sample():
    """A turn that only called a tool has no moment the agent started
    replying. A wait that never happened is not a wait of zero, so no
    sample is taken — which is how the voice lane already answers."""
    assert await timings_of(WordlessPlug(replies=2)) == []


