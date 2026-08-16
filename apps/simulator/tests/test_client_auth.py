"""How the simulator says who it is on the way out — and nowhere else.

The simulator dials out and is never dialled into, so the only place it
can prove it is allowed to claim work is on its own requests. A configured
service token rides every one of them as a bearer — the same header an
Egma key uses everywhere else — and no token means no header at all, which
is what the workbench and every local run want.

A real server on loopback reads the headers back, because what is under
test is what actually goes on the wire. The last test runs a real
simulator process against a control plane that quotes the request it
refused, which is the one way a configured token could reach a log line.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace

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

    async def traces(request: web.Request) -> web.Response:
        offered.append(request.headers.get("Authorization"))
        return web.json_response({})

    app = web.Application()
    app.router.add_post("/v1/claims", claim)
    app.router.add_post("/v1/simulations/{simulation_id}/heartbeats", heartbeat)
    app.router.add_post("/v1/simulations/{simulation_id}/reports", report)
    app.router.add_post("/v1/traces", traces)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", offered
    finally:
        await runner.cleanup()


async def _make_every_call(client: ControlPlaneClient) -> None:
    await client.claim("sim-under-test", 1)
    await client.heartbeat("sim-1", "sim-under-test")
    await client.report("sim-1", b"{}")
    await client.spans("sim-1", b'{"resourceSpans":[]}')


async def test_a_service_token_rides_every_outbound_call(listening_control_plane):
    base_url, offered = listening_control_plane

    async with ControlPlaneClient(
        base_url, claim_wait_seconds=1, service_token="egma_service_token_under_test"
    ) as client:
        await _make_every_call(client)

    assert offered == ["Bearer egma_service_token_under_test"] * 4


async def test_no_token_means_no_header(listening_control_plane):
    """The workbench asks for nothing, and gets nothing, rather than "Bearer "."""
    base_url, offered = listening_control_plane

    async with ControlPlaneClient(base_url, claim_wait_seconds=1) as client:
        await _make_every_call(client)

    assert offered == [None] * 4


# -- And nowhere else --------------------------------------------------------

A_TOKEN = "egma_service_token_that_must_never_be_logged"


@pytest.fixture
async def quoting_control_plane() -> AsyncIterator[str]:
    """Refuses every claim by quoting the request back — a plain 400 shape.

    This is not a contrived leak. A control plane that says what it could
    not parse is being helpful, and the claim loop logs the refusal's text
    to say why work is not arriving. Between those two ordinary behaviors
    the bearer ends up inside a log line, unless something put it in the
    redacting filter first.
    """

    async def refuse(request: web.Request) -> web.Response:
        return web.Response(
            status=400,
            text=f"cannot read this claim, sent with headers {dict(request.headers)}",
        )

    app = web.Application()
    app.router.add_post("/v1/claims", refuse)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


async def test_a_configured_service_token_never_reaches_a_log_line(
    quoting_control_plane, start_simulator
):
    """The token is registered at start-up, so no log line can carry it.

    A spec's credentials are registered when the spec is claimed. A
    service token arrives before any of that — it is configuration — so
    only start-up can hand it over, and nothing else in the suite walks
    that path. A real process, its real output, and a control plane doing
    the one ordinary thing that would expose it.
    """
    simulator = start_simulator(
        SimpleNamespace(base_url=quoting_control_plane),
        extra_env={"EGMA_SIMULATOR_SERVICE_TOKEN": A_TOKEN},
    )

    output = ""
    deadline = asyncio.get_running_loop().time() + 30.0
    while "claim did not land" not in output:
        if asyncio.get_running_loop().time() > deadline:
            pytest.fail(f"the refusal was never logged; output was:\n{output}")
        await asyncio.sleep(0.05)
        output = simulator.output()
    simulator.stop()
    output = simulator.output()

    # The line that would have carried it is there, and quotes the header
    # it was sent with — so this is the leak happening, scrubbed.
    assert "Authorization" in output, "the control plane's quote did not arrive"
    assert A_TOKEN not in output, "a log line carried the service token"
    assert "Bearer [redacted]" in output
