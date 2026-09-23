"""The simulator reads the SDK hello's arrival from the agent-report route.

The route path, request and every answer come from the shared seam fixture
(sdk-https-exchange.v1.json), so a change on the API side fails here too.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest
from aiohttp import web

from egma_simulator.client import (
    ControlPlaneClient,
    SimulationNotHeld,
    TransientDeliveryFailure,
)
from egma_simulator.contract import contract_dir
from egma_simulator.media.daily_room import AgentReport, hello_refused_failure

SEAM = json.loads(
    (Path(contract_dir()) / "fixtures/seam/sdk-https-exchange.v1.json").read_text()
)
REPORT = SEAM["agent_report"]
ROUTE = SEAM["routes"][REPORT["route"]]


@pytest.fixture
async def control_plane() -> AsyncIterator[tuple[str, dict[str, Any], list[dict]]]:
    """A control plane answering the agent-report route with a chosen fixture."""
    chosen: dict[str, Any] = {"answer": REPORT["waiting"]}
    seen: list[dict] = []

    async def report(request: web.Request) -> web.Response:
        seen.append(
            {
                "simulation_id": request.match_info["simulation_id"],
                "body": await request.json(),
                "authorization": request.headers.get("Authorization"),
            }
        )
        answer = chosen["answer"]
        return web.json_response(answer["response"], status=answer["status"])

    app = web.Application()
    app.router.add_post(ROUTE.replace("{simulation_id}", "{simulation_id}"), report)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}", chosen, seen
    finally:
        await runner.cleanup()


def test_the_fixture_names_the_route_the_simulator_polls():
    assert ROUTE == "/v1/simulations/{simulation_id}/agent-report"


@pytest.mark.parametrize(
    ("answer", "state"),
    [("waiting", "waiting"), ("accepted", "accepted"), ("refused", "refused")],
)
async def test_each_agent_report_answer_is_read(
    control_plane: Any, answer: str, state: str
):
    url, chosen, seen = control_plane
    chosen["answer"] = REPORT[answer]
    simulation_id = REPORT[answer]["response"]["simulation_id"]
    async with ControlPlaneClient(
        url, claim_wait_seconds=1, service_token="egma_st_service"
    ) as client:
        body = await client.agent_report(simulation_id, REPORT["request"]["claimant"])

    assert seen == [
        {
            "simulation_id": simulation_id,
            "body": REPORT["request"],
            "authorization": "Bearer egma_st_service",
        }
    ]
    report = AgentReport.from_answer(body)
    assert report.state == state
    if state == "refused":
        assert report.code == 905
        failure = hello_refused_failure(report.code, report.message or "")
        assert str(failure) == REPORT["refused"]["response"]["message"]


async def test_a_claim_that_no_longer_holds_the_simulation_is_named(
    control_plane: Any,
):
    url, chosen, _seen = control_plane
    chosen["answer"] = REPORT["not_the_claimant"]
    async with ControlPlaneClient(url, claim_wait_seconds=1) as client:
        with pytest.raises(SimulationNotHeld, match="does not hold"):
            await client.agent_report("sim_elsewhere", "egma-simulator-1")


async def test_an_unexpected_answer_is_transient(control_plane: Any):
    url, chosen, _seen = control_plane
    chosen["answer"] = {"status": 503, "response": {"error": "unavailable"}}
    async with ControlPlaneClient(url, claim_wait_seconds=1) as client:
        with pytest.raises(TransientDeliveryFailure, match="503"):
            await client.agent_report("sim_a", "egma-simulator-1")


def test_an_unknown_state_is_not_read_as_waiting():
    with pytest.raises(ValueError):
        AgentReport.from_answer({"simulation_id": "sim_a", "state": "maybe"})
