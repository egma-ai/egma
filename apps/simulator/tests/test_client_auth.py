"""How the simulator says who it is on the way out.

The simulator dials out and is never dialled into, so the only place it
can prove it is allowed to claim work is on its own requests. A configured
service token rides every one of them as a bearer — the same header an
egma key uses everywhere else — and no token means no header at all, which
is what the workbench and every local run want.

A real server on loopback reads the headers back, because what is under
test is what actually goes on the wire.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from egma_simulator.client import ControlPlaneClient


@pytest.fixture
async def listening_control_plane() -> AsyncIterator[tuple[str, list[str | None]]]:
    """Answers everything agreeably and keeps every ``Authorization`` it saw."""
    offered: list[str | None] = []

    async def claim(request: web.Request) -> web.Response:
        offered.append(request.headers.get("Authorization"))
        return web.json_response({"specs": []})

    async def heartbeat(request: web.Request) -> web.Response:
        offered.append(request.headers.get("Authorization"))
        return web.json_response({"directive": None})

    async def report(request: web.Request) -> web.Response:
        offered.append(request.headers.get("Authorization"))
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/v1/claims", claim)
    app.router.add_post("/v1/simulations/{simulation_id}/heartbeats", heartbeat)
    app.router.add_post("/v1/simulations/{simulation_id}/reports", report)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", offered
    finally:
        await runner.cleanup()


async def _make_all_three_calls(client: ControlPlaneClient) -> None:
    await client.claim("sim-under-test", 1)
    await client.heartbeat("sim-1", "sim-under-test")
    await client.report("sim-1", b"{}")


async def test_a_service_token_rides_every_outbound_call(listening_control_plane):
    base_url, offered = listening_control_plane

    async with ControlPlaneClient(
        base_url, claim_wait_seconds=1, service_token="egma_service_token_under_test"
    ) as client:
        await _make_all_three_calls(client)

    assert offered == ["Bearer egma_service_token_under_test"] * 3


async def test_no_token_means_no_header(listening_control_plane):
    """The workbench asks for nothing, and gets nothing, rather than "Bearer "."""
    base_url, offered = listening_control_plane

    async with ControlPlaneClient(base_url, claim_wait_seconds=1) as client:
        await _make_all_three_calls(client)

    assert offered == [None] * 3
