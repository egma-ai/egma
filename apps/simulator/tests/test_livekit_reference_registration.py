"""Persist a LiveKit room association before any worker can export to it."""

import asyncio
from pathlib import Path

import pytest
from test_plug_livekit import livekit_endpoint_spec, livekit_spec

from egma_simulator.blob import FilesystemBlobStore
from egma_simulator.media.livekit_room import RoomLifecycle, WayIn
from egma_simulator.pipeline import assemble
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR


@pytest.mark.parametrize("modality", ["voice", "chat"])
@pytest.mark.parametrize("endpoint", [False, True])
@pytest.mark.parametrize("refused", [False, True])
async def test_registration_is_acknowledged_before_any_room_effect(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    modality: str,
    endpoint: bool,
    refused: bool,
):
    entered = asyncio.Event()
    acknowledged = asyncio.Event()
    registered: list[str] = []
    effects: list[str] = []

    async def register(reference: str) -> None:
        registered.append(reference)
        entered.set()
        await acknowledged.wait()
        if refused:
            raise RuntimeError("association refused")

    async def create_room(backend: RoomLifecycle) -> None:
        assert acknowledged.is_set()
        assert registered == [backend.room_name]
        effects.append("create")

    async def token(backend: RoomLifecycle) -> WayIn:
        assert acknowledged.is_set()
        assert registered == [backend.room_name]
        effects.append("endpoint")
        return WayIn(url="wss://livekit.test", token="test")

    monkeypatch.setattr(RoomLifecycle, "_create_room", create_room)
    monkeypatch.setattr(RoomLifecycle, "_token_from_endpoint", token)
    document = livekit_endpoint_spec() if endpoint else livekit_spec()
    document["modality"] = modality
    if modality == "chat":
        document["models"]["stt"].pop("key", None)
        document["models"]["tts"].pop("key", None)
    built = assemble(
        SimulationSpec.from_document(document),
        blobs=FilesystemBlobStore(tmp_path),
        speech=SCRIPTED_PAIR,
        on_provider_reference=register,
    )
    plug = built.plug if built.plug is not None else built.conductor._connection
    preparing = asyncio.create_task(plug.backend._way_in())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        assert not effects, "a worker could export before the association exists"
        acknowledged.set()
        if refused:
            with pytest.raises(RuntimeError, match="association refused"):
                await preparing
            assert not effects
        else:
            await preparing
            assert effects == ["endpoint" if endpoint else "create"]
    finally:
        acknowledged.set()
        await asyncio.gather(preparing, return_exceptions=True)
