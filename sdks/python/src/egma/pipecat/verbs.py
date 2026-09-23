"""``simulation`` and ``monitor`` for a Pipecat bot.

Both take the ``PipelineWorker`` the bot built and the ``runner_args`` its
``bot()`` received, and both belong after the worker is built and before
the runner starts it::

    worker = PipelineWorker(pipeline, ...)
    await simulation(worker, runner_args)
    await monitor(worker, runner_args)
    await runner.add_workers(worker)

One session per worker holds what the two verbs share: the observer that
writes the record, the export it writes to, the HTTPS client, and the hooks
on the worker's LLM services. The session ends when the pipeline finishes:
open spans are ended, the root is sent last, the hooks are removed, and the
client and the export are closed.

A bot can also fail after these calls and before its pipeline runs. Then
the session is released when the task that called them ends with an error
or is cancelled, and, as a backstop, when the worker is garbage collected.
No record is written for a pipeline that never ran.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import weakref
from typing import Any

from .. import otlp, seam
from .._frameworks import installed_version
from ..errors import NotReported
from . import census, couriers, detect, https_seam
from .export import SessionExport
from .observer import EgmaObserver, Recorder

logger = logging.getLogger("egma")

SIMULATION_VERB = "egma.pipecat.simulation"
MONITOR_VERB = "egma.pipecat.monitor"

FINISH_WAIT_SECONDS = 2.0
"""How long the end of the pipeline waits for the observer to catch up."""

REPORT_WAIT_SECONDS = 5.0
"""How long the end of the session waits for a repeated hello still in flight."""

_SESSION = "_egma_pipecat_session"


class _Held:
    """The session's open resources, reachable without the worker.

    The garbage-collection backstop holds this object only, so it never keeps
    the worker alive.
    """

    def __init__(self) -> None:
        self.seam: https_seam.Seam | None = None
        self.export: SessionExport | None = None

    async def close(self) -> None:
        if self.seam is not None:
            await self.seam.close()
        if self.export is not None:
            await self.export.close()

    def close_now(self) -> None:
        """Release what can be released without awaiting."""
        if self.export is not None:
            self.export.discard()
        if self.seam is not None:
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(self.seam.close())


class _Session:
    """What ``simulation`` and ``monitor`` share for one worker."""

    def __init__(self, worker: Any, runner_args: object) -> None:
        self.worker = worker
        self.simulation: str | None = None
        """None, ``"accepted"``, or ``"not_a_simulation"``."""
        self.monitor: str | None = None
        """None, ``"production"``, or ``"suppressed"``."""
        self.held = _Held()
        self.llms: list[Any] = []
        self.failures: dict[str, str] = {}
        self.census: dict[str, dict[str, Any]] = {}
        self.mocked: frozenset[str] = frozenset()
        self._flows_reported: set[str] = set()
        self._report_lock = asyncio.Lock()
        self._reports: set[asyncio.Task[None]] = set()
        self.recorder = Recorder(
            self._tracer, self.failures, detect.transport_of(runner_args)
        )
        self.session_id = detect.session_id_of(runner_args)
        self.observer: EgmaObserver | None = None
        self._watched: set[int] = set()
        self._release: asyncio.Task[None] | None = None
        self._finished = False
        weakref.finalize(worker, _Held.close_now, self.held)

    @property
    def export(self) -> SessionExport | None:
        return self.held.export

    @property
    def seam(self) -> https_seam.Seam | None:
        return self.held.seam

    def _tracer(self) -> Any:
        assert self.export is not None
        return self.export.tracer

    def use_export(self, export: SessionExport) -> None:
        """Write the record through ``export`` from now on.

        A production export is replaced by a simulation's before the
        pipeline starts. Once the record has begun it keeps its export.
        """
        previous = self.export
        if previous is not None and self.recorder.started:
            logger.error(
                "this bot's pipeline started before %s ran, so its record keeps "
                "going to %s; call %s before the runner starts the worker",
                SIMULATION_VERB,
                "Monitoring" if not previous.provider_reference else "its simulation",
                SIMULATION_VERB,
            )
            export.discard()
            return
        self.held.export = export
        if previous is not None:
            previous.discard()
        self._attach()

    def _attach(self) -> None:
        if self.observer is not None:
            return
        try:
            sink = self.worker.pipeline.processors[-1]
        except Exception:
            sink = None
        self.observer = EgmaObserver(
            self.recorder, sink=sink, on_cleanup=self.finish, on_tools=self.learn_tools
        )
        self.worker.add_observer(self.observer)
        self.worker.add_event_handler("on_pipeline_finished", self._pipeline_finished)

    def watch_caller(self) -> None:
        """Release the session if the calling task fails before the pipeline runs."""
        task = asyncio.current_task()
        if task is None or id(task) in self._watched:
            return
        self._watched.add(id(task))
        task.add_done_callback(self._caller_done)

    def _caller_done(self, task: asyncio.Task[Any]) -> None:
        if self._finished or self.recorder.started:
            return
        if not task.cancelled() and task.exception() is None:
            return
        try:
            self._release = task.get_loop().create_task(self.finish())
        except RuntimeError:
            self._finished = True
            self._remove_hooks()
            self.held.close_now()

    async def _pipeline_finished(self, _worker: Any, _frame: Any) -> None:
        if self.observer is not None:
            try:
                await asyncio.wait_for(self.observer.ended.wait(), FINISH_WAIT_SECONDS)
            except TimeoutError:
                pass
        await self.finish()

    async def ask(
        self, name: str, arguments: dict[str, Any] | None, flows: bool
    ) -> seam.Served:
        assert self.seam is not None
        if flows:
            known = self.census.get(name, {"name": name})
            self._learn({name: {**known, "flows": True}})
        return await self.seam.tool(name, arguments, flows=flows)

    def learn_tools(self, tools: Any) -> None:
        """Take in a tool set the pipeline now carries, such as a Flows node's."""
        if self.mocked:
            self._learn(census.tools_census(tools))

    def _learn(self, entries: dict[str, dict[str, Any]]) -> None:
        """Add tools to the census; report a mocked Flows function again.

        egma refuses a test that mocks a Pipecat Flows function. Flows gives
        the LLM its functions after the first hello, so a mocked one found
        later is reported in a repeated hello, which egma refuses. That
        refusal fails the simulation on egma's side; here it is logged.
        """
        refused: list[str] = []
        for name, entry in entries.items():
            known = self.census.get(name)
            self.census[name] = entry if known is None else {**known, **entry}
            if (
                self.census[name].get("flows")
                and name in self.mocked
                and name not in self._flows_reported
            ):
                self._flows_reported.add(name)
                refused.append(name)
        if not refused:
            return
        try:
            task = asyncio.get_running_loop().create_task(self._report_again(refused))
        except RuntimeError:
            return
        self._reports.add(task)
        task.add_done_callback(self._reports.discard)

    async def _report_again(self, flows_names: list[str]) -> None:
        if self.seam is None:
            return
        named = ", ".join(flows_names)
        reference = self.seam.provider_reference
        async with self._report_lock:
            try:
                await self.seam.hello(list(self.census.values()))
            except https_seam.HelloFailed as failed:
                logger.warning(
                    "simulation %s: the test mocks the Pipecat Flows function(s) "
                    "%s, and Egma refused them: %s",
                    reference,
                    named,
                    failed.reason,
                )
            except https_seam.NotASimulation:
                logger.warning(
                    "simulation %s is no longer live, so the Pipecat Flows "
                    "function(s) %s were not reported",
                    reference,
                    named,
                )
            except Exception:
                logger.exception(
                    "simulation %s: the Pipecat Flows function(s) %s could not "
                    "be reported to Egma",
                    reference,
                    named,
                )

    def record_failure(self, tool_call_id: str, message: str) -> None:
        self.failures[tool_call_id] = message

    def _remove_hooks(self) -> None:
        for llm in self.llms:
            couriers.uninstall(llm)

    async def finish(self) -> None:
        """End the record, send it, and release what the session holds.

        The record is written only for a pipeline that ran.
        """
        if self._finished:
            return
        self._finished = True
        if self.export is not None and self.recorder.started:
            try:
                self.recorder.finish(time.time_ns())
            except Exception:
                logger.exception("Egma could not end this bot session's record")
        self._remove_hooks()
        if self._reports:
            pending = tuple(self._reports)
            _, late = await asyncio.wait(pending, timeout=REPORT_WAIT_SECONDS)
            for task in late:
                task.cancel()
        await self.held.close()


def _session_of(worker: Any, runner_args: object, verb: str) -> _Session:
    session = getattr(worker, _SESSION, None)
    if isinstance(session, _Session):
        return session
    if (
        not all(
            callable(getattr(worker, name, None))
            for name in ("add_observer", "add_event_handler")
        )
        or getattr(worker, "pipeline", None) is None
    ):
        raise TypeError(
            f"{verb} needs the PipelineWorker your bot builds, as its first "
            "argument: await "
            f"{verb.rsplit('.', 1)[-1]}(worker, runner_args)."
        )
    session = _Session(worker, runner_args)
    setattr(worker, _SESSION, session)
    return session


def _settings(
    endpoint: str | None, api_key: str | None, verb: str
) -> tuple[str, str, str]:
    """The SDK root URL, the project key, and the trace endpoint."""
    url = otlp.setting(endpoint, "EGMA_URL", verb)
    key = otlp.project_key(otlp.setting(api_key, "EGMA_API_KEY", verb), verb)
    return otlp.api_root(url, verb), key, otlp.trace_endpoint(url, verb)


def _not_reported(reference: str, reason: str) -> NotReported:
    return NotReported(
        f"simulation {reference}: this bot did not report to Egma "
        f"({reason}), so it was not started. A Pipecat simulation needs "
        f"{SIMULATION_VERB} to reach Egma's server: check EGMA_URL and "
        "EGMA_API_KEY where this bot runs, and check that the egma package "
        "installed here is the one that shipped with this Egma deployment "
        f"(this is egma {installed_version('egma')})."
    )


async def simulation(
    worker: Any,
    runner_args: object,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Report this bot to an Egma simulation, answer its mock tools, record it.

    Await once, after building the ``PipelineWorker`` and before the runner
    starts it. When ``runner_args.body`` carries no ``egma`` key this
    returns at once: no network, nothing wrapped, nothing exported.

    With the key, it sends egma the bot's tools and learns which ones the
    test mocks. egma answers only for a live simulation of the API key's
    project; anything else is production and this returns without acting.
    For a live simulation it answers exactly the mocked tools from egma,
    runs every other tool for real, and exports the bot's own record of the
    conversation under the simulation.

    Raises:
        NotReported: egma refused or did not answer the report. The bot
            must not start: a mocked tool would otherwise run for real.
        ValueError: ``EGMA_URL`` or ``EGMA_API_KEY`` is missing or invalid.
        TypeError: ``worker`` is not a Pipecat ``PipelineWorker``.

    ``endpoint`` and ``api_key`` default to ``EGMA_URL`` and ``EGMA_API_KEY``.
    """
    reference = detect.provider_reference_in(runner_args)
    if reference is None:
        logger.debug(
            "this start request carried no Egma simulation marker, so nothing "
            "is wrapped, nothing is exported, and every tool runs its own "
            "handler"
        )
        return

    session = _session_of(worker, runner_args, SIMULATION_VERB)
    if session.simulation is not None:
        return
    base, key, trace_endpoint = _settings(endpoint, api_key, SIMULATION_VERB)

    llms = census.llm_services_in(worker)
    tools = census.census_of(worker, llms)
    session.census = {entry["name"]: entry for entry in tools}
    export = SessionExport(
        endpoint=trace_endpoint,
        api_key=key,
        verb=SIMULATION_VERB,
        provider_reference=reference,
        session_id=session.session_id,
    )
    client = https_seam.Seam(base, key, reference)
    accepted = False
    try:
        try:
            mocked = await client.hello(tools)
        except https_seam.NotASimulation:
            session.simulation = "not_a_simulation"
            logger.warning(
                "this start request named Egma simulation %s, and Egma answered "
                "that it is not a live simulation in this API key's project, so "
                "this bot runs as production: nothing is wrapped and nothing is "
                "exported as a simulation",
                reference,
            )
            return
        except https_seam.HelloFailed as failed:
            if failed.verbatim:
                raise NotReported(failed.reason) from failed
            raise _not_reported(reference, failed.reason) from failed
        if mocked and not llms:
            raise _not_reported(
                reference,
                "no Pipecat LLM service is in this worker's pipeline, so Egma "
                f"cannot answer the mocked tools ({', '.join(mocked)})",
            )
        accepted = True
    finally:
        if not accepted:
            await client.close()
            export.discard()

    session.simulation = "accepted"
    session.held.seam = client
    session.llms = llms
    answered = frozenset(mocked)
    session.mocked = answered
    session.use_export(export)
    session.watch_caller()
    for llm in llms:
        couriers.install(llm, answered, session.ask, session.record_failure)
    if session.monitor == "production":
        session.monitor = "suppressed"
    if detect.modality_in(runner_args) == "chat":
        await _keep_speech_off(worker, reference)
    logger.info(
        "simulation %s: the bot reported %d tool(s) and Egma answers for %d "
        "name(s) (%s); every other tool runs its own handler",
        reference,
        len(tools),
        len(answered),
        ", ".join(mocked) or "none",
    )


async def _keep_speech_off(worker: Any, reference: str) -> None:
    """Make every LLM answer text only, for a chat simulation egma confirmed.

    One ``LLMConfigureOutputFrame(skip_tts=True)`` enters at the top of the
    pipeline before any other frame the bot queues. The RTVI processor and
    the LLM service both keep it, so the greeting and the answer after a
    tool call are not spoken either.
    """
    from pipecat.frames.frames import LLMConfigureOutputFrame

    try:
        await worker.queue_frames([LLMConfigureOutputFrame(skip_tts=True)])
    except Exception:
        logger.exception(
            "simulation %s is a chat simulation, and Egma could not turn this "
            "bot's speech off; its answers may be spoken",
            reference,
        )


async def monitor(
    worker: Any,
    runner_args: object,
    *,
    endpoint: str | None = None,
    api_key: str | None = None,
) -> None:
    """Export this bot's production conversations to Egma Monitoring.

    Await once, after building the ``PipelineWorker`` and before the runner
    starts it. It does nothing for a simulation Egma has confirmed live:
    one that ``simulation`` reported in this process, or, when
    ``simulation`` has not run, one Egma confirms on request. A body
    without an ``egma`` key is production and costs no confirmation
    request; a key Egma does not confirm is production too.

    Raises:
        ValueError: ``EGMA_URL`` or ``EGMA_API_KEY`` is missing or invalid.
        TypeError: ``worker`` is not a Pipecat ``PipelineWorker``.

    ``endpoint`` and ``api_key`` default to ``EGMA_URL`` and ``EGMA_API_KEY``.
    """
    session = _session_of(worker, runner_args, MONITOR_VERB)
    if session.monitor is not None:
        return
    if session.simulation == "accepted":
        session.monitor = "suppressed"
        logger.info(
            "this bot runs a confirmed Egma simulation, so %s exports nothing "
            "to Monitoring: the simulation keeps the record",
            MONITOR_VERB,
        )
        return

    base, key, trace_endpoint = _settings(endpoint, api_key, MONITOR_VERB)
    reference = detect.provider_reference_in(runner_args)
    if reference is not None and session.simulation is None:
        confirming = https_seam.Seam(base, key, reference)
        try:
            confirmed = await confirming.confirm()
        finally:
            await confirming.close()
        if confirmed:
            session.monitor = "suppressed"
            logger.info(
                "Egma confirmed simulation %s is live, so %s exports nothing "
                "to Monitoring",
                reference,
                MONITOR_VERB,
            )
            return
        logger.warning(
            "this start request named Egma simulation %s, and Egma did not "
            "confirm it, so the conversation is exported to Monitoring as "
            "production",
            reference,
        )

    session.monitor = "production"
    session.use_export(
        SessionExport(
            endpoint=trace_endpoint,
            api_key=key,
            verb=MONITOR_VERB,
            provider_reference="",
            session_id=session.session_id,
        )
    )
    session.watch_caller()
