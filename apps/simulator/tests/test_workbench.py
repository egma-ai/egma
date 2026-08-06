"""The workbench itself: it speaks the contract and records everything."""

from __future__ import annotations

import asyncio
import json

import aiohttp
from conftest import scripted_spec


async def test_a_claim_waits_and_is_answered_the_moment_a_spec_arrives(workbench):
    async with aiohttp.ClientSession() as session:

        async def claim() -> dict:
            async with session.post(
                f"{workbench.base_url}/v1/claims",
                json={"claimant": "test", "capacity": 5},
            ) as response:
                assert response.status == 200
                return await response.json()

        # An empty queue holds the request open, then answers with nothing.
        answer = await claim()
        assert answer == {"specs": []}

        # A spec arriving mid-hold is granted without waiting out the hold.
        pending = asyncio.create_task(claim())
        await asyncio.sleep(0.1)
        await workbench.offer(scripted_spec("sim-wb-arrival"))
        answer = await asyncio.wait_for(pending, timeout=2)
        assert [spec["simulation_id"] for spec in answer["specs"]] == [
            "sim-wb-arrival"
        ]


async def test_a_claim_never_grants_more_than_the_declared_capacity(workbench):
    for n in range(3):
        await workbench.offer(scripted_spec(f"sim-wb-cap-{n}"))
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/v1/claims",
            json={"claimant": "test", "capacity": 2},
        ) as response:
            granted = [
                spec["simulation_id"] for spec in (await response.json())["specs"]
            ]
    assert granted == ["sim-wb-cap-0", "sim-wb-cap-1"]


async def test_the_workbench_refuses_a_spec_that_breaks_the_contract(workbench):
    broken = scripted_spec("sim-wb-broken")
    del broken["limits"]
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/workbench/specs", json=broken
        ) as response:
            assert response.status == 400
            assert "limits" in await response.text()


async def test_offering_the_same_simulation_twice_is_refused(workbench):
    await workbench.offer(scripted_spec("sim-wb-dup"))
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/workbench/specs", json=scripted_spec("sim-wb-dup")
        ) as response:
            assert response.status == 409


async def test_an_invalid_report_is_refused_and_the_refusal_is_a_record(workbench):
    await workbench.offer(scripted_spec("sim-wb-refuse"))
    async with aiohttp.ClientSession() as session:
        await session.post(
            f"{workbench.base_url}/v1/claims",
            json={"claimant": "test", "capacity": 1},
        )
        smuggling = {
            "contract_version": 1,
            "simulation_id": "sim-wb-refuse",
            "credentials": {"apiKey": "smuggled"},
            "events": [
                {
                    "kind": "status",
                    "event_id": "evt-000001",
                    "at": "2026-08-05T09:00:00.000000Z",
                    "status": "running",
                    "reason": None,
                }
            ],
        }
        async with session.post(
            f"{workbench.base_url}/v1/simulations/sim-wb-refuse/reports",
            data=json.dumps(smuggling).encode(),
            headers={"content-type": "application/json"},
        ) as response:
            assert response.status == 400

    records = await workbench.records()
    refusals = [record for record in records if record["kind"] == "refusal"]
    assert len(refusals) == 1
    assert refusals[0]["why"] == "contract violation"
    assert [record for record in records if record["kind"] == "report"] == []


async def test_a_report_for_an_unknown_simulation_is_not_found(workbench):
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/v1/simulations/sim-wb-ghost/reports",
            data=b"{}",
            headers={"content-type": "application/json"},
        ) as response:
            assert response.status == 404


async def test_a_cancel_directive_rides_the_next_heartbeat_answer(workbench):
    await workbench.offer(scripted_spec("sim-wb-cancel"))
    async with aiohttp.ClientSession() as session:
        await session.post(
            f"{workbench.base_url}/v1/claims",
            json={"claimant": "test", "capacity": 1},
        )

        async def beat() -> str | None:
            async with session.post(
                f"{workbench.base_url}/v1/simulations/sim-wb-cancel/heartbeats",
                json={"claimant": "test"},
            ) as response:
                assert response.status == 200
                return (await response.json())["directive"]

        assert await beat() is None
        await workbench.cancel("sim-wb-cancel")
        assert await beat() == "cancel"
