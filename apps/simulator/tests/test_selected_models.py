"""The simulator resolves every model and technical voice from one block."""

from __future__ import annotations

from types import SimpleNamespace
from typing import cast

import pytest

from egma_simulator.config import STT_PROVIDERS, TTS_PROVIDERS
from egma_simulator.contract import spec_validator
from egma_simulator.model import OpenAICompatibleModel, build_model_client
from egma_simulator.spec import (
    ModelSelection,
    SelectedModels,
    SimulationSpec,
    SpeechSelection,
)
from egma_simulator.speech import SpeechProviders, _ears, _mouth, voice_from_models

ModelPair = tuple[str, str]

LLM_ADAPTER_BY_PROVIDER = {"openai": OpenAICompatibleModel}
STT_ADAPTER_BY_PROVIDER = {
    "deepgram": ("deepgram", "DeepgramSTTService"),
    "openai": ("openai_realtime", "OpenAIRealtimeSTTService"),
}
TTS_ADAPTER_BY_PROVIDER = {
    "cartesia": ("cartesia", "CartesiaTTSService"),
    "openai": ("openai", "OpenAITTSService"),
}


def selection_schema(kind: str) -> dict:
    return spec_validator().schema["$defs"][f"{kind}_selection"]


def property_constants(node: object, property_name: str) -> set[str]:
    if isinstance(node, list):
        constants: set[str] = set()
        for child in node:
            constants.update(property_constants(child, property_name))
        return constants
    if not isinstance(node, dict):
        return set()

    constants: set[str] = set()
    properties = node.get("properties")
    if isinstance(properties, dict):
        property_schema = properties.get(property_name)
        if isinstance(property_schema, dict):
            constant = property_schema.get("const")
            if isinstance(constant, str):
                constants.add(constant)

    for child in node.values():
        constants.update(property_constants(child, property_name))
    return constants


def example_selection(schema: dict, *, provider: str, model: str) -> dict:
    example: dict[str, object] = {"provider": provider, "model": model}
    properties = schema["properties"]
    for field_name in schema["required"]:
        if field_name in example:
            continue
        field_schema = properties[field_name]
        if field_schema["type"] == "string":
            example[field_name] = "contract-test-value"
        elif field_schema["type"] == "number":
            example[field_name] = field_schema.get("minimum", 1)
        else:
            raise AssertionError(f"no contract-test value for {field_name}")
    return example


def contract_pairs(kind: str) -> tuple[ModelPair, ...]:
    schema = selection_schema(kind)
    provider_schema = schema["properties"]["provider"]
    if "const" in provider_schema:
        providers = (provider_schema["const"],)
    else:
        providers = tuple(provider_schema["enum"])

    models = property_constants(schema, "model")
    validator = spec_validator().evolve(schema=schema)
    pairs = tuple(
        (provider, model)
        for provider in providers
        for model in sorted(models)
        if validator.is_valid(example_selection(schema, provider=provider, model=model))
    )
    assert {provider for provider, _model in pairs} == set(providers)
    assert len(pairs) == len(providers)
    return pairs


CONTRACT_PAIRS = {kind: contract_pairs(kind) for kind in ("llm", "stt", "tts")}


def direct_key(provider: str) -> str:
    return f"{provider}-account-key"


def selected(
    *,
    llm: ModelPair | None = None,
    stt: ModelPair | None = None,
    tts: ModelPair | None = None,
) -> SelectedModels:
    llm_provider, llm_model = llm or CONTRACT_PAIRS["llm"][0]
    stt_provider, stt_model = stt or CONTRACT_PAIRS["stt"][0]
    tts_provider, tts_model = tts or CONTRACT_PAIRS["tts"][0]
    speed_schema = selection_schema("tts")["properties"]["speed"]
    return SelectedModels(
        llm=ModelSelection(
            provider=llm_provider,
            model=llm_model,
            key=direct_key(llm_provider),
        ),
        stt=ModelSelection(
            provider=stt_provider,
            model=stt_model,
            key=direct_key(stt_provider),
        ),
        tts=SpeechSelection(
            provider=tts_provider,
            model=tts_model,
            key=direct_key(tts_provider),
            voice_id=f"{tts_provider}-voice",
            speed=speed_schema["minimum"],
        ),
    )


def test_every_contract_provider_has_one_shipped_route_and_a_direct_key_shape():
    assert set(LLM_ADAPTER_BY_PROVIDER) == {
        provider for provider, _model in CONTRACT_PAIRS["llm"]
    }
    assert set(STT_ADAPTER_BY_PROVIDER) == {
        provider for provider, _model in CONTRACT_PAIRS["stt"]
    }
    assert set(TTS_ADAPTER_BY_PROVIDER) == {
        provider for provider, _model in CONTRACT_PAIRS["tts"]
    }
    assert {adapter for adapter, _service in STT_ADAPTER_BY_PROVIDER.values()} == (
        set(STT_PROVIDERS) - {"scripted"}
    )
    assert {adapter for adapter, _service in TTS_ADAPTER_BY_PROVIDER.values()} == (
        set(TTS_PROVIDERS) - {"scripted"}
    )

    for kind in CONTRACT_PAIRS:
        key_schema = selection_schema(kind)["properties"]["key"]
        assert key_schema["type"] == "string"
        assert key_schema["minLength"] > 0


@pytest.mark.parametrize(("provider", "model"), CONTRACT_PAIRS["llm"])
async def test_every_contract_llm_pair_builds_its_shipped_client(
    provider: str, model: str
):
    models = selected(llm=(provider, model))
    spec = cast(SimulationSpec, SimpleNamespace(models=models))

    client = build_model_client(spec)
    try:
        assert type(client) is LLM_ADAPTER_BY_PROVIDER[provider]
        assert client.model_name == model
        assert models.llm.key == direct_key(provider)
        assert direct_key(provider) in models.secrets
    finally:
        await client.close()


@pytest.mark.parametrize(("provider", "model"), CONTRACT_PAIRS["stt"])
def test_every_contract_stt_pair_builds_its_shipped_listening_leg(
    provider: str, model: str
):
    models = selected(stt=(provider, model))
    resolved_adapter, expected_service = STT_ADAPTER_BY_PROVIDER[provider]

    providers = SpeechProviders.from_models(models, vad="silero").checked()
    leg, _connected = _ears(providers)

    assert providers.stt == resolved_adapter
    assert providers.stt_model == model
    assert providers.stt_key == direct_key(provider)
    assert type(leg).__name__ == expected_service
    assert direct_key(provider) in models.secrets


@pytest.mark.parametrize(("provider", "model"), CONTRACT_PAIRS["tts"])
def test_every_contract_tts_pair_builds_its_shipped_speaking_leg(
    provider: str, model: str
):
    models = selected(tts=(provider, model))
    resolved_adapter, expected_service = TTS_ADAPTER_BY_PROVIDER[provider]
    voice = voice_from_models(models)

    providers = SpeechProviders.from_models(models, vad="silero").checked()
    leg, spoken_with, _closers = _mouth(providers, voice)

    assert providers.tts == resolved_adapter
    assert providers.tts_model == model
    assert providers.tts_key == direct_key(provider)
    assert type(leg).__name__ == expected_service
    assert spoken_with == voice
    assert direct_key(provider) in models.secrets
