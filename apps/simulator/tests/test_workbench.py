"""The workbench itself: it speaks the contract and records everything."""

from __future__ import annotations

import asyncio
import json

import aiohttp
from conftest import scripted_spec, spans_for

from egma_simulator.spans import SIMULATION_ID_ATTRIBUTE


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
        assert [spec["simulation_id"] for spec in answer["specs"]] == ["sim-wb-arrival"]


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


async def test_a_report_carrying_a_conversation_is_refused_at_the_report_door(
    workbench,
):
    """The two doors carry two records, and the contract keeps them apart.

    A turn is a span. A report that carried one would be a second copy of
    the conversation, free to disagree with the first — so the report
    schema does not merely ignore the kind, it refuses the document, and
    the workbench refuses it exactly where the real report door does.
    """
    await workbench.offer(scripted_spec("sim-wb-turn"))
    async with aiohttp.ClientSession() as session:
        await session.post(
            f"{workbench.base_url}/v1/claims",
            json={"claimant": "test", "capacity": 1},
        )
        carrying = {
            "contract_version": 1,
            "simulation_id": "sim-wb-turn",
            "events": [
                {
                    "kind": "turn",
                    "event_id": "evt-000002",
                    "speaker": "agent",
                    "text": "Lakeside Dental, how can I help?",
                    "started_at": "2026-08-05T09:00:01.214000Z",
                    "ended_at": None,
                }
            ],
        }
        async with session.post(
            f"{workbench.base_url}/v1/simulations/sim-wb-turn/reports",
            data=json.dumps(carrying).encode(),
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


# -- The OTLP sink, so the developer's rig stays whole ---------------------


def a_batch(simulation_id: str, *spans: dict) -> dict:
    """One OTLP export the way the emitter writes it."""
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {
                            "key": "service.name",
                            "value": {"stringValue": "egma-simulator"},
                        },
                        *(
                            [
                                {
                                    "key": SIMULATION_ID_ATTRIBUTE,
                                    "value": {"stringValue": simulation_id},
                                }
                            ]
                            if simulation_id
                            else []
                        ),
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": "egma-simulator", "version": "1"},
                        "spans": list(spans),
                    }
                ],
            }
        ]
    }


def a_span(name: str, **extra: object) -> dict:
    return {
        "traceId": "0198fb73d08e479627eea08a75fbf1d8",
        "spanId": "aa10000000000002",
        "name": name,
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1785920401214000000",
        "endTimeUnixNano": "1785920401214000000",
        **extra,
    }


async def post_spans(workbench, document: dict) -> tuple[int, str]:
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/v1/traces",
            data=json.dumps(document),
            headers={"content-type": "application/json"},
        ) as response:
            return response.status, await response.text()


async def test_the_sink_records_arriving_spans_against_their_simulation(workbench):
    await workbench.offer(scripted_spec("sim-wb-spans"))

    status, body = await post_spans(
        workbench,
        a_batch(
            "sim-wb-spans",
            a_span("human_turn"),
            a_span("turn_response_latency"),
        ),
    )

    assert status == 200
    assert json.loads(body) == {}
    recorded = spans_for(await workbench.records(), "sim-wb-spans")
    assert [record["span"]["name"] for record in recorded] == [
        "human_turn",
        "turn_response_latency",
    ]
    # The scope rides along, because that is what the real ingest reads the
    # vocabulary by, and what a person watching the log wants to see.
    assert recorded[0]["scope"] == {"name": "egma-simulator", "version": "1"}


async def test_the_sink_tells_one_flush_from_the_next(workbench):
    await workbench.offer(scripted_spec("sim-wb-flushes"))

    await post_spans(workbench, a_batch("sim-wb-flushes", a_span("human_turn")))
    await post_spans(workbench, a_batch("sim-wb-flushes", a_span("agent_turn")))

    recorded = spans_for(await workbench.records(), "sim-wb-flushes")
    assert [record["flush"] for record in recorded] == [1, 2]


async def test_the_sink_refuses_a_batch_naming_no_simulation(workbench):
    """The one refusal the real ingest makes at the batch grain."""
    status, body = await post_spans(workbench, a_batch("", a_span("human_turn")))

    assert status == 400
    assert SIMULATION_ID_ATTRIBUTE in body
    refusals = [
        record for record in await workbench.records() if record["kind"] == "refusal"
    ]
    assert len(refusals) == 1
    assert refusals[0]["why"] == "spans naming no simulation"


async def test_the_sink_refuses_spans_for_a_simulation_it_never_offered(workbench):
    status, body = await post_spans(
        workbench, a_batch("sim-wb-stranger", a_span("human_turn"))
    )

    assert status == 400
    assert "sim-wb-stranger" in body
    assert spans_for(await workbench.records(), "sim-wb-stranger") == []


async def test_the_sink_refuses_a_body_that_is_not_an_otlp_export(workbench):
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{workbench.base_url}/v1/traces",
            data=b"not json at all",
            headers={"content-type": "application/json"},
        ) as response:
            assert response.status == 400
