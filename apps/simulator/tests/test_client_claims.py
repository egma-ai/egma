"""What a claim request says on the wire.

The claim is the one call whose body the control plane's hold depends on:
``wait_seconds`` says how long this simulator is willing to hang, so the
other end can hold the request open no longer than the client will wait.
A claim that kept that number to itself would make the control plane
guess — and a guess longer than the client's patience turns a quiet queue
into a spurious client-side timeout.

A real server on loopback reads the body back, because what is under test
is what actually goes on the wire.
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
        {"claimant": "sim-under-test", "capacity": 3, "wait_seconds": 7.0}
    ]
