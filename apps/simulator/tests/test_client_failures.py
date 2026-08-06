"""The client against a control plane that misbehaves.

Every call the simulator makes is wrapped so that the loops above it see a
declared failure and can decide what it means. The one that used to escape
was the timeout: aiohttp raises a bare ``TimeoutError`` for its total
timeout, and that is an ``OSError``, not an ``aiohttp.ClientError``. An
untranslated timeout is not a nuisance — it ends the claim loop, the
heartbeat, or the report sender, none of which are written to expect it.

These tests use a real server that answers too slowly, because the failure
lives in aiohttp's own machinery and a fake exception would prove nothing.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from egma_simulator.client import (
    ClaimFailure,
    ControlPlaneClient,
    HeartbeatFailure,
    ReportRejected,
    TransientReportFailure,
)


@pytest.fixture
async def stalling_control_plane() -> AsyncIterator[str]:
    """Answers nothing, slowly — the shape a wedged control plane has."""

    async def stall(_request: web.Request) -> web.Response:
        # Comfortably longer than the shrunk timeouts below, and short
        # enough that shutting the server down does not wait on it.
        await asyncio.sleep(1.0)
        return web.json_response({})

    app = web.Application()
    app.router.add_post("/v1/claims", stall)
    app.router.add_post("/v1/simulations/{simulation_id}/heartbeats", stall)
    app.router.add_post("/v1/simulations/{simulation_id}/reports", stall)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


@pytest.fixture
def impatient(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink both timeouts so "too slow" arrives in a quarter of a second."""
    from egma_simulator import client as client_module

    monkeypatch.setattr(client_module, "CLAIM_TIMEOUT_MARGIN_SECONDS", 0.25)
    monkeypatch.setattr(client_module, "BRISK_TIMEOUT_SECONDS", 0.25)


async def test_a_slow_claim_is_a_claim_failure_not_a_bare_timeout(
    stalling_control_plane, impatient
):
    async with ControlPlaneClient(
        stalling_control_plane, claim_wait_seconds=0.01
    ) as client:
        with pytest.raises(ClaimFailure):
            await client.claim("test", 1)


async def test_a_slow_heartbeat_is_a_heartbeat_failure(
    stalling_control_plane, impatient
):
    async with ControlPlaneClient(
        stalling_control_plane, claim_wait_seconds=1
    ) as client:
        with pytest.raises(HeartbeatFailure):
            await client.heartbeat("sim-1", "test")


async def test_a_slow_report_is_a_transient_failure(
    stalling_control_plane, impatient
):
    async with ControlPlaneClient(
        stalling_control_plane, claim_wait_seconds=1
    ) as client:
        with pytest.raises(TransientReportFailure):
            await client.report("sim-1", b"{}")


async def test_nothing_reachable_at_all_is_still_a_declared_failure():
    """A closed port, the other way a control plane is absent."""
    nowhere = "http://127.0.0.1:1"
    async with ControlPlaneClient(nowhere, claim_wait_seconds=0.5) as client:
        with pytest.raises(ClaimFailure):
            await client.claim("test", 1)
        with pytest.raises(HeartbeatFailure):
            await client.heartbeat("sim-1", "test")
        with pytest.raises(TransientReportFailure):
            await client.report("sim-1", b"{}")


async def test_the_two_four_hundreds_that_mean_try_again_are_transient():
    """408 and 429 say "not now"; every other 4xx says "not ever"."""

    async def answer(request: web.Request) -> web.Response:
        return web.Response(status=int(request.match_info["simulation_id"]))

    app = web.Application()
    app.router.add_post("/v1/simulations/{simulation_id}/reports", answer)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    try:
        async with ControlPlaneClient(base, claim_wait_seconds=1) as client:
            for status in ("408", "429", "503"):
                with pytest.raises(TransientReportFailure):
                    await client.report(status, b"{}")
            for status in ("400", "404", "422"):
                with pytest.raises(ReportRejected):
                    await client.report(status, b"{}")
    finally:
        await runner.cleanup()
