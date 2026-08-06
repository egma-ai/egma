"""The workbench: a fake control plane that speaks the contract from fixtures.

Dev and test only. It serves the three endpoints the simulator dials —
claim, heartbeat, report — from spec documents loaded off disk, validates
everything both ways against the contract schemas, and records every
observation in order. The records are the whole point: the acceptance
suite asserts against nothing else, and a person watching the log watches
a simulation go queued → claimed → running → completed.

When the real claim API lands in the control plane, the workbench retires
from the critical path and stays what it already is: the local rig for
whoever is working on the simulator.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from aiohttp import web

from ..contract import ContractViolation, validate_report, validate_spec
from ..reporting import moment

logger = logging.getLogger(__name__)


class RefusedReport(Exception):
    """A report document the workbench refused, with the words it refused in."""


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

    def _record(self, kind: str, **details: object) -> None:
        entry = {"seq": len(self.records), "at": moment(), "kind": kind, **details}
        self.records.append(entry)
        logger.info("%s", json.dumps(entry, separators=(",", ":")))

    async def offer(self, spec: dict) -> None:
        """Queue one spec — the workbench's stand-in for a trigger writing rows."""
        validate_spec(spec)
        simulation_id = spec["simulation_id"]
        if (
            simulation_id in self._queued
            or simulation_id in self._claimed
        ):
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
            self._record(
                "report", simulation_id=simulation_id, event=event, raw=body
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
    app.router.add_get("/workbench/records", records)
    app.router.add_post("/workbench/specs", offer)
    app.router.add_post("/workbench/simulations/{simulation_id}/cancel", cancel)
    return app


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
