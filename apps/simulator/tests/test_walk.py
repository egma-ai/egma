"""The walk on its own: fast, in-process, deterministic.

One walk is one conducted exchange: the persona and a plug take turns
until somebody ends it — the persona concluding, the agent ending, a limit
tripping, or a cancel directive. Everything here drives the real walk with
the real persona on the scripted model, against the scripted counterpart
or a hand-rolled plug, and asserts on the turns that flowed and the ending
that was named.
"""

from __future__ import annotations

import asyncio

import pytest

from egma_simulator.model import GOODBYE, ScriptedModel
from egma_simulator.persona import Persona
from egma_simulator.plugs import AgentReply
from egma_simulator.plugs.scripted import ScriptedCounterpart
from egma_simulator.walk import Conducted, WalkControls, conduct

TRAITS = {"personality": "Terse test person.", "language": "en-US"}


def persona_for(scenario: str) -> Persona:
    return Persona(
        traits=TRAITS,
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

    async def on_turn(speaker: str, text: str) -> None:
        turns.append((speaker, text))

    return turns, on_turn


async def walk(
    *,
    scenario: str = "One thing. Another thing.",
    plug_config: dict | None = None,
    plug=None,
    max_turns: int = 60,
    max_duration_seconds: float = 30,
    controls: WalkControls | None = None,
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
        controls=controls or WalkControls(),
        name="sim:test",
    )
    return conducted, turns


async def test_a_greeted_walk_alternates_and_the_persona_concludes():
    conducted, turns = await walk(
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


async def test_an_ungreeted_walk_opens_with_the_persona():
    _, turns = await walk(scenario="Just this.", plug_config={"replies": ["Noted."]})
    assert turns[0] == ("human", "Just this.")


async def test_the_agent_ending_with_final_words_is_the_agents_doing():
    conducted, turns = await walk(
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


async def test_the_agent_ending_silently_still_ends_the_walk():
    conducted, turns = await walk(
        plug_config={"replies": [], "ends_after_replies": True}
    )
    assert [speaker for speaker, _ in turns] == ["human"]
    assert conducted.ending == "agent_ended"


async def test_the_turn_limit_clips_the_walk_and_names_itself():
    conducted, turns = await walk(
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
    conducted, turns = await walk(
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


async def test_the_duration_limit_ends_the_walk_and_names_itself():
    conducted, turns = await walk(
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
    by_turns, _ = await walk(scenario="One. Two. Three.", max_turns=2)
    by_duration, _ = await walk(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug_config={"turn_seconds": 0.1},
        max_duration_seconds=0.25,
    )
    assert by_turns.ending == by_duration.ending == "limit_reached"
    assert by_turns.reason != by_duration.reason
    assert "turn limit" in by_turns.reason
    assert "duration limit" in by_duration.reason


async def test_a_cancel_directive_stops_the_walk_mid_exchange():
    controls = WalkControls()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.25)
        controls.request_cancel()

    canceller = asyncio.create_task(cancel_soon())
    conducted, turns = await walk(
        scenario=" ".join(f"Sentence {n}." for n in range(1, 21)),
        plug_config={"turn_seconds": 0.1},
        max_turns=200,
        controls=controls,
    )
    await canceller
    assert conducted.status == "canceled"
    assert conducted.ending == "canceled"
    assert 0 < len(turns) < 40


async def test_a_cancel_after_the_walk_finished_changes_nothing():
    controls = WalkControls()
    conducted, turns = await walk(
        scenario="Only this.",
        plug_config={"replies": ["Noted."]},
        controls=controls,
    )
    controls.request_cancel()
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"
    assert len(turns) == 3


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
    conducted, _ = await walk(plug=plug)
    assert conducted.ending == "agent_ended"
    assert (plug.opened, plug.closed) == (1, 1)


async def test_the_plug_is_closed_after_a_cancel():
    controls = WalkControls()
    plug = ObservantPlug(hold_seconds=0.1)

    async def cancel_soon() -> None:
        await asyncio.sleep(0.15)
        controls.request_cancel()

    canceller = asyncio.create_task(cancel_soon())
    conducted, _ = await walk(
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
        await walk(plug=plug)
    assert plug.closed == 1


async def test_a_fault_opening_the_exchange_propagates():
    plug = ObservantPlug(fail_on="open")
    with pytest.raises(RuntimeError, match="never picked up"):
        await walk(plug=plug)
    assert plug.closed == 1


async def test_the_walk_measures_each_answered_turn():
    measures: list[tuple[str, float]] = []

    async def on_timing(measure: str, milliseconds: float) -> None:
        measures.append((measure, milliseconds))

    _, turns = await walk(
        scenario="One. Two.",
        plug_config={"replies": ["R1.", "R2."]},
        on_timing=on_timing,
    )
    answered = sum(1 for speaker, _ in turns if speaker == "agent")
    assert len(measures) == answered
    assert {name for name, _ in measures} == {"turn_response_latency"}
    assert all(milliseconds >= 0 for _, milliseconds in measures)


async def test_the_walk_carries_the_plugs_provider_reference():
    conducted, _ = await walk(
        plug_config={
            "replies": ["Done."],
            "ends_after_replies": True,
            "provider_reference": "scripted-xyz",
        }
    )
    assert conducted.provider_reference == "scripted-xyz"
