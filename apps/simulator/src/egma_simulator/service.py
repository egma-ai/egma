"""The standing service: claim, conduct, heartbeat, report, repeat.

One long-poll claim loop asks the control plane for exactly as much work as
the executor has room for. Each claimed spec becomes one running simulation
— a task walking the pipe, and a task beating every few seconds — and a
cancel directive arriving on a beat's answer stops the walk at that beat.
Every arrow points out: the simulator is never dialled into.

The executor is deliberately a seam. Today it runs each simulation as one
asyncio task in this process; a process- or container-per-simulation
executor implements the same handful of methods and the claim loop never
learns the difference.

Nothing here may take the whole service down. A control plane that is slow,
broken, or answering nonsense is an ordinary Tuesday, and the loops below
are written so that the worst it costs is the work in flight — never the
simulator itself, and never a capacity slot that no longer comes back.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Protocol

from .client import ClaimFailure, ControlPlaneClient, HeartbeatFailure
from .config import SimulatorConfig
from .contract import ContractViolation
from .model import build_model_client
from .persona import Persona
from .plugs import plug_for
from .redaction import SecretRegistry
from .reporting import Reporter, moment
from .spec import SimulationSpec
from .walk import Conducted, WalkControls, conduct

logger = logging.getLogger(__name__)

CLAIM_RETRY_SECONDS = 1.0


class Executor(Protocol):
    """The seam between claiming work and running it.

    ``free_capacity`` is what the next claim declares; ``submit`` accepts a
    spec and returns without waiting for it; ``wait_for_room`` parks the
    claim loop while the executor is full; ``cancel_all`` and ``drain`` are
    teardown. An executor that runs simulations in processes or containers
    implements this same surface and nothing above it changes.
    """

    @property
    def free_capacity(self) -> int: ...

    def submit(self, spec: SimulationSpec) -> None: ...

    async def wait_for_room(self) -> None: ...

    def cancel_all(self) -> None: ...

    async def drain(self) -> None: ...


class AsyncioExecutor:
    """Runs each simulation as one asyncio task inside this process.

    The first executor, and the simplest thing that honors the seam: a
    testing platform's failure domain is forgiving, and per-simulation
    containers would tax exactly the self-hosted deployment where adoption
    lives. Heavier executors can replace this without touching the loop.
    """

    def __init__(
        self, capacity: int, *, start: Callable[[SimulationSpec], Awaitable[None]]
    ) -> None:
        self._capacity = capacity
        self._start = start
        self._running: set[asyncio.Task] = set()
        self._room = asyncio.Event()
        self._room.set()

    @property
    def free_capacity(self) -> int:
        return self._capacity - len(self._running)

    def submit(self, spec: SimulationSpec) -> None:
        if self.free_capacity < 1:
            raise RuntimeError("submit called with no free capacity")
        task = asyncio.create_task(
            self._start(spec), name=f"simulation:{spec.simulation_id}"
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
        spec: SimulationSpec,
        *,
        client: ControlPlaneClient,
        config: SimulatorConfig,
        secrets: SecretRegistry,
    ) -> None:
        self.simulation_id = spec.simulation_id
        self._spec = spec
        self._client = client
        self._config = config
        self._secrets = secrets
        self._reporter = Reporter(
            client,
            spec.simulation_id,
            config.wal_dir,
            delivery_deadline_seconds=config.report_deadline_seconds,
        )
        self._controls = WalkControls()
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
            except Exception:
                # The beat is already over and its own loop logged why.
                # Raising here would skip closing the reporter, which is
                # what gets the terminal event onto the wire.
                logger.exception(
                    "the heartbeat for %s ended badly", self.simulation_id
                )
            await self._reporter.close()

    async def _conduct_and_report(self) -> None:
        reporter = self._reporter
        reporter.running()
        try:
            # The plug is the one component that knows the platform; the
            # claim loop already guaranteed one exists for this type, and
            # its constructor validating the connection config is part of
            # conducting — a bad config is an honest failure, not a crash.
            plug_class = plug_for(self._spec.connection_type)
            assert plug_class is not None, "accepted a spec with no plug"
            plug = plug_class(
                modality=self._spec.modality,
                config=self._spec.connection_config,
                credentials=self._spec.credentials,
            )
            model = build_model_client(self._config, self._spec)
            try:
                conducted = await conduct(
                    persona=Persona(
                        traits=self._spec.persona_traits,
                        scenario_instructions=self._spec.scenario_instructions,
                        model=model,
                    ),
                    plug=plug,
                    max_turns=self._spec.limits.max_turns,
                    max_duration_seconds=self._spec.limits.max_duration_seconds,
                    on_turn=self._on_turn,
                    on_timing=self._on_timing,
                    controls=self._controls,
                    name=f"sim:{self.simulation_id}",
                )
            finally:
                await model.close()
        except asyncio.CancelledError:
            # The service itself is being torn down mid-walk. Reporting a
            # terminal state now would be a guess; a simulation whose
            # simulator vanished is answered by the control plane noticing
            # the heartbeats stop. Say nothing.
            raise
        except Exception as fault:
            reason = self._secrets.redact(f"{type(fault).__name__}: {fault}")
            logger.exception("conducting %s hit a fault", self.simulation_id)
            reporter.failed("error", reason)
            return

        self._report_terminal(conducted)

    def _report_terminal(self, conducted: Conducted) -> None:
        self._reporter.provider_reference = conducted.provider_reference
        if conducted.status == "canceled":
            self._reporter.canceled("cancel directive on heartbeat")
        else:
            self._reporter.completed(conducted.ending, conducted.reason)

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

    async def _on_timing(self, measure: str, milliseconds: float) -> None:
        self._reporter.timing(measure, milliseconds)

    async def _heartbeat_forever(self) -> None:
        while True:
            try:
                directive = await self._client.heartbeat(
                    self.simulation_id, self._config.claimant
                )
            except HeartbeatFailure as failure:
                # A missed beat is the control plane's signal to read, not
                # ours to invent meaning for. Keep conducting, keep trying.
                logger.warning(
                    "heartbeat for %s did not land: %s", self.simulation_id, failure
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                # Ending this loop would leave the walk running with no way
                # to ever hear a cancel directive. Nothing is worth that.
                logger.exception(
                    "heartbeat for %s hit an unexpected fault", self.simulation_id
                )
            else:
                await self._honor(directive)
            await asyncio.sleep(self._config.heartbeat_seconds)

    async def _honor(self, directive: str | None) -> None:
        if directive is None:
            return
        if directive == "cancel":
            logger.info(
                "cancel directive for %s; stopping at this beat",
                self.simulation_id,
            )
            self._controls.request_cancel()
            return
        logger.warning(
            "unknown directive %r for %s ignored", directive, self.simulation_id
        )


class SimulatorService:
    """The claim loop, wired to an executor and a client."""

    def __init__(self, config: SimulatorConfig, *, secrets: SecretRegistry) -> None:
        self._config = config
        self._secrets = secrets

    async def run(self) -> None:
        """Claim and conduct until cancelled. Cancellation is the only exit."""
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
                await self._claim_forever(client, executor)
            finally:
                executor.cancel_all()
                await executor.drain()

    async def _claim_forever(
        self, client: ControlPlaneClient, executor: Executor
    ) -> None:
        while True:
            if executor.free_capacity < 1:
                await executor.wait_for_room()
                continue

            try:
                specs = await client.claim(
                    self._config.claimant, executor.free_capacity
                )
            except ClaimFailure as failure:
                logger.warning("claim did not land: %s", failure)
                await asyncio.sleep(CLAIM_RETRY_SECONDS)
                continue
            except asyncio.CancelledError:
                raise
            except Exception:
                # Whatever went wrong, it is not worth the simulations
                # currently in flight, which is what ending this loop would
                # cost them.
                logger.exception("the claim loop hit an unexpected fault")
                await asyncio.sleep(CLAIM_RETRY_SECONDS)
                continue

            self._accept(specs, executor)

    def _accept(self, documents: list, executor: Executor) -> None:
        """Take what fits and can be understood; refuse the rest out loud.

        The claim declared how much room there was, but the answer is the
        control plane's to compose, and a simulator that trusted it blindly
        would overload on a bad answer. Anything past capacity is left
        alone: it stays claimed at the control plane, whose sweep is what
        notices a claimed simulation nobody is beating for. Overloading, or
        dying on the surprise, would both be worse than being one queue
        deep for a while.
        """
        for position, document in enumerate(documents):
            if executor.free_capacity < 1:
                logger.error(
                    "claim answer carried %d spec(s) past the %d declared; "
                    "leaving %d unconducted",
                    len(documents) - position,
                    self._config.capacity,
                    len(documents) - position,
                )
                return

            try:
                spec = SimulationSpec.from_document(document)
            except ContractViolation as violation:
                # Refusing to conduct is not a simulation that went wrong,
                # and reporting one would be a claim about a conversation
                # that never started. Say nothing to the control plane and
                # let its sweep account for the row it thinks is claimed.
                logger.error(
                    "refusing a claimed spec that does not speak the "
                    "contract: %s",
                    "; ".join(violation.complaints),
                )
                continue
            except (KeyError, TypeError) as malformed:
                logger.error("refusing an unreadable claimed spec: %r", malformed)
                continue

            if plug_for(spec.connection_type) is None:
                # Same shape as a contract refusal: conducting is not
                # possible, so nothing is reported and the control plane's
                # sweep accounts for the row it thinks is claimed.
                logger.error(
                    "refusing claimed spec %s: no platform plug for "
                    "connection type %r",
                    spec.simulation_id,
                    spec.connection_type,
                )
                continue

            self._secrets.register(spec.credentials)
            executor.submit(spec)

    async def _conduct_one(
        self, spec: SimulationSpec, client: ControlPlaneClient
    ) -> None:
        simulation = RunningSimulation(
            spec,
            client=client,
            config=self._config,
            secrets=self._secrets,
        )
        await simulation.run()
