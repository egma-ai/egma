"""Process-level checks for bounded voice workers and standing chat workers."""

from __future__ import annotations

import asyncio
import time

from conftest import loopback_spec, scripted_spec


def terminal(simulation_id: str):
    def seen(records: list[dict]) -> bool:
        return any(
            record.get("kind") == "report"
            and record.get("simulation_id") == simulation_id
            and record.get("event", {}).get("status")
            in ("completed", "failed", "canceled")
            for record in records
        )

    return seen


async def wait_for_exit(simulator, within_seconds: float) -> int:
    return await asyncio.to_thread(simulator.process.wait, timeout=within_seconds)


async def test_one_shot_claims_voice_once_and_exits(workbench, start_simulator):
    await workbench.offer(scripted_spec("sim-chat-left-queued"))
    await workbench.offer(
        loopback_spec(
            "sim-one-shot-voice",
            greeting="Hello.",
            max_turns=2,
        )
    )

    simulator = start_simulator(
        workbench,
        capacity=1,
        extra_env={
            "EGMA_SIMULATOR_MODE": "one-shot",
            "EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS": "5",
            "EGMA_SIMULATOR_THREAD_POOL_WORKERS": "1",
        },
    )
    records = await workbench.wait_for(terminal("sim-one-shot-voice"))

    assert await wait_for_exit(simulator, 5) == 0
    [claim] = [record for record in records if record["kind"] == "claim"]
    assert claim["modalities"] == ["voice"]
    assert claim["granted"] == ["sim-one-shot-voice"]


async def test_one_shot_exits_after_one_empty_claim(workbench, start_simulator):
    simulator = start_simulator(
        workbench,
        capacity=1,
        extra_env={"EGMA_SIMULATOR_MODE": "one-shot"},
    )

    assert await wait_for_exit(simulator, 5) == 0
    records = await workbench.records()
    claims = [record for record in records if record["kind"] == "claim"]
    assert len(claims) == 1
    assert claims[0]["granted"] == []


async def test_persistent_chat_at_capacity_fifty_serves_successive_work(
    workbench, start_simulator
):
    await workbench.offer(
        scripted_spec("sim-standing-chat-one", turn_seconds=0.15, max_turns=2)
    )
    simulator = start_simulator(
        workbench,
        capacity=50,
        extra_env={
            "EGMA_SIMULATOR_MODE": "persistent",
            "EGMA_SIMULATOR_MODALITIES": "chat",
            "EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS": "0.2",
        },
    )
    await workbench.wait_for(terminal("sim-standing-chat-one"))
    await workbench.offer(
        scripted_spec("sim-standing-chat-two", turn_seconds=0.15, max_turns=2)
    )
    records = await workbench.wait_for(terminal("sim-standing-chat-two"))

    assert simulator.process.poll() is None
    claims = [record for record in records if record["kind"] == "claim"]
    assert claims[0]["capacity"] == 50
    assert all(claim["modalities"] == ["chat"] for claim in claims)


async def test_the_os_deadline_exits_while_report_upload_is_blocked(
    blocked_reporting_workbench, start_simulator
):
    await blocked_reporting_workbench.offer(
        loopback_spec("sim-blocked-report", greeting="Hello.", max_turns=2)
    )
    began = time.monotonic()
    simulator = start_simulator(
        blocked_reporting_workbench,
        capacity=1,
        extra_env={
            "EGMA_SIMULATOR_MODE": "one-shot",
            "EGMA_SIMULATOR_EXECUTION_DEADLINE_SECONDS": "0.5",
            "EGMA_SIMULATOR_REPORT_DEADLINE_SECONDS": "30",
        },
    )

    assert await wait_for_exit(simulator, 5) == 124
    assert time.monotonic() - began < 3
