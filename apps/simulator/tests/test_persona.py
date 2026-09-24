"""The persona brain: an authored person and a scenario in, a turn-taking
speaker out.

The brain owns the composition — how the authored persona and the scenario
become a system prompt — and the mapping between the transcript's two
speakers and the model's chat roles. What actually produces words sits
behind the model-client seam, so everything here is tested with the
scripted client or a recording fake.
"""

from __future__ import annotations

from conftest import load_fixture_spec

from egma_simulator.model import ScriptedModel
from egma_simulator.persona import (
    Persona,
    Turn,
    compose_system_prompt,
    messages_for,
)
from egma_simulator.spec import AuthoredPersona, PersonaParameters, SimulationSpec

AUTHORED = AuthoredPersona(
    name="Margaret",
    personality="Margaret, 68, retired schoolteacher. Polite but flustered.",
    language="en-US",
)

SCENARIO = "Move my cleaning to Thursday. Conclude once it is read back."


def test_new_parameters_drive_language_while_personality_stays_authored():
    authored = AuthoredPersona(
        name="Margaret",
        personality=AUTHORED.personality,
        language="es-MX",
        parameters=PersonaParameters(language="es-MX"),
    )

    prompt = compose_system_prompt(authored, SCENARIO)

    assert "roleplay language is es-MX" in prompt
    assert AUTHORED.personality in prompt
    assert "emotional state" not in prompt


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
