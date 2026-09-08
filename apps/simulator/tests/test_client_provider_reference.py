"""The simulator registers its room before opening it to the agent."""

import asyncio
from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from egma_simulator.client import (
    ControlPlaneClient,
    DocumentRejected,
    TransientDeliveryFailure,
)


@pytest.fixture
async def registration_server() -> AsyncIterator[tuple[str, list[dict]]]:
    seen: list[dict] = []

    async def register(request: web.Request) -> web.Response:
        seen.append(
            {
                "body": await request.json(),
                "authorization": request.headers.get("Authorization"),
            }
        )
        if request.match_info["simulation_id"] == "not-my-claim":
            return web.json_response({"error": "claim refused"}, status=409)
        name = request.match_info["simulation_id"]
        if name == "always-503":
            return web.Response(status=503)
        if len(seen) == 1:
            if name.startswith("retry-"):
                return web.Response(status=int(name.removeprefix("retry-")))
            if name == "timeout-once":
                await asyncio.sleep(0.25)
        return web.json_response({"simulation_id": request.match_info["simulation_id"]})

    app = web.Application()
    app.router.add_post("/v1/simulations/{simulation_id}/provider-reference", register)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", seen
    finally:
        await runner.cleanup()


async def test_room_registration_is_acknowledged_with_the_service_credential(
    registration_server,
):
    url, seen = registration_server
    async with ControlPlaneClient(
        url, claim_wait_seconds=1, service_token="service-secret"
    ) as client:
        await client.register_provider_reference("sim-a", "worker-a", "egma-sim-room-a")
    assert seen == [
        {
            "body": {"claimant": "worker-a", "provider_reference": "egma-sim-room-a"},
            "authorization": "Bearer service-secret",
        }
    ]


async def test_a_refused_registration_does_not_allow_the_caller_to_continue(
    registration_server,
):
    url, seen = registration_server
    async with ControlPlaneClient(
        url, claim_wait_seconds=1, service_token="service-secret"
    ) as client:
        with pytest.raises(DocumentRejected, match="409"):
            await client.register_provider_reference(
                "not-my-claim", "worker-a", "egma-sim-room-a"
            )
    assert len(seen) == 1, "a permanent refusal must not be retried"


@pytest.mark.parametrize("simulation_id", ["retry-429", "retry-500", "timeout-once"])
async def test_transient_registration_retries_the_same_association(
    registration_server, simulation_id: str
):
    from aiohttp import ClientTimeout

    url, seen = registration_server
    async with ControlPlaneClient(url, claim_wait_seconds=1) as client:
        if simulation_id == "timeout-once":
            client._brisk_timeout = ClientTimeout(total=0.1)
        await client.register_provider_reference(
            simulation_id, "worker-a", "egma-sim-room-a"
        )
    assert len(seen) == 2
    assert seen[0] == seen[1], "the retry must identify the same room and claimant"


async def test_transient_registration_exhausts_a_finite_retry_budget(
    registration_server,
):
    url, seen = registration_server
    async with ControlPlaneClient(url, claim_wait_seconds=1) as client:
        with pytest.raises(TransientDeliveryFailure, match="503"):
            await asyncio.wait_for(
                client.register_provider_reference("always-503", "worker-a", "room-a"),
                2,
            )
    assert len(seen) == 3


async def test_cancel_during_registration_retry_stops_before_another_attempt(
    registration_server, monkeypatch: pytest.MonkeyPatch
):
    url, seen = registration_server
    retrying = asyncio.Event()
    async with ControlPlaneClient(url, claim_wait_seconds=1) as client:
        post = client._post_document

        async def observe_retry(*args, **kwargs):
            try:
                return await post(*args, **kwargs)
            except TransientDeliveryFailure:
                retrying.set()
                raise

        monkeypatch.setattr(client, "_post_document", observe_retry)
        registering = asyncio.create_task(
            client.register_provider_reference("always-503", "worker-a", "room-a")
        )
        try:
            await asyncio.wait_for(retrying.wait(), 1)
            registering.cancel()
            with pytest.raises(asyncio.CancelledError):
                await registering
        finally:
            registering.cancel()
            await asyncio.gather(registering, return_exceptions=True)
    assert len(seen) == 1
