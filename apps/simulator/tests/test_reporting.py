"""The reporter: order, at-least-once delivery, byte-identical resends, WAL."""

from __future__ import annotations

import json

import pytest

from egma_simulator.client import TransientReportFailure
from egma_simulator.contract import ContractViolation
from egma_simulator.reporting import Reporter


class FakeClient:
    """Receives report posts; can be told to fail the next few transiently."""

    def __init__(self) -> None:
        self.delivered: list[bytes] = []
        self.attempts: list[bytes] = []
        self.failures_left = 0

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        self.attempts.append(serialized)
        if self.failures_left > 0:
            self.failures_left -= 1
            raise TransientReportFailure("told to fail")
        self.delivered.append(serialized)


async def test_events_arrive_in_order_with_the_wal_written_first(tmp_path):
    client = FakeClient()
    reporter = Reporter(client, "sim-rep-1", tmp_path)

    reporter.running()
    reporter.turn("human", "Hello.", started_at="2026-08-05T09:00:00.000000Z")
    reporter.turn("agent", "Hello.", started_at="2026-08-05T09:00:00.100000Z")
    reporter.timing("first_response_latency", 100)
    reporter.completed("persona_concluded")
    await reporter.close()

    kinds = [
        json.loads(document)["events"][0]["kind"] for document in client.delivered
    ]
    assert kinds == ["status", "turn", "turn", "timing", "status"]

    event_ids = [
        json.loads(document)["events"][0]["event_id"]
        for document in client.delivered
    ]
    assert event_ids == [f"evt-{n:06d}" for n in range(1, 6)]

    wal_lines = (tmp_path / "sim-rep-1.jsonl").read_bytes().splitlines()
    assert wal_lines == client.delivered

    terminal = json.loads(client.delivered[-1])["events"][0]
    assert terminal["facts"]["turn_count"] == 2
    assert terminal["facts"]["started_at"] == json.loads(client.delivered[0])[
        "events"
    ][0]["at"]


async def test_a_transient_failure_resends_the_same_bytes(tmp_path):
    client = FakeClient()
    client.failures_left = 2
    reporter = Reporter(client, "sim-rep-2", tmp_path)

    reporter.running()
    await reporter.close()

    assert len(client.attempts) == 3
    assert len(set(client.attempts)) == 1, "a resend changed the document"
    assert client.delivered == [client.attempts[0]]


async def test_a_terminal_report_before_running_is_a_loud_bug(tmp_path):
    reporter = Reporter(FakeClient(), "sim-rep-3", tmp_path)
    with pytest.raises(ContractViolation):
        reporter.completed("persona_concluded")
    assert not (tmp_path / "sim-rep-3.jsonl").exists()


async def test_a_report_that_violates_the_contract_never_leaves(tmp_path):
    client = FakeClient()
    reporter = Reporter(client, "sim-rep-4", tmp_path)
    with pytest.raises(ContractViolation):
        reporter.turn("narrator", "not a speaker", started_at="not a moment")
    await reporter.close()
    assert client.attempts == []
    assert not (tmp_path / "sim-rep-4.jsonl").exists()
