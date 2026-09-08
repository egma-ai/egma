"""Read claim request bodies through a local HTTP server.
Require wait_seconds and the supported spec version so the control plane
can honor the client wait budget and reject incompatible workers.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from egma_simulator.client import ControlPlaneClient


@pytest.fixture
async def recording_control_plane() -> AsyncIterator[tuple[str, list[dict]]]:
    """Answers every claim with an empty queue and keeps every body it saw."""
    bodies: list[dict] = []

    async def claim(request: web.Request) -> web.Response:
        bodies.append(await request.json())
        return web.json_response({"specs": []})

    app = web.Application()
    app.router.add_post("/v1/claims", claim)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", bodies
    finally:
        await runner.cleanup()


async def test_a_claim_declares_how_long_it_will_wait(recording_control_plane):
    base_url, bodies = recording_control_plane

    async with ControlPlaneClient(base_url, claim_wait_seconds=7.0) as client:
        await client.claim("sim-under-test", 3)

    assert bodies == [
        {
            "claimant": "sim-under-test",
            "capacity": 3,
            "wait_seconds": 7.0,
            "contract_versions": [5],
        }
    ]


async def test_a_claim_can_select_a_modality_and_reads_the_server_claim_time():
    bodies: list[dict] = []

    async def claim(request: web.Request) -> web.Response:
        bodies.append(await request.json())
        return web.json_response(
            {
                "specs": [{"simulation_id": "sim-voice"}],
                "claimed_at": {"sim-voice": "2026-09-08T01:02:03.000Z"},
            }
        )

    app = web.Application()
    app.router.add_post("/v1/claims", claim)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        async with ControlPlaneClient(
            f"http://127.0.0.1:{runner.addresses[0][1]}",
            claim_wait_seconds=1,
        ) as client:
            [answer] = await client.claim("voice-one-shot", 1, ("voice",))
    finally:
        await runner.cleanup()

    assert bodies[0]["modalities"] == ["voice"]
    assert answer.document == {"simulation_id": "sim-voice"}
    assert answer.claimed_at.isoformat() == "2026-09-08T01:02:03+00:00"
