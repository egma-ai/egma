"""The golden daily_room specs parse, assemble, and start the right request.

The fixtures are the shared contract package's (spec v8), read from disk.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.contract import (
    ContractViolation,
    contract_dir,
    supported_spec_contract_versions,
)
from egma_simulator.pipeline import assemble
from egma_simulator.plugs.daily_room import DailyRoomChat, DailyRoomVoice
from egma_simulator.redaction import REDACTED, SecretRegistry
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

VALID = contract_dir() / "fixtures" / "spec" / "valid"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((VALID / name).read_text(encoding="utf-8"))


def test_the_simulator_advertises_the_pipecat_contract_version():
    assert 8 in supported_spec_contract_versions()


@pytest.mark.parametrize(
    ("name", "modality", "access_variant"),
    [
        ("voice-pipecat-cloud.json", "voice", "daily_room.pipecat_cloud"),
        ("chat-pipecat-cloud.json", "chat", "daily_room.pipecat_cloud"),
        ("voice-pipecat-self-hosted.json", "voice", "daily_room.self_hosted"),
        ("chat-pipecat-self-hosted.json", "chat", "daily_room.self_hosted"),
    ],
)
def test_each_daily_room_fixture_assembles_its_plug(
    name: str, modality: str, access_variant: str, tmp_path: Path
):
    document = fixture(name)
    spec = SimulationSpec.from_document(document)
    assert spec.connection_type == "daily_room"
    assert spec.access_variant == access_variant
    assert spec.pipecat_body_params == document.get("pipecat_body_params")

    registered: list[str] = []

    async def register(reference: str) -> None:
        registered.append(reference)

    built = assemble(
        spec,
        blobs=FilesystemBlobStore(tmp_path),
        speech=SCRIPTED_PAIR,
        on_provider_reference=register,
    )
    if modality == "chat":
        assert isinstance(built.plug, DailyRoomChat)
        plug: Any = built.plug
    else:
        assert built.conductor is not None
        plug = built.conductor._connection
        assert isinstance(plug, DailyRoomVoice)

    asked = plug.backend.starter.request_body()
    expected_body = {
        **(document.get("pipecat_body_params") or {}),
        "egma": {"simulation_id": spec.simulation_id, "modality": modality},
    }
    assert asked["body"] == expected_body
    assert asked["dailyRoomProperties"]["eject_at_room_exp"] is True
    assert ("transport" in asked) == (access_variant == "daily_room.self_hosted")


def test_the_pipecat_cloud_fixture_starts_its_agent_with_its_public_key(
    tmp_path: Path,
):
    spec = SimulationSpec.from_document(fixture("voice-pipecat-cloud.json"))
    built = assemble(spec, blobs=FilesystemBlobStore(tmp_path), speech=SCRIPTED_PAIR)
    assert built.conductor is not None
    settings = built.conductor._connection.backend.starter._settings
    assert settings.start_url == (
        "https://api.pipecat.daily.co/v1/public/lakeside-front-desk/start"
    )
    assert settings.headers == {
        "Authorization": "Bearer pk_fixture0not0a0real0public0key"
    }
    assert "pk_fixture0not0a0real0public0key" in spec.secrets[0].values()


def test_a_daily_room_spec_carrying_egma_in_its_body_params_is_refused():
    document = fixture("voice-pipecat-cloud.json")
    document["pipecat_body_params"] = {"egma": {"simulation_id": "forged"}}
    with pytest.raises(ContractViolation):
        SimulationSpec.from_document(document)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        (
            "voice-pipecat-self-hosted.json",
            ("Bearer fixture0not0a0real0token", "fixture0not0a0real0token"),
        ),
        ("voice-pipecat-cloud.json", ("pk_fixture0not0a0real0public0key",)),
    ],
)
def test_each_start_credential_is_redacted_process_wide(
    name: str, expected: tuple[str, ...]
):
    """The service registers a claim's secrets before conducting it."""
    spec = SimulationSpec.from_document(fixture(name))
    registry = SecretRegistry()
    registry.register(list(spec.secrets))
    for secret in expected:
        told = registry.redact(f"the starter echoed {secret} back")
        assert secret not in told
        assert REDACTED in told
