"""The persona brain: traits and scenario in, a turn-taking speaker out.

The brain owns the composition — how authored traits and the scenario
become a system prompt — and the mapping between the transcript's two
speakers and the model's chat roles. What actually produces words sits
behind the model-client seam, so everything here is tested with the
scripted client or a recording fake.
"""

from __future__ import annotations

from egma_simulator.model import CONCLUDE_MARKER, PersonaReply, ScriptedModel
from egma_simulator.persona import (
    OPENING_NUDGE,
    Persona,
    Turn,
    compose_system_prompt,
    messages_for,
)

TRAITS = {
    "personality": "Margaret, 68, retired schoolteacher. Polite but flustered.",
    "language": "en-US",
    "voice": {"provider": "cartesia", "voiceId": "warm-alto-2", "speed": 0.9},
}

SCENARIO = "Move my cleaning to Thursday. Conclude once it is read back."


def test_the_system_prompt_carries_only_personality_and_scenario():
    prompt = compose_system_prompt(TRAITS, SCENARIO)

    assert TRAITS["personality"] in prompt
    assert SCENARIO in prompt
    assert CONCLUDE_MARKER in prompt
    assert "stay in character" in prompt.lower()
    assert TRAITS["language"] not in prompt
    assert TRAITS["voice"]["voiceId"] not in prompt


def test_legacy_described_traits_do_not_become_hidden_prompt_controls():
    prompt = compose_system_prompt(
        {
            **TRAITS,
            "manner": "This must not appear.",
            "patience": "Nor this.",
            "accent": "Nor this accent.",
            "backgroundNoise": "Nor this noise.",
            "underFriction": "Nor this reaction.",
        },
        SCENARIO,
    )

    assert "This must not appear." not in prompt
    assert "Nor this." not in prompt
    assert "Nor this accent." not in prompt
    assert "Nor this noise." not in prompt
    assert "Nor this reaction." not in prompt


def test_missing_personality_has_an_explicit_neutral_fallback():
    prompt = compose_system_prompt({}, SCENARIO)

    assert "No additional personality was specified." in prompt


def test_the_system_prompt_is_deterministic():
    assert compose_system_prompt(TRAITS, SCENARIO) == compose_system_prompt(
        TRAITS, SCENARIO
    )


def test_history_maps_to_chat_roles_from_the_personas_side():
    messages = messages_for(
        "the prompt",
        [
            Turn("agent", "Hello, how can I help?"),
            Turn("human", "I need to move my cleaning."),
            Turn("agent", "Which day suits?"),
        ],
    )
    assert messages == [
        {"role": "system", "content": "the prompt"},
        {"role": "user", "content": "Hello, how can I help?"},
        {"role": "assistant", "content": "I need to move my cleaning."},
        {"role": "user", "content": "Which day suits?"},
    ]


def test_an_empty_history_gets_the_opening_nudge():
    """Someone has to go first. When no agent greeting arrived, the persona
    opens — and chat-shaped models want a user message to answer, so a
    fixed stage-setting line stands in for the silence."""
    messages = messages_for("the prompt", [])
    assert messages == [
        {"role": "system", "content": "the prompt"},
        {"role": "user", "content": OPENING_NUDGE},
    ]


async def test_the_persona_speaks_through_its_model():
    class RecordingModel:
        def __init__(self) -> None:
            self.saw: list[list[dict]] = []

        async def reply(self, messages: list[dict]) -> PersonaReply:
            self.saw.append(messages)
            return PersonaReply(text="Hello there.", concluded=False)

        async def close(self) -> None:
            return None

    model = RecordingModel()
    persona = Persona(traits=TRAITS, scenario_instructions=SCENARIO, model=model)

    reply = await persona.next_turn([Turn("agent", "Front desk, hello.")])

    assert reply == PersonaReply(text="Hello there.", concluded=False)
    (messages,) = model.saw
    assert messages[0]["role"] == "system"
    assert SCENARIO in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "Front desk, hello."}


async def test_the_persona_on_the_scripted_model_walks_and_concludes():
    persona = Persona(
        traits=TRAITS,
        scenario_instructions="First thing. Second thing.",
        model=ScriptedModel("First thing. Second thing."),
    )

    history: list[Turn] = []
    first = await persona.next_turn(history)
    assert first == PersonaReply(text="First thing.", concluded=False)

    history += [Turn("human", first.text), Turn("agent", "Noted.")]
    second = await persona.next_turn(history)
    assert second == PersonaReply(text="Second thing.", concluded=False)

    history += [Turn("human", second.text), Turn("agent", "Anything else?")]
    third = await persona.next_turn(history)
    assert third.concluded is True
    assert third.text
