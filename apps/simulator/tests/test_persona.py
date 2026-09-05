"""The persona brain: an authored person and a scenario in, a turn-taking
speaker out.

The brain owns the composition — how the authored persona and the scenario
become a system prompt — and the mapping between the transcript's two
speakers and the model's chat roles. What actually produces words sits
behind the model-client seam, so everything here is tested with the
scripted client or a recording fake.
"""

# The expected prompt is product copy. Keep its source lines verbatim.
# ruff: noqa: E501

from __future__ import annotations

import pytest
from conftest import load_fixture_spec
from pipecat.processors.aggregators.llm_context import LLMContext

from egma_simulator.model import PERSONA_TOOLS, PersonaReply, ScriptedModel
from egma_simulator.persona import (
    OPENING_NUDGE,
    Persona,
    Turn,
    compose_system_prompt,
    messages_for,
)
from egma_simulator.spec import AuthoredPersona, SimulationSpec

AUTHORED = AuthoredPersona(
    name="Margaret",
    personality="Margaret, 68, retired schoolteacher. Polite but flustered.",
    language="en-US",
)

SCENARIO = "Move my cleaning to Thursday. Conclude once it is read back."


def test_the_system_prompt_is_the_platform_prompt_verbatim():
    prompt = compose_system_prompt(AUTHORED, SCENARIO)

    assert prompt == f"""\
# Background

Here's the bigger picture - you are part of a broader voice agent testing platform where you perform the role of a simulated human that is calling a **voice agent** to test that voice agent under a particular scenario.

You have certain quirks of your own behavior and your own personality and how you do things in certain situations. Your job is to emulate a given scenario with your specific personality traits and emulate the scenario so that we can look at the conversation between you (the simulated human persona) and the voice agent to evaluate at scale how the voice agent behaves under the given scenario.

# Who you are

Your name is {AUTHORED.name}. Give that name when the agent asks who is calling, and use it whenever you introduce yourself.

# Your personality

{AUTHORED.personality}

# The situation you are trying to roleplay with the agent

{SCENARIO}

# Important Rules

- Stay in character’s personality for the whole exchange. Never mention being a simulator, or an AI.
- The roleplay language is {AUTHORED.language}
- You are allowed to make up details in order to fulfill the scenario unless explicitly stated otherwise. Examples include appointment details, or other details that someone in your situation might have handy. Your name is not one of them: it is given above, and you never answer to another.
- Pursue what you came for until it is concluded to your satisfaction, and let your personality decide how patiently.
- When your goal is concluded and nothing further is needed, say a brief goodbye and end your reply with the `end_call` tool
"""


def test_the_prompt_states_the_name_instead_of_licensing_an_invented_one():
    """The whole point of the authored name.

    The invented-details rule used to offer "your name" as its first
    example, so the same test met the agent as Sarah on Monday and Jessica
    on Tuesday. The name is now stated, and the rule no longer lists it —
    both halves matter, because either one alone leaves the model a choice.
    """
    prompt = compose_system_prompt(AUTHORED, SCENARIO)

    assert f"Your name is {AUTHORED.name}." in prompt
    assert "Examples include your name" not in prompt
    # The rule itself stands; only the name has left its examples.
    assert "You are allowed to make up details" in prompt


def test_the_system_prompt_carries_no_technical_settings():
    """Who they are, and nothing about how they are rendered.

    Voice, speed and model choices belong to the work order's models block
    and are the pipeline's business. A prompt that mentioned them would be
    telling the model about machinery it has no part in.
    """
    prompt = compose_system_prompt(AUTHORED, SCENARIO)

    assert '"voice"' not in prompt
    assert '"models"' not in prompt


def test_the_prompt_offers_one_way_to_conclude_and_not_the_retired_marker():
    """How the persona says it is done, and the way it no longer says it.

    Concluding is the native ``end_call`` tool. ``[CONCLUDED]`` was the text
    marker that came before it, and the model client already refuses to read
    one as control — ``test_a_literal_old_marker_has_no_control_meaning`` in
    the model suite is that half. This is the other: a prompt that still
    taught the marker would have the model emit a sentinel nothing acts on,
    and stay in an exchange it believed it had ended.
    """
    prompt = compose_system_prompt(AUTHORED, SCENARIO)

    assert "`end_call` tool" in prompt
    assert "[CONCLUDED]" not in prompt


def test_the_system_prompt_is_deterministic():
    assert compose_system_prompt(AUTHORED, SCENARIO) == compose_system_prompt(
        AUTHORED, SCENARIO
    )


def test_the_prompt_for_a_claimed_simulation_names_the_persona():
    """The chain the work order exists to close.

    A claimed document is held to the contract, read into a spec, and built
    into a brain. The name the persona version authored is the name the
    prompt states — so the agent hears the same person on every run of the
    same test, which is what a name-keyed mock world will one day need.
    """
    document = load_fixture_spec("chat-scripted-flustered.json")
    authored_name = document["persona"]["name"]
    assert authored_name, "the contract requires a name; the fixture must carry one"

    spec = SimulationSpec.from_document(document)
    persona = Persona(
        authored=spec.persona,
        scenario_instructions=spec.scenario_instructions,
        model=ScriptedModel(spec.scenario_instructions),
    )

    assert spec.persona.name == authored_name
    prompt = persona.messages([])[0]["content"]
    assert f"Your name is {authored_name}." in prompt


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


@pytest.mark.parametrize("follow_up", [1, 2])
def test_silence_follow_up_explains_the_pause_without_changing_history(follow_up):
    persona = Persona(
        authored=AUTHORED,
        scenario_instructions=SCENARIO,
        model=ScriptedModel(SCENARIO),
    )
    history = [Turn("agent", "Hello."), Turn("human", "Can I book a tour?")]
    ordinary = persona.messages(history)

    context = persona.context(history, silence_follow_up=follow_up)
    messages = context.get_messages()

    assert messages[:-1] == ordinary
    assert messages[-1]["role"] == "user"
    assert "10 seconds" in messages[-1]["content"]
    assert f"{follow_up} of 2" in messages[-1]["content"]
    assert persona.messages(history) == ordinary
    assert history[-1] == Turn("human", "Can I book a tour?")


def test_every_persona_context_advertises_the_native_end_call_tool():
    persona = Persona(
        authored=AUTHORED,
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
    persona = Persona(authored=AUTHORED, scenario_instructions=SCENARIO, model=model)

    reply = await persona.next_turn([Turn("agent", "Front desk, hello.")])

    assert reply == PersonaReply(text="Hello there.", concluded=False)
    (context,) = model.saw
    messages = context.get_messages()
    assert messages[0]["role"] == "system"
    assert SCENARIO in messages[0]["content"]
    assert messages[1] == {"role": "user", "content": "Front desk, hello."}


async def test_the_persona_on_the_scripted_model_walks_and_concludes():
    persona = Persona(
        authored=AUTHORED,
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
