"""The simulator registers its room before opening it to the agent."""

from collections.abc import AsyncIterator

import pytest
from aiohttp import web

from egma_simulator.client import ControlPlaneClient, DocumentRejected


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
    url, _ = registration_server
    async with ControlPlaneClient(
        url, claim_wait_seconds=1, service_token="service-secret"
    ) as client:
        with pytest.raises(DocumentRejected, match="409"):
            await client.register_provider_reference(
                "not-my-claim", "worker-a", "egma-sim-room-a"
            )
