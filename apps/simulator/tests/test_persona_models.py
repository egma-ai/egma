"""A persona that selects its own models, arriving on the work order.

**The claim under test is a precedence claim**, so it is only worth anything
when every source is set at once. Each test below puts one value in this
container's environment, a different value for the same setting in the
platform's block, and a third in the persona's own selection — then observes
which one was used. A test that set only one side would pass against a
simulator that read none of them.

The other half of the file is what must *not* travel: a work order that
carries no selections is conducted exactly as it was before selections
existed, and a key that arrives on one is registered for redaction before
anything is conducted with it.
"""

from __future__ import annotations

import pytest

from egma_simulator.config import SimulatorConfig
from egma_simulator.contract import SUPPORTED_SPEC_VERSIONS, ContractViolation
from egma_simulator.model import ModelFailure, OpenAICompatibleModel, build_model_client
from egma_simulator.spec import (
    Limits,
    ModelSelection,
    PlatformModel,
    PlatformSettings,
    PlatformSpeech,
    SelectedModels,
    SimulationSpec,
    SpeechSelection,
)
from egma_simulator.speech import SpeechProviders, voice_for_simulation

A_URL = "http://control-plane.test"

SELECTED = SelectedModels(
    access="customer-owned",
    llm=ModelSelection(
        provider="openai",
        model="the-model-the-persona-selected",
        key="SENTINEL-selected-thinking-key-91ab",
    ),
    stt=ModelSelection(
        provider="deepgram",
        model="the-model-the-persona-listens-with",
        key="SENTINEL-selected-listening-key-92cd",
    ),
    tts=SpeechSelection(
        provider="cartesia",
        model="the-model-the-persona-speaks-with",
        key="SENTINEL-selected-speaking-key-93ef",
        voice_id="the-voice-the-persona-selected",
        speed=1.25,
    ),
)

THE_PLATFORMS_OWN = PlatformSettings(
    model=PlatformModel(
        provider="openai",
        model="the-model-the-platform-was-told-about",
        key="SENTINEL-platform-model-key-0001",
        reasoning_effort="high",
    ),
    speech=PlatformSpeech(
        stt_provider="openai",
        stt_key="SENTINEL-platform-listening-key-0002",
        stt_model="the-model-the-platform-listens-with",
        tts_provider="elevenlabs",
        tts_key="SENTINEL-platform-speaking-key-0003",
        tts_model="the-model-the-platform-speaks-with",
        tts_voice="the-voice-the-platform-chose",
        vad_provider="silero",
    ),
)


@pytest.fixture
def a_container(env) -> SimulatorConfig:
    """A simulator configured the way one with its own settings is.

    Every one of these is a value a test can watch losing to something the
    work order said, which is what makes each assertion an observation
    rather than two settings that happen to agree.
    """
    env.setenv("EGMA_SIMULATOR_CONTROL_PLANE_URL", A_URL)
    env.setenv("EGMA_SIMULATOR_MODEL_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_MODEL_NAME", "the-model-this-container-knows")
    env.setenv("EGMA_SIMULATOR_MODEL_API_KEY", "SENTINEL-container-model-key-1111")
    env.setenv("EGMA_SIMULATOR_STT_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_TTS_PROVIDER", "openai")
    env.setenv("EGMA_SIMULATOR_OPENAI_API_KEY", "SENTINEL-container-openai-key-2222")
    env.setenv("EGMA_SIMULATOR_TTS_VOICE", "the-voice-this-container-knows")
    return SimulatorConfig.from_env()


def a_spec_with(
    models: SelectedModels | None,
    platform: PlatformSettings | None = None,
    traits: dict | None = None,
) -> SimulationSpec:
    """One claimed spec, carrying whatever a test is about."""
    return SimulationSpec(
        simulation_id="sim-under-test",
        modality="voice",
        scenario_instructions="State the first point.",
        limits=Limits(max_duration_seconds=300, max_turns=40),
        persona_traits=traits or {},
        connection_type="scripted",
        connection_config={},
        credentials=None,
        platform=platform or PlatformSettings(),
        models=models,
    )


# -- What the persona selected wins ------------------------------------------


def test_the_selected_legs_beat_the_platforms_and_this_containers(a_container):
    """Three sources set to three different things, and the pinned one wins."""
    providers = SpeechProviders.for_simulation(
        a_container, THE_PLATFORMS_OWN.speech, SELECTED
    )

    assert providers.stt == "deepgram"
    assert providers.stt_model == "the-model-the-persona-listens-with"
    assert providers.stt_key == "SENTINEL-selected-listening-key-92cd"
    assert providers.tts == "cartesia"
    assert providers.tts_model == "the-model-the-persona-speaks-with"
    assert providers.tts_key == "SENTINEL-selected-speaking-key-93ef"
    assert providers.tts_voice == "the-voice-the-persona-selected"


def test_a_selected_leg_never_falls_back_to_a_key_nobody_chose(a_container):
    """A key belongs to the account the selection names, or there is none.

    Falling back to this container's key for a provider the persona named
    would spend from an account nobody in that organization chose, which is
    the failure the whole credential arrangement exists to make unreachable.
    """
    keyless = SelectedModels(
        access="customer-owned",
        llm=ModelSelection(provider="openai", model="m", key=None),
        stt=ModelSelection(provider="deepgram", model="n", key=None),
        tts=SpeechSelection(
            provider="cartesia", model="s", key=None, voice_id="v", speed=1.0
        ),
    )

    providers = SpeechProviders.for_simulation(
        a_container, THE_PLATFORMS_OWN.speech, keyless
    )

    assert providers.stt_key is None
    assert providers.tts_key is None


def test_the_voice_activity_leg_is_never_something_a_persona_selects(a_container):
    """What tells the persona the agent started and stopped speaking is
    internal simulator behavior, not a model anybody chooses — so it comes
    from the platform whatever the persona selected."""
    providers = SpeechProviders.for_simulation(
        a_container, THE_PLATFORMS_OWN.speech, SELECTED
    )

    assert providers.vad == "silero"


def test_the_selected_brain_beats_the_platforms_and_this_containers(a_container):
    client = build_model_client(a_container, a_spec_with(SELECTED, THE_PLATFORMS_OWN))

    assert isinstance(client, OpenAICompatibleModel)
    assert client._model_name == "the-model-the-persona-selected"
    assert client._api_key == "SENTINEL-selected-thinking-key-91ab"
    # Reasoning effort is a legacy deployment setting rather than part of what
    # a persona is. A selected persona uses its provider's default reasoning
    # behavior, and the platform's value does not leak into it.
    assert client._reasoning_effort is None


def test_a_selected_brain_with_no_key_is_refused_rather_than_scripted(a_container):
    """Refused rather than quietly downgraded to the stand-in: a completed,
    green simulation conducted by a canned robot is worse than a failure,
    because a failure tells the truth about what happened."""
    keyless = SelectedModels(
        access="managed",
        llm=ModelSelection(provider="openai", model="m", key=None),
        stt=SELECTED.stt,
        tts=SELECTED.tts,
    )

    with pytest.raises(ModelFailure) as refusal:
        build_model_client(a_container, a_spec_with(keyless, THE_PLATFORMS_OWN))

    assert "no key" in str(refusal.value)


def test_a_selected_provider_this_simulator_cannot_speak_to_is_refused(a_container):
    unknown = SelectedModels(
        access="customer-owned",
        llm=ModelSelection(provider="a-company-nobody-shipped", model="m", key="k"),
        stt=SELECTED.stt,
        tts=SELECTED.tts,
    )

    with pytest.raises(ModelFailure) as refusal:
        build_model_client(a_container, a_spec_with(unknown))

    assert "a-company-nobody-shipped" in str(refusal.value)


def test_the_selected_voice_is_the_one_source_and_traits_are_not_read(a_container):
    """A migrated version has one voice source, and it is the selection.

    Reading both would be two answers to one question, and which one won
    would depend on which of them somebody edited last.
    """
    authored_elsewhere = {
        "voice": {
            "provider": "elevenlabs",
            "voiceId": "the-voice-in-the-old-traits",
            "speed": 0.75,
        }
    }

    voice = voice_for_simulation(authored_elsewhere, SELECTED)

    assert voice.voice_id == "the-voice-the-persona-selected"
    assert voice.provider == "cartesia"
    assert voice.speed == 1.25


# -- What a work order without selections still does --------------------------


def test_a_work_order_with_no_selections_is_conducted_exactly_as_before(a_container):
    """Every persona authored before the model catalog existed arrives this
    way, and the deployment's own settings decide exactly as they did."""
    providers = SpeechProviders.for_simulation(
        a_container, THE_PLATFORMS_OWN.speech, None
    )

    assert providers.stt == "openai"
    assert providers.stt_key == "SENTINEL-platform-listening-key-0002"
    assert providers.tts == "elevenlabs"
    assert providers.tts_voice == "the-voice-the-platform-chose"

    client = build_model_client(a_container, a_spec_with(None, THE_PLATFORMS_OWN))
    assert isinstance(client, OpenAICompatibleModel)
    assert client._model_name == "the-model-the-platform-was-told-about"
    assert client._reasoning_effort == "high"


def test_a_persona_with_no_selections_still_speaks_from_its_traits(a_container):
    authored = {
        "voice": {
            "provider": "elevenlabs",
            "voiceId": "the-voice-in-the-old-traits",
            "speed": 0.75,
        }
    }

    voice = voice_for_simulation(authored, None)

    assert voice.voice_id == "the-voice-in-the-old-traits"
    assert voice.provider == "elevenlabs"
    assert voice.speed == 0.75


# -- What travels, and what must not -----------------------------------------


def test_every_selected_key_is_offered_for_redaction_in_one_place():
    """One place to ask, so a fourth key arriving cannot fall out of the
    scrubbing — the platform settings' own rule, one block over."""
    assert set(SELECTED.secrets) == {
        "SENTINEL-selected-thinking-key-91ab",
        "SENTINEL-selected-listening-key-92cd",
        "SENTINEL-selected-speaking-key-93ef",
    }


def test_a_managed_work_order_offers_no_key_because_it_carries_none():
    managed = SelectedModels(
        access="managed",
        llm=ModelSelection(provider="openai", model="m"),
        stt=ModelSelection(provider="deepgram", model="n"),
        tts=SpeechSelection(provider="cartesia", model="s", voice_id="v", speed=1.0),
    )

    assert managed.secrets == ()


def test_no_selected_key_appears_in_a_repr_of_what_holds_it():
    """A log line carrying a key is a log line that should not have, and the
    cheapest way to be sure is for the dataclass never to print one."""
    written = repr(SELECTED)

    for secret in SELECTED.secrets:
        assert secret not in written


# -- The contract this process speaks ----------------------------------------


def test_a_claimed_version_two_document_becomes_the_selections_it_carries():
    document = {
        "contract_version": 2,
        "simulation_id": "sim-1",
        "modality": "voice",
        "connection": {"type": "scripted", "config": {}, "credentials": None},
        "persona": {"traits": {}},
        "scenario": {"instructions": "State the first point."},
        "limits": {"max_duration_seconds": 300, "max_turns": 40},
        "models": {
            "access": "customer-owned",
            "llm": {"provider": "openai", "model": "m", "key": "k1"},
            "stt": {"provider": "deepgram", "model": "n", "key": "k2"},
            "tts": {
                "provider": "cartesia",
                "model": "s",
                "key": "k3",
                "voice_id": "v",
                "speed": 1.5,
            },
        },
    }

    spec = SimulationSpec.from_document(document)

    assert spec.models is not None
    assert spec.models.access == "customer-owned"
    assert spec.models.llm.model == "m"
    assert spec.models.tts.voice_id == "v"
    assert spec.models.tts.speed == 1.5


def test_a_claimed_version_one_document_carries_no_selections():
    document = {
        "contract_version": 1,
        "simulation_id": "sim-1",
        "modality": "chat",
        "connection": {"type": "scripted", "config": {}, "credentials": None},
        "persona": {"traits": {}},
        "scenario": {"instructions": "State the first point."},
        "limits": {"max_duration_seconds": 600, "max_turns": 60},
    }

    spec = SimulationSpec.from_document(document)

    assert spec.models is None


def test_a_version_one_document_carrying_selections_is_refused_loudly():
    """The mixed-rollout guard, from this side of the wire.

    This is what a control plane that got the negotiation wrong would emit,
    and the failure it would cause is the quiet one: a worker that ignored
    the unknown block would conduct the simulation with its deployment's own
    models while the control plane believed it had sent the persona's — same
    conversation, different voice, different brain, different bill, and
    nothing anywhere saying so.
    """
    document = {
        "contract_version": 1,
        "simulation_id": "sim-1",
        "modality": "voice",
        "connection": {"type": "scripted", "config": {}, "credentials": None},
        "persona": {"traits": {}},
        "scenario": {"instructions": "State the first point."},
        "limits": {"max_duration_seconds": 300, "max_turns": 40},
        "models": {
            "access": "customer-owned",
            "llm": {"provider": "openai", "model": "m", "key": "k1"},
            "stt": {"provider": "deepgram", "model": "n", "key": "k2"},
            "tts": {
                "provider": "cartesia",
                "model": "s",
                "key": "k3",
                "voice_id": "v",
                "speed": 1.0,
            },
        },
    }

    with pytest.raises(ContractViolation) as refusal:
        SimulationSpec.from_document(document)

    assert any(
        "models" in complaint and "Additional properties" in complaint
        for complaint in refusal.value.complaints
    ), refusal.value.complaints


def test_this_simulator_declares_the_versions_it_implements():
    """What a claim advertises, and what makes a mixed rollout safe with no
    drain step: a row needing a document this process cannot read is never
    offered to it at all."""
    assert SUPPORTED_SPEC_VERSIONS == (1, 2)
