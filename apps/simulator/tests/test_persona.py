"""The persona brain: traits and scenario in, a turn-taking speaker out.

The brain owns the composition — how authored traits and the scenario
become a system prompt — and the mapping between the transcript's two
speakers and the model's chat roles. What actually produces words sits
behind the model-client seam, so everything here is tested with the
scripted client or a recording fake.
"""

# The expected prompt is product copy. Keep its source lines verbatim.
# ruff: noqa: E501

from __future__ import annotations

from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.model import PERSONA_TOOLS, PersonaReply, ScriptedModel
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
    "manner": "Warm and direct.",
    "patience": "Waits once before asking again.",
    "accent": "Neutral American English.",
    "backgroundNoise": "A quiet waiting room.",
    "underFriction": "Becomes firmer without becoming rude.",
}

SCENARIO = "Move my cleaning to Thursday. Conclude once it is read back."


def test_the_system_prompt_is_the_platform_prompt_verbatim():
    prompt = compose_system_prompt(TRAITS, SCENARIO)

    assert prompt == f"""\
# Background

Here's the bigger picture - you are part of a broader voice agent testing platform where you perform the role of a simulated human that is calling a **voice agent** to test that voice agent under a particular scenario.

You have certain quirks of your own behavior and your own personality and how you do things in certain situations. Your job is to emulate a given scenario with your specific personality traits and emulate the scenario so that we can look at the conversation between you (the simulated human persona) and the voice agent to evaluate at scale how the voice agent behaves under the given scenario.

# Your personality

{TRAITS["personality"]}

# The situation you are trying to roleplay with the agent

{SCENARIO}

# Important Rules

- Stay in character’s personality for the whole exchange. Never mention being a simulator, or an AI.
- The roleplay language is {TRAITS["language"]}
- You are allowed to make up details in order to fulfill the scenario unless explicitly stated otherwise. Examples include your name, appointment details, or other details that someone in your situation might have handy.
- Pursue what you came for until it is concluded to your satisfaction, and let your personality decide how patiently.
- When your goal is concluded and nothing further is needed, say a brief goodbye and end your reply with the `end_call` tool
"""


def test_the_system_prompt_uses_only_personality_language_and_scenario():
    prompt = compose_system_prompt(TRAITS, SCENARIO)

    assert TRAITS["manner"] not in prompt
    assert TRAITS["patience"] not in prompt
    assert TRAITS["accent"] not in prompt
    assert TRAITS["backgroundNoise"] not in prompt
    assert TRAITS["underFriction"] not in prompt
    assert '"voice"' not in prompt
    assert '"models"' not in prompt
    assert "[CONCLUDED]" not in prompt


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


def test_every_persona_context_advertises_the_native_end_call_tool():
    persona = Persona(
        traits=TRAITS,
        scenario_instructions=SCENARIO,
        model=ScriptedModel(SCENARIO),
    )

    context = persona.context([])

    assert context.tools is PERSONA_TOOLS
    assert context.tool_choice == "auto"
    assert PERSONA_TOOLS.standard_tools[0].to_default_dict() == {
        "name": "end_call",
        "description": (
            "use to end the call once you have determined that the objective of "
            "the current simulation has been met."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    }


async def test_the_persona_speaks_through_its_model():
    class RecordingModel:
        def __init__(self) -> None:
            self.saw: list[LLMContext] = []

        async def reply(self, context: LLMContext) -> PersonaReply:
            self.saw.append(context)
            return PersonaReply(text="Hello there.", concluded=False)

        async def close(self) -> None:
            return None

    model = RecordingModel()
    persona = Persona(traits=TRAITS, scenario_instructions=SCENARIO, model=model)

    reply = await persona.next_turn([Turn("agent", "Front desk, hello.")])

    assert reply == PersonaReply(text="Hello there.", concluded=False)
    (context,) = model.saw
    messages = context.get_messages()
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
