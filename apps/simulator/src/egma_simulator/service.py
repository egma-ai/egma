"""The standing service: claim, conduct, heartbeat, report, repeat.

Dispatch per ADR-0005. One long-poll claim loop asks for exactly as much
work as the executor has room for; each claimed spec becomes one running
simulation — a conduct task walking the pipe and a heartbeat task beating
every few seconds, with cancel directives honored on the beat's answer.
The executor is deliberately a seam: today it runs simulations as asyncio
tasks in this process, and a process- or container-per-simulation executor
replaces it without the claim loop noticing.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

from .client import ClaimFailure, ControlPlaneClient, HeartbeatFailure
from .config import SimulatorConfig
from .contract import ContractViolation, validate_spec
from .pipe import Conducted, PipeControls, conduct
from .redaction import SecretRegistry
from .reporting import Reporter, moment

logger = logging.getLogger(__name__)


class Executor(Protocol):
    """The seam between claiming work and running it.

    ``free_capacity`` is what the next claim declares; ``submit`` accepts a
    claimed spec and returns without waiting for it; ``wait_for_room`` parks
    the claim loop while the executor is full; ``cancel_all`` and ``drain``
    are teardown. An executor that runs simulations in processes or
    containers implements this same surface.
    """

    @property
    def free_capacity(self) -> int: ...

    def submit(self, spec: dict) -> None: ...

    async def wait_for_room(self) -> None: ...

    def cancel_all(self) -> None: ...

    async def drain(self) -> None: ...


class AsyncioExecutor:
    """Runs each simulation as one asyncio task inside this process.

    The v1 executor, per the spec's flagged deviation from per-simulation
    containers: a testing platform's failure domain is forgiving, and the
    seam means heavier executors can replace this without touching the
    claim loop.
    """

    def __init__(
        self, capacity: int, *, start: Callable[[dict], Awaitable[None]]
    ) -> None:
        self._capacity = capacity
        self._start = start
        self._running: set[asyncio.Task] = set()
        self._room = asyncio.Event()
        self._room.set()

    @property
    def free_capacity(self) -> int:
        return self._capacity - len(self._running)

    def submit(self, spec: dict) -> None:
        if self.free_capacity < 1:
            raise RuntimeError("submit called with no free capacity")
        task = asyncio.create_task(
            self._start(spec), name=f"simulation:{spec.get('simulation_id')}"
        )
        self._running.add(task)
        task.add_done_callback(self._finished)
        if self.free_capacity < 1:
            self._room.clear()

    def _finished(self, task: asyncio.Task) -> None:
        self._running.discard(task)
        self._room.set()
        if not task.cancelled() and task.exception() is not None:
            logger.error(
                "a simulation task died unreported", exc_info=task.exception()
            )

    async def wait_for_room(self) -> None:
        await self._room.wait()

    def cancel_all(self) -> None:
        for task in list(self._running):
            task.cancel()

    async def drain(self) -> None:
        while self._running:
            await asyncio.gather(*list(self._running), return_exceptions=True)


class RunningSimulation:
    """One claimed spec being conducted: the pipe walk and its heartbeat."""

    def __init__(
        self,
        spec: dict,
        *,
        client: ControlPlaneClient,
        config: SimulatorConfig,
        secrets: SecretRegistry,
    ) -> None:
        self.simulation_id: str = spec["simulation_id"]
        self._spec = spec
        self._client = client
        self._config = config
        self._secrets = secrets
        self._reporter = Reporter(
            client,
            self.simulation_id,
            config.wal_dir,
            delivery_deadline_seconds=config.report_deadline_seconds,
        )
        self._controls = PipeControls()
        self._first_human_at: float | None = None
        self._first_latency_reported = False

    async def run(self) -> None:
        """Conduct to a terminal report, whatever happens on the way."""
        heartbeat = asyncio.create_task(
            self._heartbeat_forever(),
            name=f"heartbeat:{self.simulation_id}",
        )
        try:
            await self._conduct_and_report()
        finally:
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass
            await self._reporter.close()

    async def _conduct_and_report(self) -> None:
        reporter = self._reporter
        reporter.running()
        try:
            validate_spec(self._spec)
        except ContractViolation as violation:
            logger.error(
                "refusing %s: claimed spec does not speak the contract (%s)",
                self.simulation_id,
                "; ".join(violation.complaints),
            )
            reporter.failed("error", "claimed spec failed contract validation")
            return

        try:
            conducted = await conduct(
                scenario_instructions=self._spec["scenario"]["instructions"],
                max_turns=self._spec["limits"]["max_turns"],
                max_duration_seconds=self._spec["limits"]["max_duration_seconds"],
                pacing_seconds=self._config.echo_turn_seconds,
                on_turn=self._on_turn,
                controls=self._controls,
                name=f"sim:{self.simulation_id}",
            )
        except asyncio.CancelledError:
            # The service itself is being torn down mid-walk. Reporting a
            # terminal state now would be a guess; the orphan sweep exists
            # to make this honest. Say nothing and let the heartbeats stop.
            raise
        except Exception as fault:
            reason = self._secrets.redact(f"{type(fault).__name__}: {fault}")
            logger.exception("conducting %s hit a fault", self.simulation_id)
            reporter.failed("error", reason)
            return

        self._report_terminal(conducted)

    def _report_terminal(self, conducted: Conducted) -> None:
        if conducted.status == "canceled":
            self._reporter.canceled("cancel directive on heartbeat")
        elif conducted.ending == "limit_reached":
            self._reporter.completed(
                "limit_reached", "a limit from the spec tripped"
            )
        else:
            self._reporter.completed(conducted.ending)

    async def _on_turn(self, speaker: str, text: str) -> None:
        self._reporter.turn(speaker, text, started_at=moment())
        loop = asyncio.get_running_loop()
        if speaker == "human" and self._first_human_at is None:
            self._first_human_at = loop.time()
        elif (
            speaker == "agent"
            and self._first_human_at is not None
            and not self._first_latency_reported
        ):
            self._first_latency_reported = True
            elapsed_ms = (loop.time() - self._first_human_at) * 1000
            self._reporter.timing("first_response_latency", elapsed_ms)

    async def _heartbeat_forever(self) -> None:
        while True:
            try:
                directive = await self._client.heartbeat(
                    self.simulation_id, self._config.claimant
                )
            except HeartbeatFailure as failure:
                # A missed beat is the control plane's signal, not ours to
                # invent meaning for. Keep conducting, keep trying.
                logger.warning(
                    "heartbeat for %s did not land: %s", self.simulation_id, failure
                )
            else:
                if directive == "cancel":
                    logger.info(
                        "cancel directive for %s; stopping at this beat",
                        self.simulation_id,
                    )
                    await self._controls.request_cancel()
                elif directive is not None:
                    logger.warning(
                        "unknown directive %r for %s ignored",
                        directive,
                        self.simulation_id,
                    )
            await asyncio.sleep(self._config.heartbeat_seconds)


class SimulatorService:
    """The claim loop, wired to an executor and a client."""

    def __init__(self, config: SimulatorConfig, *, secrets: SecretRegistry) -> None:
        self._config = config
        self._secrets = secrets
        self._stopping = asyncio.Event()

    def stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        config = self._config
        async with ControlPlaneClient(
            config.control_plane_url,
            claim_wait_seconds=config.claim_wait_seconds,
        ) as client:
            executor = AsyncioExecutor(
                config.capacity,
                start=lambda spec: self._conduct_one(spec, client),
            )
            logger.info(
                "simulator %s claiming from %s with capacity %d",
                config.claimant,
                config.control_plane_url,
                config.capacity,
            )
            try:
                await self._claim_until_stopped(client, executor)
            finally:
                executor.cancel_all()
                await executor.drain()

    async def _claim_until_stopped(
        self, client: ControlPlaneClient, executor: Executor
    ) -> None:
        while not self._stopping.is_set():
            if executor.free_capacity < 1:
                await self._wait_for_room_or_stop(executor)
                continue

            try:
                specs = await client.claim(
                    self._config.claimant, executor.free_capacity
                )
            except ClaimFailure as failure:
                logger.warning("claim did not land: %s", failure)
                await asyncio.sleep(1.0)
                continue

            for spec in specs:
                if not isinstance(spec, dict) or not spec.get("simulation_id"):
                    logger.error(
                        "claim answer carried a spec with no simulation_id; dropped"
                    )
                    continue
                connection = spec.get("connection")
                if isinstance(connection, dict):
                    self._secrets.register(connection.get("credentials"))
                executor.submit(spec)

    async def _wait_for_room_or_stop(self, executor: Executor) -> None:
        stop_waiter = asyncio.create_task(self._stopping.wait())
        room_waiter = asyncio.create_task(executor.wait_for_room())
        _, pending = await asyncio.wait(
            {stop_waiter, room_waiter}, return_when=asyncio.FIRST_COMPLETED
        )
        for waiter in pending:
            waiter.cancel()

    async def _conduct_one(self, spec: dict, client: ControlPlaneClient) -> None:
        simulation = RunningSimulation(
            spec,
            client=client,
            config=self._config,
            secrets=self._secrets,
        )
        await simulation.run()
