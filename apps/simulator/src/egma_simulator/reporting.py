"""Reporting: events minted as they happen, delivered in order, at least once.

One ``Reporter`` serves one simulation. Every event is stamped and
serialized at the moment it happens; the serialized bytes are appended to a
local write-ahead log and then posted to the control plane by a single
sender task, so delivery is ordered and a resend replays byte-identical
documents — ids and timestamps included, which is what lets the control
plane dedup on event ids. The report schema is applied to every document
before it is logged or sent: an invalid report is a bug in this process,
and it fails here, loudly, rather than at the receiver.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from .client import ControlPlaneClient, ReportRejected, TransientReportFailure
from .contract import validate_report

logger = logging.getLogger(__name__)

SEND_ATTEMPTS = 5
BACKOFF_SECONDS = 0.2


def moment() -> str:
    """An instant, RFC 3339 UTC, in the contract fixtures' exact shape."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class Reporter:
    """Mints, logs, and delivers one simulation's report events, in order."""

    def __init__(
        self,
        client: ControlPlaneClient,
        simulation_id: str,
        wal_dir: Path,
    ) -> None:
        self._client = client
        self.simulation_id = simulation_id
        self._wal_path = wal_dir / f"{simulation_id}.jsonl"
        self._sequence = 0
        self.turn_count = 0
        self.started_at: str | None = None
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._sender: asyncio.Task | None = None

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
        self._wal_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._wal_path, "ab") as wal:
            wal.write(serialized + b"\n")

    async def _send_in_order(self) -> None:
        while True:
            serialized = await self._queue.get()
            try:
                await self._deliver(serialized)
            finally:
                self._queue.task_done()

    async def _deliver(self, serialized: bytes) -> None:
        for attempt in range(1, SEND_ATTEMPTS + 1):
            try:
                await self._client.report(self.simulation_id, serialized)
                return
            except ReportRejected as refusal:
                # The control plane refused the document outright. Retrying
                # the same bytes cannot succeed; the WAL holds the record.
                logger.error(
                    "control plane refused a report for %s: %s",
                    self.simulation_id,
                    refusal,
                )
                return
            except TransientReportFailure as failure:
                if attempt == SEND_ATTEMPTS:
                    logger.error(
                        "giving up on a report for %s after %d attempts: %s",
                        self.simulation_id,
                        attempt,
                        failure,
                    )
                    return
                await asyncio.sleep(BACKOFF_SECONDS * (2 ** (attempt - 1)))

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
