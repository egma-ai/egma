"""Reporting: events minted as they happen, delivered in order, at least once.

One ``Reporter`` serves one simulation. Every event is stamped and
serialized at the moment it happens; the serialized bytes are appended to a
local write-ahead log and then posted to the control plane by a single
sender task, so delivery is ordered and a resend replays byte-identical
documents — ids and timestamps included, which is what lets the control
plane dedup on event ids. The report schema is applied to every document
before it is logged or sent: an invalid report is a bug in this process,
and it fails here, loudly, rather than at the receiver.

A document that will not go through is resent, same bytes, with widening
backoff until a deadline. Past that the reporter is *abandoned*: it stops
trying, and the log on disk is the only record of what this simulation
saw. That is bounded rather than endless on purpose — retrying forever
would hold a capacity slot open through an outage of any length, and a
simulator the control plane cannot hear is exactly what its heartbeat
sweep exists to notice.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from .client import ControlPlaneClient, ReportRejected, TransientReportFailure
from .contract import validate_report

logger = logging.getLogger(__name__)

# Delivery retries for as long as a control plane could plausibly be
# restarting, then stops. Bounded on purpose: retrying forever would hold a
# simulation's capacity slot open through an outage of any length, and the
# control plane already has an honest answer for a simulator gone quiet —
# the heartbeat sweep. The write-ahead log keeps the bytes either way.
DELIVERY_DEADLINE_SECONDS = 120.0
FIRST_BACKOFF_SECONDS = 0.2
MAX_BACKOFF_SECONDS = 5.0

_UNSAFE_IN_A_FILENAME = re.compile(r"[^A-Za-z0-9._-]")
_READABLE_PREFIX_LIMIT = 64


def moment() -> str:
    """An instant, RFC 3339 UTC, in the contract fixtures' exact shape."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def wal_filename(simulation_id: str) -> str:
    """A log filename for one simulation that cannot leave its directory.

    The contract calls ``simulation_id`` opaque — never parsed, never
    rewritten — and the reports honor that to the byte. A filename is a
    different thing: an id carrying a path separator or ``..`` would put
    the log somewhere nobody configured, so the name is *derived* rather
    than used. Sanitizing to one flat component is what confines it; the
    digest of the whole id is what keeps two simulations whose ids sanitize
    alike from sharing one file.
    """
    digest = hashlib.sha256(simulation_id.encode()).hexdigest()[:16]
    readable = _UNSAFE_IN_A_FILENAME.sub("_", simulation_id)[:_READABLE_PREFIX_LIMIT]
    return f"{readable}-{digest}.jsonl"


class Reporter:
    """Mints, logs, and delivers one simulation's report events, in order."""

    def __init__(
        self,
        client: ControlPlaneClient,
        simulation_id: str,
        wal_dir: Path,
        *,
        delivery_deadline_seconds: float = DELIVERY_DEADLINE_SECONDS,
    ) -> None:
        self._client = client
        self.simulation_id = simulation_id
        self._wal_dir = wal_dir
        self._wal_path = wal_dir / wal_filename(simulation_id)
        self._delivery_deadline_seconds = delivery_deadline_seconds
        self._sequence = 0
        self.turn_count = 0
        self.started_at: str | None = None
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._sender: asyncio.Task | None = None
        self.abandoned = False
        """Set once delivery has given up; from then on the WAL is the record."""

    def _mint_event_id(self) -> str:
        self._sequence += 1
        return f"evt-{self._sequence:06d}"

    def _enqueue(self, event: dict) -> None:
        document = {
            "contract_version": 1,
            "simulation_id": self.simulation_id,
            "events": [event],
        }
        validate_report(document)
        serialized = json.dumps(document, separators=(",", ":")).encode()
        self._append_to_wal(serialized)
        if self._sender is None:
            self._sender = asyncio.create_task(
                self._send_in_order(), name=f"reporter:{self.simulation_id}"
            )
        self._queue.put_nowait(serialized)

    def _append_to_wal(self, serialized: bytes) -> None:
        # The filename is one flat component by construction, so this only
        # ever creates the configured directory itself.
        self._wal_dir.mkdir(parents=True, exist_ok=True)
        with open(self._wal_path, "ab") as wal:
            wal.write(serialized + b"\n")

    async def _send_in_order(self) -> None:
        while True:
            serialized = await self._queue.get()
            try:
                if not self.abandoned:
                    await self._deliver(serialized)
            finally:
                self._queue.task_done()

    async def _deliver(self, serialized: bytes) -> None:
        """Send one document, resending the same bytes until it lands or time is up."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._delivery_deadline_seconds
        backoff = FIRST_BACKOFF_SECONDS
        attempt = 0
        while True:
            attempt += 1
            try:
                await self._client.report(self.simulation_id, serialized)
                if attempt > 1:
                    logger.info(
                        "a report for %s landed on attempt %d",
                        self.simulation_id,
                        attempt,
                    )
                return
            except ReportRejected as refusal:
                # The control plane refused the document outright. Resending
                # the same bytes cannot succeed; the WAL holds the record.
                logger.error(
                    "control plane refused a report for %s: %s",
                    self.simulation_id,
                    refusal,
                )
                return
            except TransientReportFailure as failure:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    # Ordered delivery is over for this simulation: sending
                    # what comes next would report it out of order, and the
                    # control plane cannot be reached to receive it anyway.
                    self.abandoned = True
                    logger.error(
                        "gave up delivering reports for %s after %d attempt(s) "
                        "over %.0fs (%s); the events are in %s, and a simulator "
                        "the control plane cannot hear is what its heartbeat "
                        "sweep is for",
                        self.simulation_id,
                        attempt,
                        self._delivery_deadline_seconds,
                        failure,
                        self._wal_path,
                    )
                    return
                await asyncio.sleep(min(backoff, remaining))
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    async def drain(self) -> None:
        """Wait until every event minted so far has been delivered or given up."""
        await self._queue.join()

    async def close(self) -> None:
        await self.drain()
        if self._sender is not None:
            self._sender.cancel()
            try:
                await self._sender
            except asyncio.CancelledError:
                pass
            self._sender = None

    # -- The events themselves ------------------------------------------------

    def running(self, reason: str | None = None) -> None:
        self.started_at = moment()
        self._enqueue(
            {
                "kind": "status",
                "event_id": self._mint_event_id(),
                "at": self.started_at,
                "status": "running",
                "reason": reason,
            }
        )

    def turn(self, speaker: str, text: str, started_at: str) -> None:
        self.turn_count += 1
        self._enqueue(
            {
                "kind": "turn",
                "event_id": self._mint_event_id(),
                "speaker": speaker,
                "text": text,
                "started_at": started_at,
                "ended_at": None,
            }
        )

    def timing(self, measure: str, milliseconds: float) -> None:
        self._enqueue(
            {
                "kind": "timing",
                "event_id": self._mint_event_id(),
                "at": moment(),
                "measure": measure,
                "milliseconds": milliseconds,
            }
        )

    def _terminal_facts(self, ending: str) -> dict:
        return {
            "ending": ending,
            "started_at": self.started_at,
            "ended_at": moment(),
            "turn_count": self.turn_count,
            "audio": None,
            "provider_reference": None,
        }

    def completed(self, ending: str, reason: str | None = None) -> None:
        self._enqueue(
            {
                "kind": "status",
                "event_id": self._mint_event_id(),
                "at": moment(),
                "status": "completed",
                "reason": reason,
                "facts": self._terminal_facts(ending),
            }
        )

    def failed(self, ending: str, reason: str) -> None:
        self._enqueue(
            {
                "kind": "status",
                "event_id": self._mint_event_id(),
                "at": moment(),
                "status": "failed",
                "reason": reason,
                "facts": self._terminal_facts(ending),
            }
        )

    def canceled(self, reason: str | None = None) -> None:
        self._enqueue(
            {
                "kind": "status",
                "event_id": self._mint_event_id(),
                "at": moment(),
                "status": "canceled",
                "reason": reason,
                "facts": self._terminal_facts("canceled"),
            }
        )
