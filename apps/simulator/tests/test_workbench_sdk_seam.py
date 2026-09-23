"""The workbench's SDK seam stand-in answers the shared seam fixture's exchanges.

Every exchange in sdk-https-exchange.v1.json but the key check (the workbench
asks for no key) is replayed against a running workbench holding the fixture's
two worlds as claimed Daily room simulations; the agent report then reads what
the hellos recorded.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiohttp
import pytest

from egma_simulator.contract import contract_dir
from egma_simulator.workbench.app import WorkbenchState, build_app

SEAM = json.loads(
    (Path(contract_dir()) / "fixtures/seam/sdk-https-exchange.v1.json").read_text()
)
ROUTES = SEAM["routes"]
CLAIMANT = SEAM["agent_report"]["request"]["claimant"]
SKIPPED = {"unauthenticated"}


def spec_for(world: dict[str, Any]) -> dict[str, Any]:
    document = json.loads(
        (contract_dir() / "fixtures/spec/valid/voice-pipecat-cloud.json").read_text(
            encoding="utf-8"
        )
    )
    document["simulation_id"] = world["simulation_id"]
    document["mock_tools"] = [
        {
            "tool_name": entry["tool"],
            "answer": (
                {"error": entry["error"]}
                if "error" in entry
                else {"answer": entry["answer"]}
            ),
        }
        for entry in world["mock_tools"]
    ]
    return document


@pytest.fixture
async def workbench() -> AsyncIterator[tuple[str, aiohttp.ClientSession]]:
    from aiohttp import web

    state = WorkbenchState(hold_seconds=0.1)
    runner = web.AppRunner(build_app(state))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    base = f"http://127.0.0.1:{runner.addresses[0][1]}"
    async with aiohttp.ClientSession() as session:
        for world in SEAM["worlds"].values():
            await state.offer(spec_for(world))
        claimed = await state.claim(CLAIMANT, 5)
        assert len(claimed) == len(SEAM["worlds"])
        for world in SEAM["worlds"].values():
            simulation_id = world["simulation_id"]
            async with session.post(
                f"{base}/v1/simulations/{simulation_id}/provider-reference",
                json={"claimant": CLAIMANT, "provider_reference": simulation_id},
            ) as registered:
                assert registered.status == 200
        try:
            yield base, session
        finally:
            await runner.cleanup()


async def _post(session: aiohttp.ClientSession, url: str, body: Any) -> tuple[int, Any]:
    async with session.post(url, json=body) as answer:
        return answer.status, await answer.json()


async def _agent_report(
    session: aiohttp.ClientSession, base: str, simulation_id: str
) -> tuple[int, Any]:
    route = ROUTES["agent_report"].replace("{simulation_id}", simulation_id)
    return await _post(session, f"{base}{route}", {"claimant": CLAIMANT})


@pytest.mark.parametrize(
    "name", [name for name in SEAM["exchanges"] if name not in SKIPPED]
)
async def test_each_seam_exchange_is_answered_as_the_fixture_says(
    workbench: tuple[str, aiohttp.ClientSession], name: str
):
    base, session = workbench
    exchange = SEAM["exchanges"][name]
    if "request_is" in exchange:
        request = _pointed(exchange["request_is"])
        await _post(session, f"{base}{ROUTES['hello']}", request)
    else:
        request = exchange["request"]
    status, body = await _post(session, f"{base}{ROUTES[exchange['route']]}", request)

    assert status == exchange["status"]
    expected = (
        _pointed(exchange["response_is"])
        if "response_is" in exchange
        else exchange["response"]
    )
    assert body == expected


def _pointed(path: str) -> Any:
    """The fixture value a dotted path such as ``exchanges.hello.request`` names."""
    held: Any = SEAM
    for part in path.split("."):
        held = held[part]
    return held


async def test_the_agent_report_reads_what_the_hellos_recorded(
    workbench: tuple[str, aiohttp.ClientSession],
):
    base, session = workbench
    report = SEAM["agent_report"]
    calendar = SEAM["worlds"]["calendar"]["simulation_id"]
    flows = SEAM["worlds"]["flows"]["simulation_id"]

    assert await _agent_report(session, base, calendar) == (
        200,
        report["waiting"]["response"],
    )
    await _post(
        session, f"{base}{ROUTES['hello']}", SEAM["exchanges"]["hello"]["request"]
    )
    await _post(
        session,
        f"{base}{ROUTES['hello']}",
        SEAM["exchanges"]["hello_flows_mocked"]["request"],
    )

    status, accepted = await _agent_report(session, base, calendar)
    assert status == 200
    assert {**accepted, "at": None} == {**report["accepted"]["response"], "at": None}
    status, refused = await _agent_report(session, base, flows)
    assert status == 200
    assert {**refused, "at": None} == {**report["refused"]["response"], "at": None}

    status, conflict = await _post(
        session,
        f"{base}{ROUTES['agent_report'].replace('{simulation_id}', calendar)}",
        {"claimant": "somebody-else"},
    )
    assert (status, conflict) == (
        report["not_the_claimant"]["status"],
        report["not_the_claimant"]["response"],
    )
