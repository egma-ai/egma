"""The echo pipe on its own: fast, in-process, deterministic."""

from __future__ import annotations

import asyncio

from egma_simulator.pipe import PipeControls, conduct, persona_script


def collect():
    turns: list[tuple[str, str]] = []

    async def on_turn(speaker: str, text: str) -> None:
        turns.append((speaker, text))

    return turns, on_turn


def test_the_persona_script_is_deterministic_and_sentence_shaped():
    instructions = "Move my appointment. I forget the time! Can we do Thursday?"
    script = persona_script(instructions)
    assert script == [
        "Move my appointment.",
        "I forget the time!",
        "Can we do Thursday?",
    ]
    assert persona_script(instructions) == script
    assert persona_script("no punctuation at all") == ["no punctuation at all"]


async def test_a_full_walk_echoes_every_sentence_and_concludes():
    turns, on_turn = collect()
    conducted = await conduct(
        scenario_instructions="One. Two. Three.",
        max_turns=60,
        max_duration_seconds=30,
        pacing_seconds=0,
        on_turn=on_turn,
        controls=PipeControls(),
        name="sim:test-full",
    )
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"
    assert turns == [
        ("human", "One."),
        ("agent", "One."),
        ("human", "Two."),
        ("agent", "Two."),
        ("human", "Three."),
        ("agent", "Three."),
    ]


async def test_the_turn_budget_clips_the_walk_and_names_the_limit():
    turns, on_turn = collect()
    conducted = await conduct(
        scenario_instructions="One. Two. Three.",
        max_turns=3,
        max_duration_seconds=30,
        pacing_seconds=0,
        on_turn=on_turn,
        controls=PipeControls(),
        name="sim:test-clip",
    )
    assert conducted.status == "completed"
    assert conducted.ending == "limit_reached"
    # An odd budget ends on the persona's unanswered turn: three turns,
    # both speakers counted, the echo swallowed.
    assert turns == [("human", "One."), ("agent", "One."), ("human", "Two.")]


async def test_a_cancel_directive_stops_the_walk_mid_pipe():
    turns, on_turn = collect()
    controls = PipeControls()

    async def cancel_soon() -> None:
        await asyncio.sleep(0.3)
        await controls.request_cancel()

    canceller = asyncio.create_task(cancel_soon())
    conducted = await conduct(
        scenario_instructions=" ".join(f"Sentence {n}." for n in range(1, 21)),
        max_turns=200,
        max_duration_seconds=30,
        pacing_seconds=0.1,
        on_turn=on_turn,
        controls=controls,
        name="sim:test-cancel",
    )
    await canceller
    assert conducted.status == "canceled"
    assert conducted.ending == "canceled"
    assert 0 < len(turns) < 40


async def test_the_duration_limit_ends_the_walk_deliberately():
    turns, on_turn = collect()
    conducted = await conduct(
        scenario_instructions=" ".join(f"Sentence {n}." for n in range(1, 21)),
        max_turns=200,
        max_duration_seconds=0.5,
        pacing_seconds=0.1,
        on_turn=on_turn,
        controls=PipeControls(),
        name="sim:test-duration",
    )
    assert conducted.status == "completed"
    assert conducted.ending == "limit_reached"
    assert 0 < len(turns) < 40


async def test_a_cancel_after_the_walk_finished_reports_completed():
    """A directive that stopped nothing does not rewrite what happened."""
    turns, on_turn = collect()
    controls = PipeControls()
    conducted = await conduct(
        scenario_instructions="One.",
        max_turns=60,
        max_duration_seconds=30,
        pacing_seconds=0,
        on_turn=on_turn,
        controls=controls,
        name="sim:test-late-cancel",
    )
    await controls.request_cancel()
    assert conducted.status == "completed"
    assert conducted.ending == "persona_concluded"
    assert len(turns) == 2
