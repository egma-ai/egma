"""Reporting: everything minted as it happens, delivered in order, at least once.

One ``Reporter`` serves one simulation and carries two kinds of document
to the control plane: the lifecycle report events, and the conversation
itself as OTLP span batches. Both are stamped and serialized at the moment
they happen; the serialized bytes are appended to a local write-ahead log
and then posted by a single sender task, so delivery is ordered and a
resend replays byte-identical documents — ids and timestamps included,
which lets the control plane dedup report event ids and ClickHouse suppress a
recent exact repeat of an insert block. The report schema is applied to every report
document before it is logged or sent: an invalid report is a bug in this
process, and it fails here, loudly, rather than at the receiver.

**One queue for both kinds, and that is the design rather than a saving.**
Because span batches and lifecycle documents share the one ordered sender,
the terminal report leaves only after every span batch minted before it
landed. So when the control plane records a simulation terminal, the
evidence a grader will read is already in the trace store — there is no
window in which a conversation is finished and its transcript is still in
flight.

The log on disk holds both, interleaved in the order the events happened,
each line exactly the bytes that went on the wire. The two kinds are told
apart by their own shape — a report names its ``contract_version``, a span
batch its ``resourceSpans`` — because a log line that was not what was
sent would not be a record of what was sent.

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
from enum import Enum
from pathlib import Path

from .client import ControlPlaneClient, DocumentRejected, TransientDeliveryFailure
from .contract import validate_report
from .platform_logging import log_event

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


class Destination(Enum):
    """Which door one queued document is bound for.

    The queue carries the pair rather than the bytes alone, because one
    ordered sender serving two doors has to know which it is knocking on —
    and knowing it here, at the moment the document was minted, is what
    keeps the ordering between them a property of when things happened
    rather than of how they were routed.
    """

    REPORT = "report"
    SPANS = "spans"


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
        """How many transcript turns the conversation reached, both speakers
        counted, kept by whoever is watching it happen. A summary fact rather
        than the conversation itself — the turns are spans, and a count of
        them is one number about the whole simulation, which is why it rides
        the terminal transition instead of being asked of the trace store."""
        self.started_at: str | None = None
        self._queue: asyncio.Queue[tuple[Destination, bytes]] = asyncio.Queue()
        self._sender: asyncio.Task | None = None
        self.abandoned = False
        """Set once delivery has given up; from then on the WAL is the record."""
        self.provider_reference: str | None = None
        """The platform's own identifier for the exchange, once the plug
        offers one; rides the terminal facts."""
        self.audio: dict | None = None
        """The recording reference for a voice simulation; ``None`` for a
        chat simulation, which has no simulator recording."""
        self.mock_tool_coverage: dict | None = None
        """Which of the agent's tools mock tools answered for, and which
        ran their own implementations.

        The one terminal fact that may be left out, and ``None`` is how it
        is left out: absent means the agent was never asked what tools it
        has, so nothing was learned and nothing is claimed — the honest
        reading of every connection egma stands outside the tool path of.
        Present with three empty lists is a different sentence: the asking
        happened and no tool came back."""

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
        self._log_and_queue(Destination.REPORT, document)

    def spans(self, serialized: bytes) -> None:
        """Take one span batch into the same log and the same ordered queue.

        This is the whole of what makes the ordering guarantee true: a
        batch handed over here is ahead of every document minted after it,
        the terminal report included. The OpenTelemetry SDK has already
        serialized these bytes. They are logged and retried without being
        decoded or changed.
        """
        self._log_serialized_and_queue(Destination.SPANS, serialized)

    def _log_and_queue(self, destination: Destination, document: dict) -> None:
        serialized = json.dumps(document, separators=(",", ":")).encode()
        self._log_serialized_and_queue(destination, serialized)

    def _log_serialized_and_queue(
        self, destination: Destination, serialized: bytes
    ) -> None:
        self._append_to_wal(serialized)
        if self._sender is None:
            self._sender = asyncio.create_task(
                self._send_in_order(), name=f"reporter:{self.simulation_id}"
            )
        self._queue.put_nowait((destination, serialized))

    def _append_to_wal(self, serialized: bytes) -> None:
        # The filename is one flat component by construction, so this only
        # ever creates the configured directory itself.
        self._wal_dir.mkdir(parents=True, exist_ok=True)
        with open(self._wal_path, "ab") as wal:
            wal.write(serialized + b"\n")

    async def _send_in_order(self) -> None:
        while True:
            destination, serialized = await self._queue.get()
            try:
                if not self.abandoned:
                    await self._deliver(destination, serialized)
            except asyncio.CancelledError:
                raise
            except Exception:
                # This task is the queue's only consumer, and nothing
                # restarts it. Letting anything unexpected end it would
                # leave every later event with no one to take it: the
                # queue's join() would never return, close() would hang,
                # and the simulation would hold its capacity slot for the
                # life of the process. Delivery is allowed to fail; the
                # sender is not allowed to die.
                self.abandoned = True
                log_event(
                    logger,
                    logging.ERROR,
                    "egma.simulation.report_failed",
                    "simulation report sender failed",
                    attributes={
                        "egma.report_abandoned": True,
                        "error.type": "unexpected_exception",
                    },
                    exc_info=True,
                )
            finally:
                self._queue.task_done()

    async def _deliver(self, destination: Destination, serialized: bytes) -> None:
        """Send one document, resending the same bytes until it lands or time is up."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._delivery_deadline_seconds
        backoff = FIRST_BACKOFF_SECONDS
        attempt = 0
        send = (
            self._client.report
            if destination is Destination.REPORT
            else self._client.spans
        )
        while True:
            attempt += 1
            try:
                await send(self.simulation_id, serialized)
                if attempt > 1:
                    log_event(
                        logger,
                        logging.INFO,
                        "egma.simulation.report_delivered",
                        "simulation document landed after a retry",
                        attributes={
                            "egma.document_type": destination.value,
                            "egma.attempt": attempt,
                        },
                    )
                return
            except DocumentRejected as refusal:
                # The control plane refused the document outright. Resending
                # the same bytes cannot succeed; the WAL holds the record. A
                # refused span export ends ordered delivery, because sending a
                # later terminal report would claim that incomplete evidence
                # had already landed.
                if destination is Destination.SPANS:
                    self.abandoned = True
                log_event(
                    logger,
                    logging.ERROR,
                    "egma.simulation.report_failed",
                    "control plane refused a simulation document",
                    attributes={
                        "egma.document_type": destination.value,
                        "egma.attempt": attempt,
                        "egma.report_abandoned": self.abandoned,
                        "error.type": type(refusal).__name__,
                    },
                )
                return
            except TransientDeliveryFailure as failure:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    # Ordered delivery is over for this simulation: sending
                    # what comes next would report it out of order, and the
                    # control plane cannot be reached to receive it anyway.
                    self.abandoned = True
                    log_event(
                        logger,
                        logging.ERROR,
                        "egma.simulation.report_failed",
                        "simulation document delivery deadline expired",
                        attributes={
                            "egma.document_type": destination.value,
                            "egma.attempt": attempt,
                            "egma.delivery_deadline_seconds": (
                                self._delivery_deadline_seconds
                            ),
                            "egma.report_abandoned": True,
                            "error.type": type(failure).__name__,
                        },
                    )
                    return
                await asyncio.sleep(min(backoff, remaining))
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

    async def drain(self) -> None:
        """Wait until everything minted so far has been delivered or given up."""
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

    def _terminal_facts(self, ending: str) -> dict:
        facts = {
            "ending": ending,
            "started_at": self.started_at,
            "ended_at": moment(),
            "turn_count": self.turn_count,
            "audio": self.audio,
            "provider_reference": self.provider_reference,
        }
        # Written only where there is something to say. Every other fact
        # here is required and carries `null` for absence; this one is
        # absent for absence, because "nobody ever asked" and "the asking
        # happened and nothing came back" are two different facts and a
        # single empty shape could only carry one of them.
        if self.mock_tool_coverage is not None:
            facts["mock_tool_coverage"] = self.mock_tool_coverage
        return facts

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
