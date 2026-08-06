"""The reporter: order, at-least-once delivery, byte-identical resends, WAL."""

from __future__ import annotations

import asyncio
import json

import pytest

from egma_simulator.client import TransientReportFailure
from egma_simulator.contract import ContractViolation
from egma_simulator.reporting import Reporter, wal_filename


class FakeClient:
    """Receives report posts; can be told to fail transiently, or forever."""

    def __init__(self) -> None:
        self.delivered: list[bytes] = []
        self.attempts: list[bytes] = []
        self.failures_left = 0
        self.unreachable = False

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        self.attempts.append(serialized)
        if self.unreachable:
            raise TransientReportFailure("nothing is listening")
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

    wal_lines = (tmp_path / wal_filename("sim-rep-1")).read_bytes().splitlines()
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
    assert not (tmp_path / wal_filename("sim-rep-3")).exists()


async def test_a_report_that_violates_the_contract_never_leaves(tmp_path):
    client = FakeClient()
    reporter = Reporter(client, "sim-rep-4", tmp_path)
    with pytest.raises(ContractViolation):
        reporter.turn("narrator", "not a speaker", started_at="not a moment")
    await reporter.close()
    assert client.attempts == []
    assert not (tmp_path / wal_filename("sim-rep-4")).exists()


async def test_the_wal_stays_inside_its_directory_whatever_the_id_says(tmp_path):
    """A simulation_id is opaque; it never gets to choose where the log lands."""
    wal_dir = tmp_path / "wal"
    escaping = "../../../etc/egma-owned"

    client = FakeClient()
    reporter = Reporter(client, escaping, wal_dir)
    reporter.running()
    await reporter.close()

    written = list(wal_dir.iterdir())
    assert len(written) == 1
    log = written[0]
    assert log.parent == wal_dir
    assert log.read_bytes().strip() == client.delivered[0]

    # Nothing was created beside or above the configured directory.
    assert [path.name for path in tmp_path.iterdir()] == ["wal"]

    # And the id still travels to the control plane exactly as it arrived.
    assert json.loads(client.delivered[0])["simulation_id"] == escaping


def test_two_ids_that_sanitize_alike_still_get_their_own_logs():
    assert wal_filename("sim/one") != wal_filename("sim:one")
    assert "/" not in wal_filename("../../escape")
    assert wal_filename("sim_01K3XQ7M4E").startswith("sim_01K3XQ7M4E-")


async def test_delivery_resends_for_as_long_as_the_deadline_allows(
    tmp_path, quick_backoff
):
    """Many attempts, no fixed ceiling: a long blip must not lose a report."""
    client = FakeClient()
    client.failures_left = 40
    reporter = Reporter(client, "sim-rep-5", tmp_path, delivery_deadline_seconds=30)

    reporter.running()
    await reporter.close()

    assert len(client.attempts) == 41
    assert len(set(client.attempts)) == 1, "a resend changed the document"
    assert client.delivered == [client.attempts[0]]
    assert reporter.abandoned is False


async def test_an_unreachable_control_plane_is_given_up_on_without_hanging(
    tmp_path, quick_backoff
):
    """Bounded, not endless: the slot frees, and the WAL keeps every event."""
    client = FakeClient()
    client.unreachable = True
    reporter = Reporter(client, "sim-rep-6", tmp_path, delivery_deadline_seconds=0.5)

    reporter.running()
    reporter.turn("human", "Hello.", started_at="2026-08-05T09:00:00.000000Z")
    reporter.completed("persona_concluded")

    # close() returns rather than waiting out an outage of unknown length.
    await asyncio.wait_for(reporter.close(), timeout=20)

    assert reporter.abandoned is True
    assert client.delivered == []
    assert len(client.attempts) > 1, "it gave up without retrying"

    # Once abandoned, later events are not attempted out of order — but
    # every one of them is still on disk, in the order it happened.
    wal_lines = (tmp_path / wal_filename("sim-rep-6")).read_bytes().splitlines()
    assert [json.loads(line)["events"][0]["kind"] for line in wal_lines] == [
        "status",
        "turn",
        "status",
    ]
    assert json.loads(wal_lines[-1])["events"][0]["status"] == "completed"
