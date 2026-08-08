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
        self.span_failures_left = 0
        """Refusals aimed at the ingest door alone, so a test can shake one
        kind of document without the other absorbing the failures."""
        self.unreachable = False

    async def report(self, simulation_id: str, serialized: bytes) -> None:
        await self._post("report", serialized)

    async def spans(self, simulation_id: str, serialized: bytes) -> None:
        if self.span_failures_left > 0:
            self.attempts.append(serialized)
            self.span_failures_left -= 1
            raise TransientDeliveryFailure("the ingest door was told to fail")
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


# -- The one ordered sender, carrying both kinds ---------------------------


async def test_spans_and_lifecycle_share_one_log_in_the_order_they_happened(
    tmp_path,
):
    """Interleaved, both on the wire and on disk, exactly as minted."""
    client = FakeClient()
    reporter = Reporter(client, "sim-order-1", tmp_path)
    spans = SpanEmitter("sim-order-1", flush=reporter.spans)

    reporter.running()
    spans.opened()
    spans.turn("agent", "Lakeside Dental.")
    spans.flush()
    reporter.turn("agent", "Lakeside Dental.", started_at="2026-08-05T09:00:00.000000Z")
    spans.turn("human", "Could we move my cleaning?")
    spans.flush()
    reporter.turn(
        "human", "Could we move my cleaning?", started_at="2026-08-05T09:00:01.000000Z"
    )
    spans.sealed()
    reporter.completed("persona_concluded")
    await reporter.close()

    assert client.doors == [
        "report",  # running
        "spans",  # the greeting
        "report",  # the greeting as a transcript turn
        "spans",  # the persona's turn
        "report",  # the same turn on the lifecycle side
        "spans",  # the closing flush, root last
        "report",  # completed, and only now
    ]

    # The log on disk is what was sent, line for line, in the same order.
    wal_lines = (tmp_path / wal_filename("sim-order-1")).read_bytes().splitlines()
    assert wal_lines == client.delivered


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


async def test_a_span_batch_that_will_not_land_is_resent_byte_identically(
    tmp_path, quick_backoff
):
    """Same bytes, ids included — which is what lets a store deduping on
    span ids land nothing twice however many times it hears this."""
    client = FakeClient()
    client.span_failures_left = 3
    reporter = Reporter(client, "sim-order-3", tmp_path)
    spans = SpanEmitter("sim-order-3", flush=reporter.spans)

    reporter.running()
    spans.opened()
    spans.turn("agent", "Lakeside Dental.")
    spans.flush()
    await reporter.close()

    # The running report landed first, then the batch was attempted four
    # times: three refusals and the one that got through.
    assert len(client.attempts) == 5
    batch_attempts = client.attempts[1:]
    assert len(set(batch_attempts)) == 1, "a resend changed the batch"
    assert client.delivered[-1] == batch_attempts[0]


async def test_a_refused_span_batch_costs_only_itself(tmp_path):
    """A 400 from the ingest is terminal for that document, exactly as a
    report rejection is — and the simulation carries on reporting."""

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
    reporter.completed("persona_concluded")
    await reporter.close()

    assert reporter.abandoned is False
    assert client.doors == ["report", "report"]
    assert json.loads(client.delivered[-1])["events"][0]["status"] == "completed"
