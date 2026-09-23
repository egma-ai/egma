"""A Daily room voice claim on the hosted runtime (Daytona).

The claim carries a per-claim ``runtime`` block. Its storage becomes the
recording store; its LiveKit media is for phone calls and the Daily plug never
reads it. Control-plane calls use the runtime's proxy; the start request and
Daily media go direct, so the start request's address guard still sees the
real destination.
"""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from aiohttp import web
from starter_stub import A_ROOM, Answer, starting

from egma_simulator.blob import FilesystemBlobStore, S3BlobStore
from egma_simulator.config import MediaSettings, SimulatorConfig
from egma_simulator.contract import contract_dir
from egma_simulator.media import MediaBackendError
from egma_simulator.media.daily_room import PipecatStarter, StartSettings
from egma_simulator.pipeline import assemble
from egma_simulator.plugs.daily_room import DailyRoomVoice
from egma_simulator.redaction import SecretRegistry
from egma_simulator.service import resources_for_claim
from egma_simulator.spec import SimulationSpec
from egma_simulator.speech import SCRIPTED_PAIR

HOSTED = "voice-pipecat-cloud-hosted.json"
START_HOST = "bots.lakeside-dental.example"
PUBLIC_ADDRESS = "93.184.216.34"


def hosted_document() -> dict[str, Any]:
    return json.loads(
        (contract_dir() / "fixtures/spec/valid" / HOSTED).read_text(encoding="utf-8")
    )


def standing_config(tmp_path: Path) -> SimulatorConfig:
    return SimulatorConfig(
        control_plane_url="http://control-plane.invalid",
        claimant="egma-voice-hosted-test",
        capacity=1,
        heartbeat_seconds=5,
        claim_wait_seconds=30,
        report_deadline_seconds=120,
        wal_dir=tmp_path / "wal",
        blob_dir=tmp_path / "blobs",
        log_level="INFO",
        mode="one-shot",
        modalities=("voice",),
        runtime="daytona",
    )


class NoReading:
    """Fails on any read, standing in for media nobody may use."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"the Daily plug read the claim's media ({name})")


def test_the_hosted_fixture_keeps_its_runtime_and_assembles_the_daily_plug(
    tmp_path: Path,
):
    document = hosted_document()
    spec = SimulationSpec.from_document(document)
    assert spec.connection_type == "daily_room"
    assert spec.modality == "voice"
    assert spec.runtime is not None
    assert spec.runtime.storage.bucket == document["runtime"]["storage"]["bucket"]
    for secret in (
        document["runtime"]["storage"]["secret_access_key"],
        document["runtime"]["storage"]["session_token"],
        document["runtime"]["media"]["livekit_room_token"],
    ):
        assert secret in spec.secrets

    built = assemble(
        spec,
        blobs=FilesystemBlobStore(tmp_path),
        speech=replace(SCRIPTED_PAIR, use_environment_proxy=True),
        media=NoReading(),  # type: ignore[arg-type]
    )
    assert built.conductor is not None
    plug = built.conductor._connection
    assert isinstance(plug, DailyRoomVoice)
    assert not any(isinstance(value, NoReading) for value in vars(plug).values())


def test_the_hosted_recording_store_is_the_claims_storage(tmp_path: Path):
    spec = SimulationSpec.from_document(hosted_document())
    standing = FilesystemBlobStore(tmp_path / "standing")
    claimed_config, claimed_blobs = resources_for_claim(
        standing_config(tmp_path), spec, standing
    )

    assert isinstance(claimed_blobs, S3BlobStore)
    assert spec.runtime is not None
    storage = spec.runtime.storage
    assert claimed_blobs._bucket == storage.bucket
    assert claimed_blobs._client.meta.endpoint_url == storage.endpoint
    assert claimed_blobs._client.meta.region_name == storage.region
    assert isinstance(claimed_config.media, MediaSettings)


@pytest.fixture
async def fake_proxy() -> Any:
    """An HTTP proxy that records every request it is sent."""
    seen: list[str] = []

    async def record(request: web.Request) -> web.Response:
        seen.append(f"{request.method} {request.raw_path}")
        return web.Response(status=502)

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", record)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", seen
    finally:
        await runner.cleanup()


def _proxied(monkeypatch: pytest.MonkeyPatch, proxy_url: str) -> None:
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(name, proxy_url)
        monkeypatch.setenv(name.lower(), proxy_url)
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")


async def test_the_start_request_goes_direct_through_the_address_guard(
    monkeypatch: pytest.MonkeyPatch, fake_proxy: Any
):
    proxy_url, proxied = fake_proxy
    _proxied(monkeypatch, proxy_url)
    asked: list[str] = []
    connected: list[str] = []

    class PublicResolver:
        async def resolve(
            self, host: str, port: int = 0, family: int = socket.AF_INET
        ) -> list[dict[str, Any]]:
            asked.append(host)
            return [
                {
                    "hostname": host,
                    "host": PUBLIC_ADDRESS,
                    "port": port,
                    "family": socket.AF_INET,
                    "proto": socket.IPPROTO_TCP,
                    "flags": socket.AI_NUMERICHOST,
                }
            ]

        async def close(self) -> None:
            return None

    real_socket = socket.socket

    class RecordingSocket(real_socket):  # type: ignore[misc, valid-type]
        def connect(self, address: Any) -> None:
            connected.append(address[0])
            raise OSError("stopped before leaving the machine")

        def connect_ex(self, address: Any) -> int:
            connected.append(address[0])
            raise OSError("stopped before leaving the machine")

    monkeypatch.setattr(socket, "socket", RecordingSocket)
    starter = PipecatStarter(
        StartSettings.from_connection(
            "daily_room.self_hosted",
            {"startUrl": f"https://{START_HOST}/start"},
            {"headers": json.dumps({"Authorization": "Bearer SENTINEL"})},
        ),
        simulation_id="sim_hosted_direct",
        body_params=None,
        max_duration_seconds=600,
        secrets=SecretRegistry(),
        endpoint_resolver=PublicResolver(),
    )
    with pytest.raises(MediaBackendError):
        await starter.start(deadline=asyncio.get_running_loop().time() + 5)

    assert asked == [START_HOST], "the start host was resolved, not the proxy"
    assert connected and set(connected) == {PUBLIC_ADDRESS}, connected
    assert proxied == [], "nothing reached the proxy"


async def test_the_start_request_reaches_the_starter_with_a_proxy_configured(
    monkeypatch: pytest.MonkeyPatch, fake_proxy: Any
):
    from test_daily_room_start import LocalStarter

    proxy_url, proxied = fake_proxy
    _proxied(monkeypatch, proxy_url)
    with starting(Answer()) as served:
        starter = LocalStarter(
            replace(
                StartSettings.from_connection(
                    "daily_room.pipecat_cloud",
                    {"agentName": "lakeside-front-desk"},
                    {"publicApiKey": "pk_hosted0probe0key"},
                ),
                start_url=served.wire_url,
            ),
            simulation_id="sim_hosted_direct",
            body_params=None,
            max_duration_seconds=600,
            secrets=SecretRegistry(),
        )
        way_in = await starter.start(deadline=asyncio.get_running_loop().time() + 5)

    assert way_in.room_url == A_ROOM
    assert len(served.asked) == 1
    assert proxied == []
