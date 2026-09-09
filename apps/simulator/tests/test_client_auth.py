"""Verify service-token bearer headers on real local HTTP requests.
Without a token, omit Authorization. Also check redaction when a server
echoes the request in a refusal to a real simulator process.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from aiohttp import web

from egma_simulator.client import ControlPlaneClient


@pytest.fixture
async def listening_control_plane() -> AsyncIterator[
    tuple[str, list[str | None], list[str | None]]
]:
    """Answers everything agreeably and keeps the client identity it saw."""
    offered: list[str | None] = []
    user_agents: list[str | None] = []

    def record(request: web.Request) -> None:
        offered.append(request.headers.get("Authorization"))
        user_agents.append(request.headers.get("User-Agent"))

    async def claim(request: web.Request) -> web.Response:
        record(request)
        return web.json_response({"specs": []})

    async def heartbeat(request: web.Request) -> web.Response:
        record(request)
        return web.json_response({"directive": None})

    async def report(request: web.Request) -> web.Response:
        record(request)
        return web.Response(status=204)

    async def traces(request: web.Request) -> web.Response:
        record(request)
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
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", offered, user_agents
    finally:
        await runner.cleanup()


async def _make_every_call(client: ControlPlaneClient) -> None:
    await client.claim("sim-under-test", 1)
    await client.heartbeat("sim-1", "sim-under-test")
    await client.report("sim-1", b"{}")
    await client.spans("sim-1", b'{"resourceSpans":[]}')


async def test_client_identity_rides_every_outbound_call(listening_control_plane):
    base_url, offered, user_agents = listening_control_plane

    async with ControlPlaneClient(
        base_url, claim_wait_seconds=1, service_token="egma_service_token_under_test"
    ) as client:
        await _make_every_call(client)

    assert offered == ["Bearer egma_service_token_under_test"] * 4
    assert user_agents == ["egma-simulator/0.0.0"] * 4


async def test_no_token_means_no_header(listening_control_plane):
    """The workbench asks for nothing, and gets nothing, rather than "Bearer "."""
    base_url, offered, _ = listening_control_plane

    async with ControlPlaneClient(base_url, claim_wait_seconds=1) as client:
        await _make_every_call(client)

    assert offered == [None] * 4


async def test_control_plane_calls_use_the_environment_proxy(monkeypatch):
    """Daytona's proxy can replace its mounted secret placeholder."""
    requests: list[tuple[str, str | None]] = []

    async def proxy(request: web.Request) -> web.Response:
        requests.append((request.raw_path, request.headers.get("Authorization")))
        return web.json_response({"specs": []})

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", proxy)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    proxy_url = f"http://127.0.0.1:{runner.addresses[0][1]}"
    monkeypatch.setenv("HTTP_PROXY", proxy_url)
    monkeypatch.setenv("http_proxy", proxy_url)
    monkeypatch.setenv("NO_PROXY", "")
    monkeypatch.setenv("no_proxy", "")

    try:
        async with ControlPlaneClient(
            "http://control-plane.invalid",
            claim_wait_seconds=1,
            service_token="dtn_secret_under_test",
            runtime="daytona",
        ) as client:
            await client.claim("sim-under-test", 1)
    finally:
        await runner.cleanup()

    assert requests == [
        (
            "http://control-plane.invalid/v1/claims",
            "Bearer dtn_secret_under_test",
        )
    ]


# -- And nowhere else --------------------------------------------------------

A_TOKEN = "egma_service_token_that_must_never_be_logged"


@pytest.fixture
async def quoting_control_plane() -> AsyncIterator[str]:
    """Refuses every claim by quoting the request back — a plain 400 shape.

    This is not a contrived leak. A control plane that says what it could
    not parse is being helpful. The simulator must not copy that arbitrary
    response into its platform log.
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
    """A refusal body that quotes the token is not copied into a log line.

    The stable event is useful without storing arbitrary text returned by
    the control plane. The registry is still the last defense for every
    other log source.
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

    assert "claim did not land" in output
    assert "Authorization" not in output
    assert A_TOKEN not in output, "a log line carried the service token"
    assert "Bearer" not in output
