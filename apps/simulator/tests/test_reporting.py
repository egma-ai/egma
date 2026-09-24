"""The reporter: order, at-least-once delivery, byte-identical resends, WAL."""

from __future__ import annotations

import asyncio
import json

import pytest

from egma_simulator.client import TransientDeliveryFailure
from egma_simulator.contract import ContractViolation
from egma_simulator.reporting import Reporter, wal_filename
from egma_simulator.spans import SpanEmitter


class FakeClient:
    """Receives both kinds of post; can be told to fail transiently, or forever."""

    def __init__(self) -> None:
        self.delivered: list[bytes] = []
        self.attempts: list[bytes] = []
        self.doors: list[str] = []
        """Which door each delivered document went to, in order."""
        self.failures_left = 0
        self.unreachable = False

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        await self._post("report", serialized)

    async def spans(self, simulation_id: str, serialized: bytes) -> None:
        await self._post("spans", serialized)

    async def _post(self, door: str, serialized: bytes) -> None:
        self.attempts.append(serialized)
        if self.unreachable:
            raise TransientDeliveryFailure("nothing is listening")
        if self.failures_left > 0:
            self.failures_left -= 1
            raise TransientDeliveryFailure("told to fail")
        self.delivered.append(serialized)
        self.doors.append(door)


async def test_events_arrive_in_order_with_the_wal_written_first(tmp_path):
    client = FakeClient()
    reporter = Reporter(client, "sim-rep-1", tmp_path)

    reporter.running()
    # What the lifecycle keeps about the conversation: the count, tallied by
    # whoever watched it happen. The turns themselves are spans.
    reporter.turn_count = 2
    reporter.execution_ended()
    reporter.completed("persona_concluded")
    await reporter.close()

    kinds = [json.loads(document)["events"][0]["kind"] for document in client.delivered]
    assert kinds == ["status", "status"]

    event_ids = [
        json.loads(document)["events"][0]["event_id"] for document in client.delivered
    ]
    assert event_ids == [f"evt-{n:06d}" for n in range(1, 3)]

    wal_lines = (tmp_path / wal_filename("sim-rep-1")).read_bytes().splitlines()
    assert wal_lines == client.delivered

    terminal = json.loads(client.delivered[-1])["events"][0]
    assert terminal["facts"]["turn_count"] == 2
    assert "evidence_error" not in terminal["facts"]
    assert (
        terminal["facts"]["started_at"]
        == json.loads(client.delivered[0])["events"][0]["at"]
    )


async def test_a_transient_failure_resends_the_same_bytes(tmp_path):
    client = FakeClient()
    client.failures_left = 2
    reporter = Reporter(client, "sim-rep-2", tmp_path)

    reporter.running()
    await reporter.close()

    assert len(client.attempts) == 3
    assert len(set(client.attempts)) == 1, "a resend changed the document"
    assert client.delivered == [client.attempts[0]]


async def test_a_report_that_violates_the_contract_never_leaves(tmp_path):
    client = FakeClient()
    reporter = Reporter(client, "sim-rep-4", tmp_path)
    reporter.running()
    with pytest.raises(ContractViolation):
        reporter.execution_ended()
        reporter.completed("hung_up_on")
    await reporter.close()

    # The running report went; the ending nothing in the contract names did
    # not, and nothing about it reached the log either.
    kinds = [
        json.loads(document)["events"][0]["status"] for document in client.delivered
    ]
    assert kinds == ["running"]
    wal_lines = (tmp_path / wal_filename("sim-rep-4")).read_bytes().splitlines()
    assert wal_lines == client.delivered


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

    spans = SpanEmitter("sim-rep-6", flush=reporter.spans)
    reporter.running()
    spans.opened()
    spans.turn("human", "Hello.")
    spans.flush()
    reporter.execution_ended()
    reporter.completed("persona_concluded")

    # close() returns rather than waiting out an outage of unknown length.
    await asyncio.wait_for(reporter.close(), timeout=20)

    assert reporter.abandoned is True
    assert client.delivered == []
    assert len(client.attempts) > 1, "it gave up without retrying"

    # Once abandoned, later documents are not attempted out of order — but
    # every one of them is still on disk, in the order it happened, both
    # kinds together.
    wal_lines = (tmp_path / wal_filename("sim-rep-6")).read_bytes().splitlines()
    assert [
        "spans" if "resourceSpans" in json.loads(line) else "report"
        for line in wal_lines
    ] == ["report", "spans", "report"]
    assert json.loads(wal_lines[-1])["events"][0]["status"] == "completed"


# -- The one ordered sender, carrying both kinds ---------------------------


async def test_the_terminal_report_leaves_after_every_span_batch(tmp_path):
    """The guarantee the whole design leans on: when the control plane
    lands a terminal transition, the evidence is already stored."""
    client = FakeClient()
    reporter = Reporter(client, "sim-order-2", tmp_path)
    spans = SpanEmitter("sim-order-2", flush=reporter.spans)

    reporter.running()
    spans.opened()
    for turn in range(5):
        spans.turn("human", f"Turn {turn}.")
        spans.measure("turn_response_latency", 40.0)
        spans.turn("agent", f"Answer {turn}.")
        spans.flush()
    spans.sealed()
    reporter.execution_ended()
    reporter.completed("persona_concluded")
    await reporter.close()

    last_span_batch = max(
        position for position, door in enumerate(client.doors) if door == "spans"
    )
    terminal = json.loads(client.delivered[-1])["events"][0]
    assert terminal["status"] == "completed"
    assert last_span_batch < len(client.doors) - 1, (
        "a span batch left after the terminal report"
    )

    # And every span the conversation authored is on the wire, root included.
    names = [
        span["name"]
        for position, document in enumerate(client.delivered)
        if client.doors[position] == "spans"
        for span in json.loads(document)["resourceSpans"][0]["scopeSpans"][0]["spans"]
    ]
    assert names[-1] == "simulation"
    assert names.count("human_turn") == 5
    assert names.count("agent_turn") == 5


async def test_a_refused_span_batch_marks_the_terminal_report(tmp_path):
    """A reachable lifecycle door receives the ending and evidence failure."""

    class RefusingClient(FakeClient):
        async def spans(self, simulation_id: str, serialized: bytes) -> None:
            from egma_simulator.client import DocumentRejected

            self.attempts.append(serialized)
            raise DocumentRejected("400: a resource in this export names no simulation")

    client = RefusingClient()
    reporter = Reporter(client, "sim-order-4", tmp_path)
    spans = SpanEmitter("sim-order-4", flush=reporter.spans)

    reporter.running()
    spans.opened()
    spans.turn("agent", "Lakeside Dental.")
    spans.flush()
    await reporter.drain()
    reporter.execution_ended()
    reporter.completed("persona_concluded")
    await reporter.close()

    assert reporter.abandoned is False
    assert client.doors == ["report", "report"]
    terminal = json.loads(client.delivered[-1])["events"][0]
    assert terminal["status"] == "completed"
    assert terminal["facts"]["evidence_error"] == "evidence_collection_error"
    wal_lines = (tmp_path / wal_filename("sim-order-4")).read_bytes().splitlines()
    assert [
        "spans" if "resourceSpans" in json.loads(line) else "report"
        for line in wal_lines
    ] == ["report", "spans", "report"]
