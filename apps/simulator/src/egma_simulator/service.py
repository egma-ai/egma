"""The standing service: claim, conduct, heartbeat, report, repeat.

One long-poll claim loop asks the control plane for exactly as much work as
the executor has room for. Each claimed spec becomes one running simulation
— a task conducting the exchange, and a task beating every few seconds —
and a cancel directive arriving on a beat's answer stops the conducting at
that beat.
Every arrow points out: the simulator is never dialled into.

A running simulation writes two records of itself and this is where they
are joined. The lifecycle goes to the control plane as report events; the
conversation goes to the OTLP ingest as spans, authored here from what
whichever conductor ran observed. Neither says what the other says: a
turn, a tool call and a measurement are spans and only spans, and what the
lifecycle carries about them is the one summary fact a reader of a single
simulation asks for — how many turns it reached. Both go through one
reporter, so they are delivered in the order they happened and the
terminal document is last.

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

from .blob import BlobStore, FilesystemBlobStore, S3BlobStore
from .client import ClaimFailure, ControlPlaneClient, HeartbeatFailure
from .config import SimulatorConfig
from .contract import ContractViolation
from .model import build_model_client
from .persona import Persona
from .pipeline import Assembled, assemble
from .plugs import failed_ending, plug_for
from .redaction import SecretRegistry
from .reporting import Reporter
from .spans import SpanEmitter
from .spec import SimulationSpec
from .speech import SpeechProviders
from .walk import Conducted, WalkControls, conduct

logger = logging.getLogger(__name__)

CLAIM_RETRY_SECONDS = 1.0

REPEATED_CLAIM_FAILURE_SECONDS = 60.0
"""How often a claim failure that has not changed says so again.

A control plane that is down fails the same way every retry for as long as
it lasts. Written out each time that is one sentence a second — megabytes
a day of a log nobody can read, with the only thing that would be news, the
failure changing, buried inside it. So a failure speaks up when it is new
and once a minute while it persists; the repeats are still there at DEBUG
for whoever wants to count them."""


def blob_store_for(config: SimulatorConfig) -> BlobStore:
    """Where this simulator's recordings go, decided once at startup.

    Naming an object-storage endpoint is the whole of what selects it —
    the same shape as naming a media backend, and the reason the entire
    test suite runs against a directory with no container anywhere. The
    two are exclusive because the configuration made them so: a
    deployment with a store has no blob directory to fall back to, and
    writing a recording to both places would leave the failure this
    effort exists to end standing behind a copy that happens to be
    reachable.

    Everything above this line is given a :class:`BlobStore` and never
    learns which one it got.
    """
    store = config.object_store
    if store is None:
        return FilesystemBlobStore(config.blob_dir)
    return S3BlobStore(
        endpoint=store.endpoint,
        bucket=store.bucket,
        access_key_id=store.access_key_id,
        secret_access_key=store.secret_access_key,
        region=store.region,
    )


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
    """One claimed spec being conducted, and its heartbeat.

    It is also the one place that sees everything a conductor observes,
    which is why the conversation's spans are authored here rather than
    deeper in. There are two conductors and they observe in two
    currencies: the walk sees a turn at the moment it happened, and the
    voice conductor sees both ends of one, read off the audio. Both report
    to the callbacks below, and what comes out is one emitter for chat and
    voice alike.
    """

    def __init__(
        self,
        spec: SimulationSpec,
        *,
        client: ControlPlaneClient,
        config: SimulatorConfig,
        secrets: SecretRegistry,
        blobs: BlobStore,
    ) -> None:
        self.simulation_id = spec.simulation_id
        self._spec = spec
        self._client = client
        self._config = config
        self._secrets = secrets
        self._blobs = blobs
        self._reporter = Reporter(
            client,
            spec.simulation_id,
            config.wal_dir,
            delivery_deadline_seconds=config.report_deadline_seconds,
        )
        # The conversation's own record, authored here and delivered by the
        # reporter — the same log, the same ordered sender. Which is what
        # puts every span ahead of the terminal document rather than
        # alongside it.
        self._spans = SpanEmitter(spec.simulation_id, flush=self._reporter.spans)
        self._controls = WalkControls()
        self._first_human_at: float | None = None
        self._first_latency_reported = False
        self._assembled: Assembled | None = None

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
        self._spans.opened()
        try:
            # The model first, because the pipeline below holds things that
            # have to be given back and only conducting gives them back.
            model = build_model_client(self._config, self._spec)
            # One pipeline per simulation, built from its own spec: the
            # plug that knows the platform, and — for voice — the speech
            # legs around it, whichever set this deployment configured.
            # Assembling also decides which of the two conductors this
            # simulation gets. It is validation, so a connection config
            # the plug does not understand is an honest failure rather
            # than a crash.
            assembled = assemble(
                self._spec,
                blobs=self._blobs,
                speech=SpeechProviders.from_config(self._config),
            )
            self._assembled = assembled
            persona = Persona(
                traits=self._spec.persona_traits,
                scenario_instructions=self._spec.scenario_instructions,
                model=model,
            )
            try:
                # Which of the two conductors this simulation gets was
                # decided by assembly, from the spec alone. Both answer
                # the same `Conducted`, so nothing below this line knows
                # which one ran.
                if assembled.conductor is not None:
                    conducted = await assembled.conductor.conduct(
                        persona=persona,
                        max_turns=self._spec.limits.max_turns,
                        max_duration_seconds=(
                            self._spec.limits.max_duration_seconds
                        ),
                        controls=self._controls,
                        name=f"sim:{self.simulation_id}",
                        on_utterance=self._on_utterance,
                        on_measured=self._on_measured,
                        on_answered=self._on_answered,
                    )
                else:
                    assert assembled.plug is not None
                    conducted = await conduct(
                        persona=persona,
                        plug=assembled.plug,
                        max_turns=self._spec.limits.max_turns,
                        max_duration_seconds=(
                            self._spec.limits.max_duration_seconds
                        ),
                        on_turn=self._on_turn,
                        on_timing=self._on_timing,
                        on_tool_call=self._on_tool_call,
                        on_answered=self._on_answered,
                        controls=self._controls,
                        name=f"sim:{self.simulation_id}",
                    )
            finally:
                # Conducting closed the pipeline on its way out, whatever
                # happened, so whatever was recorded is measured by now.
                reporter.audio = assembled.audio
                # The same moment for the same reason: the exchange is
                # over, so what egma was asked about the agent's tools and
                # what it answered are both settled. Drained before the
                # stamp is read and before anything is sealed, so a call
                # served in the last breath of a conversation is on the
                # record rather than in a buffer nobody empties.
                self._record_mock_tool_calls()
                reporter.mock_tool_coverage = assembled.mock_tool_coverage
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
            # Which failed ending this is belongs to whoever raised: a
            # phone that rang out is not the same record as a simulator
            # that broke, and only the plug knows the difference. See
            # `plugs.failed_ending`.
            self._spans.sealed()
            reporter.failed(failed_ending(fault), reason)
            return

        self._report_terminal(conducted)

    def _report_terminal(self, conducted: Conducted) -> None:
        # Sealed first, always: the conversation's last spans are minted
        # ahead of the terminal document, and the one ordered sender does
        # the rest. That is what makes "the record is terminal" also mean
        # "the evidence is stored".
        self._spans.sealed()
        self._reporter.provider_reference = conducted.provider_reference
        if conducted.status == "canceled":
            self._reporter.canceled("cancel directive on heartbeat")
        else:
            self._reporter.completed(conducted.ending, conducted.reason)

    async def _on_turn(self, speaker: str, text: str) -> None:
        # The turn itself goes one way only: into the spans. What the
        # lifecycle keeps is the count, which is a fact about the whole
        # simulation rather than about any turn — so it is tallied here, as
        # the turns are observed, and rides the terminal transition.
        self._spans.turn(speaker, text)
        self._reporter.turn_count += 1
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
            self._spans.measure("first_response_latency", elapsed_ms)

    async def _on_utterance(
        self, speaker: str, text: str, began_unix_nano: int, ended_unix_nano: int
    ) -> None:
        """One turn a voice conductor read off the audio, both ends known.

        The same span the walk's turns become, authored from the audio
        timeline instead of from the wall clock — which is what lets two
        of them cross when the persona and the agent speak at once. The
        turn count is tallied here exactly as it is above, because it is
        the same fact about the same conversation.
        """
        self._spans.spoken_turn(
            speaker,
            text,
            began_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
        )
        self._reporter.turn_count += 1

    async def _on_measured(
        self, measure: str, began_unix_nano: int, ended_unix_nano: int
    ) -> None:
        """One measurement a voice conductor read off the audio timeline."""
        self._spans.measured(
            measure,
            began_unix_nano=began_unix_nano,
            ended_unix_nano=ended_unix_nano,
        )

    async def _on_answered(self) -> None:
        """One flush per answer, which is where the conversation actually
        has a seam: the persona's turn, whatever the agent did while
        answering, and the answer itself go together, and the flush after
        them is the moment a reader could watch this simulation live.
        Finer would be a request per span; coarser would be a transcript
        that only exists once it is over.

        Whichever conductor ran says when an answer is whole rather than
        this file inferring it from a turn arriving, because an answer that
        made a tool call and said nothing produces no turn — and it is
        precisely that answer whose evidence must not sit in a buffer
        waiting for the agent to speak again.
        """
        self._record_mock_tool_calls()
        self._spans.flush()

    def _record_mock_tool_calls(self) -> None:
        """Every mock-tool call egma has exchanged since this last asked.

        Taken rather than pushed: the exchange happens in whatever task the
        room hands it to, and a span authored from over there would be
        minted between two the conversation was in the middle of. Drained
        here instead, at the seams the conversation already has, so the
        order of the record is the order the simulation observed things in.
        """
        assembled = self._assembled
        if assembled is None:
            return
        for call in assembled.tool_calls():
            self._spans.tool_exchange(
                call.name,
                arguments=call.arguments,
                answer=call.answer,
                mock_tool=call.mock_tool,
                late_attached=call.late_attached,
                refused=call.refused,
                began_unix_nano=call.began_unix_nano,
                ended_unix_nano=call.ended_unix_nano,
            )

    async def _on_timing(self, measure: str, milliseconds: float) -> None:
        self._spans.measure(measure, milliseconds)

    async def _on_tool_call(self, name: str, arguments: str | None) -> None:
        self._spans.tool_call(name, arguments)

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
                # Ending this loop would leave the simulation running with
                # no way to ever hear a cancel directive. Nothing is worth
                # that.
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
        self._blobs = blob_store_for(config)
        self._last_claim_failure: str | None = None
        # Two clocks, because they answer two questions. One is how long
        # this failure has been going on, which is what the operator wants
        # to hear; the other is when it was last said, which is only what
        # paces the repeats. Sharing one made the count restart every time
        # it spoke, while the sentence read as a total.
        self._claim_failure_began = 0.0
        self._claim_failure_said_at = 0.0
        self._claim_failure_count = 0

    async def run(self) -> None:
        """Claim and conduct until cancelled. Cancellation is the only exit."""
        config = self._config
        async with ControlPlaneClient(
            config.control_plane_url,
            claim_wait_seconds=config.claim_wait_seconds,
            service_token=config.service_token,
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
                self._note_claim_failure(str(failure))
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

            # Whatever was wrong is over; the next one to go wrong is news
            # again, even if it is the same sentence as before.
            self._last_claim_failure = None
            self._accept(specs, executor)

    def _note_claim_failure(self, failure: str) -> None:
        """Say a claim failure when it is new, and once a minute after that.

        See :data:`REPEATED_CLAIM_FAILURE_SECONDS`. Nothing here decides
        anything — the loop retries either way — so a quiet log costs no
        behavior, only the repetition.
        """
        now = asyncio.get_running_loop().time()
        if failure != self._last_claim_failure:
            self._last_claim_failure = failure
            self._claim_failure_began = now
            self._claim_failure_said_at = now
            self._claim_failure_count = 1
            logger.warning("claim did not land: %s", failure)
            return

        # The count is every attempt since this failure began, not since it
        # was last mentioned: "after 300 attempts" has to mean what an
        # operator reads it to mean, and the elapsed time is said beside it
        # so neither number has to be inferred from the other.
        self._claim_failure_count += 1
        if now - self._claim_failure_said_at < REPEATED_CLAIM_FAILURE_SECONDS:
            logger.debug("claim did not land: %s", failure)
            return
        logger.warning(
            "claim still not landing after %d attempts over %.0fs: %s",
            self._claim_failure_count,
            now - self._claim_failure_began,
            failure,
        )
        self._claim_failure_said_at = now

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
            blobs=self._blobs,
        )
        await simulation.run()
