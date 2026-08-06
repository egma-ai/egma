"""What the simulator promises, proved black-box at the contract seam.

The workbench offers specs; a real simulator process claims, conducts,
heartbeats and reports; every assertion below reads only what the
workbench recorded. Nothing inspects the simulator — that is the point:
what the records show is all the control plane will ever know.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime

from conftest import (
    HEARTBEAT_SECONDS,
    all_terminal,
    chat_spec,
    events_for,
    has_terminal,
    heartbeats_for,
    status_events_for,
    terminal_event_for,
)


async def test_a_simulation_walks_the_whole_pipe(workbench, start_simulator):
    """Claim, heartbeat, running, turns, completed — in that order, on record."""
    spec = chat_spec("sim-walk-001")
    await workbench.offer(spec)
    start_simulator(workbench)

    records = await workbench.wait_for(has_terminal("sim-walk-001"))

    claims = [
        record
        for record in records
        if record["kind"] == "claim" and "sim-walk-001" in record["granted"]
    ]
    assert len(claims) == 1
    assert claims[0]["claimant"] == "sim-under-test"
    assert claims[0]["capacity"] >= 1

    assert len(heartbeats_for(records, "sim-walk-001")) >= 1

    statuses = status_events_for(records, "sim-walk-001")
    assert statuses[0] == "running"
    assert statuses[-1] == "completed"

    turns = events_for(records, "sim-walk-001", "turn")
    assert len(turns) >= 2
    assert turns[0]["speaker"] == "human"
    assert turns[1]["speaker"] == "agent"
    assert turns[1]["text"] == turns[0]["text"]

    terminal = terminal_event_for(records, "sim-walk-001")
    facts = terminal["facts"]
    assert facts["ending"] == "persona_concluded"
    assert facts["turn_count"] == len(turns)
    assert facts["audio"] is None
    started = datetime.fromisoformat(facts["started_at"])
    ended = datetime.fromisoformat(facts["ended_at"])
    assert ended >= started

    assert len(events_for(records, "sim-walk-001", "timing")) >= 1

    # The workbench refused nothing: every document the simulator sent
    # validated against the report schema.
    assert [record for record in records if record["kind"] == "refusal"] == []

    # And the record's own order tells the story: claimed before running,
    # running before any turn, every turn before completed.
    def first_seq(kind: str, status: str | None = None) -> int:
        for record in records:
            if record["kind"] == "report" and record["simulation_id"] == "sim-walk-001":
                event = record["event"]
                if event["kind"] == kind and (
                    status is None or event.get("status") == status
                ):
                    return record["seq"]
        raise AssertionError(f"no {kind}/{status} on record")

    claim_seq = claims[0]["seq"]
    assert claim_seq < first_seq("status", "running")
    assert first_seq("status", "running") < first_seq("turn")
    assert first_seq("turn") < first_seq("status", "completed")


async def test_a_cancel_directive_stops_a_simulation_mid_walk(
    workbench, start_simulator
):
    """The directive travels on a heartbeat answer; the simulation reports canceled."""
    spec = chat_spec(
        "sim-cancel-001",
        instructions=" ".join(f"Sentence number {n}." for n in range(1, 41)),
        max_turns=200,
        max_duration_seconds=600,
    )
    await workbench.offer(spec)
    start_simulator(workbench, pacing_seconds=0.15)

    await workbench.wait_for(
        lambda records: len(events_for(records, "sim-cancel-001", "turn")) >= 2
    )
    await workbench.cancel("sim-cancel-001")

    records = await workbench.wait_for(has_terminal("sim-cancel-001"))
    terminal = terminal_event_for(records, "sim-cancel-001")
    assert terminal["status"] == "canceled"
    assert terminal["facts"]["ending"] == "canceled"

    turns = events_for(records, "sim-cancel-001", "turn")
    assert len(turns) < 80, "the walk was not stopped"
    assert terminal["facts"]["turn_count"] == len(turns)
    assert "completed" not in status_events_for(records, "sim-cancel-001")

    # Nothing more is reported after the terminal event: the simulation is over.
    await asyncio.sleep(HEARTBEAT_SECONDS * 4)
    later = await workbench.records()
    assert len(events_for(later, "sim-cancel-001", "turn")) == len(turns)


async def test_capacity_caps_simulations_in_flight(workbench, start_simulator):
    """Capacity N, N+2 queued: never more than N between running and terminal."""
    simulation_ids = [f"sim-cap-{n:03d}" for n in range(4)]
    for simulation_id in simulation_ids:
        await workbench.offer(
            chat_spec(
                simulation_id,
                instructions="One. Two. Three. Four.",
                max_turns=200,
            )
        )
    start_simulator(workbench, capacity=2, pacing_seconds=0.1)

    records = await workbench.wait_for(
        all_terminal(simulation_ids), within_seconds=60
    )

    # Every claim declared at most the free capacity and was granted no more.
    for record in records:
        if record["kind"] == "claim":
            assert record["capacity"] <= 2
            assert len(record["granted"]) <= record["capacity"]

    # Replay the records in order, counting simulations between their
    # running report and their terminal report: never more than two.
    in_flight = 0
    most_seen = 0
    for record in records:
        if record["kind"] != "report" or record["event"]["kind"] != "status":
            continue
        status = record["event"]["status"]
        if status == "running":
            in_flight += 1
            most_seen = max(most_seen, in_flight)
        elif status in ("completed", "failed", "canceled"):
            in_flight -= 1
    assert most_seen == 2, f"expected 2 in flight at peak, saw {most_seen}"

    for simulation_id in simulation_ids:
        terminal = terminal_event_for(records, simulation_id)
        assert terminal["status"] == "completed", simulation_id


async def test_a_killed_simulator_just_stops_heartbeating(
    workbench, start_simulator
):
    """SIGKILL mid-walk: heartbeats stop and nothing terminal is ever reported."""
    spec = chat_spec(
        "sim-kill-001",
        instructions=" ".join(f"Sentence number {n}." for n in range(1, 41)),
        max_turns=200,
        max_duration_seconds=600,
    )
    await workbench.offer(spec)
    simulator = start_simulator(workbench, pacing_seconds=0.15)

    await workbench.wait_for(
        lambda records: "running" in status_events_for(records, "sim-kill-001")
        and len(heartbeats_for(records, "sim-kill-001")) >= 1
    )
    simulator.kill_hard()

    # A beat already on the wire may still land; after that grace, silence.
    # Only heartbeats and reports prove a live simulator — the workbench
    # answering a claim it was already holding open is its own act.
    def spoken_by_the_simulator(records: list[dict]) -> list[dict]:
        return [
            record
            for record in records
            if record["kind"] in ("heartbeat", "report", "refusal")
        ]

    await asyncio.sleep(HEARTBEAT_SECONDS * 2)
    settled = spoken_by_the_simulator(await workbench.records())
    await asyncio.sleep(HEARTBEAT_SECONDS * 5)
    afterwards = spoken_by_the_simulator(await workbench.records())

    assert afterwards == settled, "a dead simulator kept talking"
    assert terminal_event_for(await workbench.records(), "sim-kill-001") is None, (
        "a killed simulator reported a terminal state it could not know"
    )


async def test_an_over_granting_control_plane_does_not_take_the_simulator_down(
    over_granting_workbench, start_simulator
):
    """The runtime's own cap, with the workbench's clamping out of the way.

    A well-behaved control plane never hands out more than was asked for,
    which is exactly why the capacity test above cannot prove this: it is
    the workbench's arithmetic holding the line there, not the simulator's.
    Here the workbench over-grants on purpose.
    """
    workbench = over_granting_workbench
    accepted = [f"sim-flood-{n:03d}" for n in range(2)]
    for n in range(6):
        await workbench.offer(
            chat_spec(f"sim-flood-{n:03d}", instructions="One. Two.", max_turns=200)
        )
    start_simulator(workbench, capacity=2, pacing_seconds=0.1)

    records = await workbench.wait_for(all_terminal(accepted), within_seconds=60)

    # It survived: the two it could hold ran to completion.
    for simulation_id in accepted:
        assert terminal_event_for(records, simulation_id)["status"] == "completed"

    # And it never exceeded its own capacity, whatever it was handed.
    in_flight = 0
    most_seen = 0
    for record in records:
        if record["kind"] != "report" or record["event"]["kind"] != "status":
            continue
        if record["event"]["status"] == "running":
            in_flight += 1
            most_seen = max(most_seen, in_flight)
        elif record["event"]["status"] in ("completed", "failed", "canceled"):
            in_flight -= 1
    assert most_seen <= 2, f"the runtime overloaded: {most_seen} in flight"

    # It is still alive and still claiming after the bad answer.
    claims_before = len([r for r in records if r["kind"] == "claim"])
    await asyncio.sleep(HEARTBEAT_SECONDS * 5)
    later = await workbench.records()
    assert len([r for r in later if r["kind"] == "claim"]) > claims_before


async def test_credentials_never_appear_in_logs_or_reports(
    workbench, start_simulator
):
    """A sentinel credential goes in; no byte of output or record carries it."""
    sentinel = "SENTINEL-do-not-log-4f9c2b7e8a1d"
    spec = chat_spec("sim-secret-001", api_key=sentinel)
    await workbench.offer(spec)
    simulator = start_simulator(workbench, log_level="DEBUG")

    records = await workbench.wait_for(has_terminal("sim-secret-001"))
    terminal = terminal_event_for(records, "sim-secret-001")
    assert terminal["status"] == "completed"

    simulator.stop()

    everything_recorded = json.dumps(records)
    assert sentinel not in everything_recorded, "a report carried the credential"

    output = simulator.output()
    assert output, "expected the simulator to have logged something"
    assert sentinel not in output, "a log line carried the credential"

    wal_bytes = b"".join(
        path.read_bytes() for path in simulator.wal_dir.glob("*.jsonl")
    )
    assert wal_bytes, "expected write-ahead log entries"
    assert sentinel.encode() not in wal_bytes, "the WAL carried the credential"
