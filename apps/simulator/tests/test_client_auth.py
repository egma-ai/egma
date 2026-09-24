"""Verify the Daytona proxy path for control-plane calls, and redaction when a
server echoes the request in a refusal to a real simulator process.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from aiohttp import web

from egma_simulator.client import ControlPlaneClient


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
