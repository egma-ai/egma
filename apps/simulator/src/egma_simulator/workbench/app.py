"""The workbench: a fake control plane that speaks the contract from fixtures.

Dev and test only. It serves the four endpoints the simulator dials —
claim, heartbeat, report, and the OTLP ingest the conversation's spans go
to — from spec documents loaded off disk, validates everything both ways
against the contract schemas, and records every observation in order. The
records are the whole point: the acceptance suite asserts against nothing
else, and a person watching the log watches a simulation go queued →
claimed → running → completed with its turns arriving as spans in between.

The two doors carry two different records and the contract is what keeps
them apart: a report says only where the simulation's lifecycle stands, so
the report schema accepts status transitions and refuses anything claiming
to carry a conversation, and the conversation arrives at the span sink.

The span sink is deliberately the smallest thing that can be called one: it
checks a batch parses and names a simulation this workbench knows, records
each span, and answers what the OTLP specification says to. It stores
nothing, indexes nothing and joins nothing — the real ingest does all of
that, and a second implementation of it here would be a second thing to
keep true.

The production claim API is the only real control path. This workbench stays a
local rig for simulator development and contract tests.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from aiohttp import web

from ..contract import ContractViolation, validate_report, validate_spec
from ..reporting import moment
from ..spans import SIMULATION_ID_ATTRIBUTE

logger = logging.getLogger(__name__)


class RefusedReport(Exception):
    """A report document the workbench refused, with the words it refused in."""


class RefusedSpans(Exception):
    """A span batch the workbench refused, with the words it refused in."""


class WorkbenchState:
    """The queue of specs, the cancel flags, and the record of everything."""

    def __init__(self, *, hold_seconds: float, over_grant: int = 0) -> None:
        self._hold_seconds = hold_seconds
        self._over_grant = over_grant
        """How many specs past the declared capacity a claim answers with.

        Zero is a well-behaved control plane. Anything else is the
        workbench misbehaving on purpose, so the simulator's own cap can be
        tested rather than the workbench's arithmetic standing in for it.
        """
        self._queued: dict[str, dict] = {}
        self._claimed: dict[str, dict] = {}
        self._cancel_flags: set[str] = set()
        self._arrival = asyncio.Condition()
        self.records: list[dict] = []
        self._flushes = 0
        """How many span batches have arrived. Stamped on every span
        recorded, so a suite can tell one flush from the next without
        having to reconstruct the grouping from what landed."""

    def _record(self, kind: str, **details: object) -> None:
        entry = {"seq": len(self.records), "at": moment(), "kind": kind, **details}
        self.records.append(entry)
        logger.info("%s", json.dumps(entry, separators=(",", ":")))

    async def offer(self, spec: dict) -> None:
        """Queue one spec — the workbench's stand-in for a trigger writing rows."""
        validate_spec(spec)
        simulation_id = spec["simulation_id"]
        if simulation_id in self._queued or simulation_id in self._claimed:
            raise ValueError(f"{simulation_id} is already offered")
        async with self._arrival:
            self._queued[simulation_id] = spec
            self._record("queued", simulation_id=simulation_id)
            self._arrival.notify_all()

    async def claim(self, claimant: str, capacity: int) -> list[dict]:
        """Up to ``capacity`` specs, holding the request open while the queue is dry."""
        deadline = asyncio.get_running_loop().time() + self._hold_seconds
        async with self._arrival:
            while True:
                granted = [
                    self._queued.pop(simulation_id)
                    for simulation_id in list(self._queued)[
                        : capacity + self._over_grant
                    ]
                ]
                if granted:
                    for spec in granted:
                        self._claimed[spec["simulation_id"]] = spec
                    self._record(
                        "claim",
                        claimant=claimant,
                        capacity=capacity,
                        granted=[spec["simulation_id"] for spec in granted],
                    )
                    return granted
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    self._record(
                        "claim", claimant=claimant, capacity=capacity, granted=[]
                    )
                    return []
                try:
                    await asyncio.wait_for(self._arrival.wait(), timeout=remaining)
                except TimeoutError:
                    continue

    def known(self, simulation_id: str) -> bool:
        return simulation_id in self._claimed or simulation_id in self._queued

    def heartbeat(self, simulation_id: str, claimant: str) -> str | None:
        directive = "cancel" if simulation_id in self._cancel_flags else None
        self._record(
            "heartbeat",
            simulation_id=simulation_id,
            claimant=claimant,
            directive=directive,
        )
        return directive

    def report(self, simulation_id: str, raw: bytes) -> None:
        """Validate and record one report document; refusals are records too."""
        body = raw.decode("utf-8", errors="replace")
        try:
            document = json.loads(body)
        except ValueError:
            self._record(
                "refusal", simulation_id=simulation_id, why="unparseable", raw=body
            )
            raise RefusedReport("not JSON") from None

        try:
            validate_report(document)
        except ContractViolation as violation:
            self._record(
                "refusal",
                simulation_id=simulation_id,
                why="contract violation",
                complaints=violation.complaints,
                raw=body,
            )
            raise RefusedReport("; ".join(violation.complaints)) from violation

        if document["simulation_id"] != simulation_id:
            self._record(
                "refusal",
                simulation_id=simulation_id,
                why="simulation_id mismatch",
                raw=body,
            )
            raise RefusedReport("simulation_id mismatch")

        for event in document["events"]:
            self._record("report", simulation_id=simulation_id, event=event, raw=body)

    def spans(self, raw: bytes) -> None:
        """Validate and record one OTLP span batch; refusals are records too.

        Two checks, which are the two the real ingest makes at the batch
        grain: it has to parse, and every resource in it has to name a
        simulation this deployment conducted. A batch that fails either is
        refused whole — there is nowhere honest to file part of it — and
        the refusal is a record like everything else.
        """
        body = raw.decode("utf-8", errors="replace")
        try:
            document = json.loads(body)
        except ValueError:
            self._record("refusal", why="spans unparseable", raw=body)
            raise RefusedSpans("not JSON") from None

        resources = (
            document.get("resourceSpans") if isinstance(document, dict) else None
        )
        if not isinstance(resources, list) or not resources:
            self._record("refusal", why="not an OTLP export", raw=body)
            raise RefusedSpans("no resourceSpans")

        self._flushes += 1
        for resource in resources:
            simulation_id = _simulation_named_by(resource)
            if simulation_id is None:
                self._record("refusal", why="spans naming no simulation", raw=body)
                raise RefusedSpans(
                    f"a resource carries no {SIMULATION_ID_ATTRIBUTE} attribute"
                )
            if not self.known(simulation_id):
                self._record(
                    "refusal",
                    simulation_id=simulation_id,
                    why="spans for an unknown simulation",
                    raw=body,
                )
                raise RefusedSpans(f"no simulation {simulation_id} was ever offered")
            for scope in resource.get("scopeSpans", []):
                for span in scope.get("spans", []):
                    self._record(
                        "span",
                        simulation_id=simulation_id,
                        flush=self._flushes,
                        scope=scope.get("scope", {}),
                        span=span,
                    )

    def cancel(self, simulation_id: str) -> None:
        self._cancel_flags.add(simulation_id)
        self._record("cancel_directive", simulation_id=simulation_id)


def build_app(state: WorkbenchState) -> web.Application:
    """The workbench's HTTP face: the contract seam plus its own controls."""

    async def claim(request: web.Request) -> web.Response:
        body = await request.json()
        claimant = body.get("claimant")
        capacity = body.get("capacity")
        if not isinstance(claimant, str) or not claimant:
            raise web.HTTPBadRequest(text="claimant must be a non-empty string")
        if not isinstance(capacity, int) or capacity < 1:
            raise web.HTTPBadRequest(text="capacity must be a positive integer")
        specs = await state.claim(claimant, capacity)
        return web.json_response({"specs": specs})

    async def heartbeat(request: web.Request) -> web.Response:
        simulation_id = request.match_info["simulation_id"]
        if not state.known(simulation_id):
            raise web.HTTPNotFound(text=f"unknown simulation {simulation_id}")
        body = await request.json()
        claimant = body.get("claimant")
        if not isinstance(claimant, str) or not claimant:
            raise web.HTTPBadRequest(text="claimant must be a non-empty string")
        directive = state.heartbeat(simulation_id, claimant)
        return web.json_response({"directive": directive})

    async def report(request: web.Request) -> web.Response:
        simulation_id = request.match_info["simulation_id"]
        if not state.known(simulation_id):
            raise web.HTTPNotFound(text=f"unknown simulation {simulation_id}")
        try:
            state.report(simulation_id, await request.read())
        except RefusedReport as refusal:
            raise web.HTTPBadRequest(text=str(refusal)) from refusal
        return web.Response(status=204)

    async def traces(request: web.Request) -> web.Response:
        try:
            state.spans(await request.read())
        except RefusedSpans as refusal:
            # The specification's own refusal shape, so the sender reads it
            # the way it would read the real door's.
            raise web.HTTPBadRequest(
                text=json.dumps({"code": 3, "message": str(refusal)}),
                content_type="application/json",
            ) from refusal
        # An empty ExportTraceServiceResponse: everything landed.
        return web.json_response({})

    async def records(_request: web.Request) -> web.Response:
        return web.json_response({"records": state.records})

    async def offer(request: web.Request) -> web.Response:
        document = await request.json()
        try:
            await state.offer(document)
        except ContractViolation as violation:
            raise web.HTTPBadRequest(
                text="; ".join(violation.complaints)
            ) from violation
        except ValueError as clash:
            raise web.HTTPConflict(text=str(clash)) from clash
        return web.Response(status=204)

    async def cancel(request: web.Request) -> web.Response:
        simulation_id = request.match_info["simulation_id"]
        if not state.known(simulation_id):
            raise web.HTTPNotFound(text=f"unknown simulation {simulation_id}")
        state.cancel(simulation_id)
        return web.Response(status=204)

    app = web.Application()
    app.router.add_post("/v1/claims", claim)
    app.router.add_post("/v1/simulations/{simulation_id}/heartbeats", heartbeat)
    app.router.add_post("/v1/simulations/{simulation_id}/reports", report)
    app.router.add_post("/v1/traces", traces)
    app.router.add_get("/workbench/records", records)
    app.router.add_post("/workbench/specs", offer)
    app.router.add_post("/workbench/simulations/{simulation_id}/cancel", cancel)
    return app


def _simulation_named_by(resource: object) -> str | None:
    """Which simulation one OTLP resource says its spans are evidence of."""
    if not isinstance(resource, dict):
        return None
    attributes = resource.get("resource", {}).get("attributes", [])
    for attribute in attributes:
        if not isinstance(attribute, dict):
            continue
        if attribute.get("key") != SIMULATION_ID_ATTRIBUTE:
            continue
        named = attribute.get("value", {}).get("stringValue")
        return named if isinstance(named, str) and named else None
    return None


def load_spec_documents(path: Path) -> list[dict]:
    """Spec documents from one file or every ``*.json`` in a directory."""
    files = sorted(path.glob("*.json")) if path.is_dir() else [path]
    if not files:
        raise FileNotFoundError(f"no spec fixtures under {path}")
    documents = []
    for file in files:
        with open(file, encoding="utf-8") as handle:
            documents.append(json.load(handle))
    return documents
