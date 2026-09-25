"""What the Pipecat tests share: a scripted LLM, egma's server, a pipeline.

- ``ScriptedLLM`` is a real Pipecat ``LLMService`` whose answers the test
  writes in advance. It asks for tool calls through Pipecat's own
  ``run_function_calls``, which is the path every Pipecat LLM, realtime
  models included, takes to run a tool.
- ``EgmaDouble`` is egma's server for the SDK routes and the trace door,
  on 127.0.0.1, answering the worlds and the sentences of
  ``packages/simulation-contract/fixtures/seam/sdk-https-exchange.v1.json``.
- ``run_pipeline`` runs a real ``PipelineWorker`` under a ``WorkerRunner``.

The fixtures live here too, imported by each test module, so this directory
needs no ``conftest.py`` of its own: the LiveKit tests import helpers from
theirs by the module name ``conftest``, which a second one would shadow.
Without Pipecat installed, every module importing this one is skipped.
"""

from __future__ import annotations

import pytest

pytest.importorskip("pipecat.frames.frames")

import asyncio
import json
import socket
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    FunctionCallFromLLM,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import LLMService
from pipecat.workers.runner import WorkerRunner

from egma import seam
from egma.pipecat import export, https_seam

PROJECT_KEY = f"egma_sk_{'p' * 43}"
"""A key shaped exactly like a real project key and belonging to nobody."""


def seam_fixture() -> dict[str, Any]:
    """The HTTPS seam fixture, read from the checkout. Missing is a failure."""
    for ancestor in Path(__file__).resolve().parents:
        candidate = (
            ancestor
            / "packages"
            / "simulation-contract"
            / "fixtures"
            / "seam"
            / "sdk-https-exchange.v1.json"
        )
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    pytest.fail("sdk-https-exchange.v1.json is not in this checkout")


def compact(value: Any) -> bytes:
    return seam.serialized(value).encode()


# --- egma's server -----------------------------------------------------------


@dataclass
class Asked:
    route: str
    authorization: str
    body: Any


class EgmaDouble:
    """egma's SDK routes and trace door, answering the fixture's worlds."""

    def __init__(self, fixture: dict[str, Any]) -> None:
        self.fixture = fixture
        self.worlds: dict[str, list[dict[str, Any]]] = {
            world["simulation_id"]: list(world["mock_tools"])
            for world in fixture["worlds"].values()
        }
        self.live: set[str] = set(self.worlds)
        self.asked: list[Asked] = []
        self.traces: list[tuple[dict[str, str], bytes]] = []
        self.reports: dict[str, dict[str, Any]] = {}
        self.hello_statuses: list[int] = []
        """Statuses to answer the next hellos with instead, one each."""
        self.url = ""
        self._runner: web.AppRunner | None = None

    # routes

    def _app(self) -> web.Application:
        app = web.Application()
        routes = self.fixture["routes"]
        app.router.add_post(routes["hello"], self._hello)
        app.router.add_post(routes["tool"], self._tool)
        app.router.add_post("/v1/traces", self._traces)
        return app

    async def start(self) -> None:
        self._runner = web.AppRunner(self._app())
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self.url = f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    def routes_asked(self) -> list[str]:
        return [asked.route for asked in self.asked]

    def bodies(self, route: str) -> list[Any]:
        return [asked.body for asked in self.asked if asked.route == route]

    # answers

    def _answer(self, status: int, value: Any) -> web.Response:
        return web.Response(
            status=status, body=compact(value), content_type="application/json"
        )

    def _refused(self, code: int, message: str, error: str = "seam_refused"):
        return self._answer(422, {"error": error, "code": code, "message": message})

    def _not_a_simulation(self) -> web.Response:
        return self._answer(404, self.fixture["not_a_simulation"]["body"])

    async def _read(self, route: str, request: web.Request) -> tuple[Any, bool]:
        raw = await request.read()
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        authorization = request.headers.get("Authorization", "")
        self.asked.append(Asked(route, authorization, body))
        return body, authorization == f"Bearer {PROJECT_KEY}"

    def _unauthenticated(self) -> web.Response:
        exchange = self.fixture["exchanges"]["unauthenticated"]
        return self._answer(exchange["status"], exchange["response"])

    def _mocked_names(self, reference: str) -> list[str]:
        return [tool["tool"] for tool in self.worlds[reference]]

    def _flows_message(self, names: list[str]) -> str:
        quoted = ", ".join(f'"{name}"' for name in names)
        if len(names) == 1:
            return (
                f"the test mocks {quoted}, and this is a Pipecat Flows function; "
                "Egma cannot mock it yet. Remove it from the test's mock tools. "
                "Flows functions that are not mocked run for real and are recorded."
            )
        return (
            f"the test mocks {quoted}, and these are Pipecat Flows functions; "
            "Egma cannot mock them yet. Remove them from the test's mock tools. "
            "Flows functions that are not mocked run for real and are recorded."
        )

    async def _hello(self, request: web.Request) -> web.Response:
        body, authorized = await self._read("hello", request)
        if not authorized:
            return self._unauthenticated()
        if self.hello_statuses:
            return self._answer(self.hello_statuses.pop(0), {"error": "busy"})
        malformed = self.fixture["exchanges"]["hello_malformed"]["response"]
        if not isinstance(body, dict) or not _good_reference(body):
            return self._refused(901, malformed["message"])
        tools = body.get("tools")
        if not isinstance(tools, list) or not all(_good_entry(t) for t in tools):
            return self._refused(901, malformed["message"])
        reference = body["provider_reference"]
        if reference not in self.live:
            return self._not_a_simulation()
        version = body.get("protocol_version")
        if version != 1:
            return self._refused(
                904,
                f"this hello speaks protocol version {version}, and Egma speaks 1. "
                "Upgrade the egma package.",
            )
        mocked = self._mocked_names(reference)
        flows = [t["name"] for t in tools if t.get("flows") and t["name"] in mocked]
        if flows:
            message = self._flows_message(flows)
            self.reports[reference] = {
                "state": "refused",
                "code": 905,
                "message": message,
                "tools": tools,
            }
            return self._refused(905, message, "flows_function_mocked")
        self.reports[reference] = {
            "state": "accepted",
            "protocol_version": 1,
            "tools": tools,
            "mocked_tools": mocked,
        }
        return self._answer(200, {"protocol_version": 1, "mocked_tools": mocked})

    async def _tool(self, request: web.Request) -> web.Response:
        body, authorized = await self._read("tool", request)
        if not authorized:
            return self._unauthenticated()
        shape = (
            "egma.tool names the tool being called and carries its arguments as "
            "a JSON object or not at all; this one does not."
        )
        if (
            not isinstance(body, dict)
            or not _good_reference(body)
            or not isinstance(body.get("name"), str)
            or not body["name"]
            or ("arguments" in body and not isinstance(body["arguments"], dict))
            or ("flows" in body and not isinstance(body["flows"], bool))
        ):
            return self._refused(901, shape)
        reference = body["provider_reference"]
        if reference not in self.live:
            return self._not_a_simulation()
        name = body["name"]
        mocked = self._mocked_names(reference)
        if body.get("flows") and name in mocked:
            return self._refused(
                905, self._flows_message([name]), "flows_function_mocked"
            )
        for tool in self.worlds[reference]:
            if tool["tool"] == name:
                if "error" in tool:
                    return self._answer(200, {"error": tool["error"]})
                return self._answer(200, {"answer": tool["answer"]})
        return self._refused(
            902,
            f"this simulation has no mock tool for '{name}', so Egma has nothing "
            f"to answer with. It answers for: {', '.join(mocked) or 'no tools at all'}",
        )

    async def _traces(self, request: web.Request) -> web.Response:
        self.traces.append((dict(request.headers), await request.read()))
        return web.Response(status=200, body=b"", content_type="application/x-protobuf")


def _good_reference(body: dict[str, Any]) -> bool:
    reference = body.get("provider_reference")
    return isinstance(reference, str) and 0 < len(reference) <= 512


def _good_entry(entry: Any) -> bool:
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("name"), str)
        and bool(entry["name"])
        and ("flows" not in entry or isinstance(entry["flows"], bool))
    )


# --- spans -------------------------------------------------------------------


class SpanSink(SpanExporter):
    """Every span an export sends, in the order it was sent."""

    def __init__(self) -> None:
        self.batches: list[list[ReadableSpan]] = []
        self.stopped = False

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.batches.append(list(spans))
        return SpanExportResult.SUCCESS

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True

    def shutdown(self) -> None:
        self.stopped = True

    @property
    def spans(self) -> list[ReadableSpan]:
        return [span for batch in self.batches for span in batch]

    def named(self, name: str) -> list[ReadableSpan]:
        return [span for span in self.spans if span.name == name]


# --- the bot -----------------------------------------------------------------


@dataclass
class Step:
    """One scripted LLM answer: some text, then some tool calls."""

    text: str = ""
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)


class ScriptedLLM(LLMService):
    """A Pipecat LLM service whose answers a test writes in advance."""

    adapter_class = OpenAILLMAdapter

    def __init__(self, script: list[Step], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._script = list(script)
        self._calls_made = 0
        self.answered = 0
        self.done = asyncio.Event()
        if not self._script:
            self.done.set()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            await self._answer(frame.context)
        else:
            await self.push_frame(frame, direction)

    async def _answer(self, context: Any) -> None:
        if not self._script:
            return
        step = self._script.pop(0)
        await self.push_frame(LLMFullResponseStartFrame())
        if step.text:
            await self.push_frame(LLMTextFrame(step.text))
        if step.calls:
            calls = []
            for name, arguments in step.calls:
                self._calls_made += 1
                calls.append(
                    FunctionCallFromLLM(
                        function_name=name,
                        tool_call_id=f"call_{self._calls_made}",
                        arguments=arguments,
                        context=context,
                    )
                )
            await self.run_function_calls(calls)
        await self.push_frame(LLMFullResponseEndFrame())
        self.answered += 1
        if not self._script:
            self.done.set()


class Recording(FrameProcessor):
    """Passes every frame on, keeping those of the given kinds."""

    def __init__(self, *kinds: type[Frame]) -> None:
        super().__init__()
        self._kinds = kinds or (Frame,)
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, self._kinds):
            self.frames.append(frame)
        await self.push_frame(frame, direction)


def worker_for(processors: list[FrameProcessor], **kwargs: Any) -> PipelineWorker:
    kwargs.setdefault("enable_rtvi", False)
    return PipelineWorker(
        Pipeline(processors),
        cancel_on_idle_timeout=False,
        check_dangling_tasks=False,
        **kwargs,
    )


async def run_pipeline(
    worker: PipelineWorker,
    drive: Callable[[], Awaitable[None]],
    *,
    seconds: float = 20.0,
) -> None:
    """Start the worker, run ``drive`` once it has started, then end it."""
    started = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def _started(_worker: Any, _frame: Any) -> None:
        started.set()

    async def driven() -> None:
        try:
            await asyncio.wait_for(started.wait(), seconds)
            await drive()
        except BaseException:
            # A failed drive must not leave the worker running forever.
            await worker.cancel()
            raise
        await worker.queue_frame(EndFrame())

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await asyncio.wait_for(asyncio.gather(runner.run(), driven()), seconds)


@dataclass
class RunnerArgs:
    """The shape of Pipecat's runner arguments the SDK reads."""

    body: Any = field(default_factory=dict)
    session_id: str | None = None


class DailyRunnerArguments(RunnerArgs):
    """Named like Pipecat's, so the transport reads as ``daily``."""


def simulation_body(reference: str, **extra: Any) -> dict[str, Any]:
    return {"tenant": "lakeside", "egma": {"simulation_id": reference, **extra}}


# --- fixtures ----------------------------------------------------------------


@pytest.fixture(scope="session")
def fixture() -> dict[str, Any]:
    return seam_fixture()


@pytest.fixture
async def egma(fixture, monkeypatch) -> EgmaDouble:
    """egma's server, with the bot's environment pointing at it."""
    double = EgmaDouble(fixture)
    await double.start()
    monkeypatch.setenv("EGMA_URL", double.url)
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    monkeypatch.setattr(https_seam, "HELLO_RETRY_PAUSES_SECONDS", (0.01, 0.01))
    yield double
    await double.stop()


class Exports:
    """Every export a test's sessions built, each with its own sink."""

    def __init__(self) -> None:
        self.sinks: list[SpanSink] = []
        self.built: list[tuple[str, str, str]] = []

    @property
    def only(self) -> SpanSink:
        assert len(self.sinks) == 1, f"{len(self.sinks)} exports were built"
        return self.sinks[0]


@pytest.fixture
def exports(monkeypatch) -> Exports:
    """Spans go to memory instead of egma's trace door."""
    record = Exports()

    def build(endpoint: str, api_key: str, verb: str) -> SpanSink:
        record.built.append((endpoint, api_key, verb))
        sink = SpanSink()
        record.sinks.append(sink)
        return sink

    monkeypatch.setattr(export, "_build_exporter", build)
    return record


@pytest.fixture
def no_network(monkeypatch) -> list[str]:
    """Any attempt to reach a network fails the test and is listed."""
    attempts: list[str] = []

    def refuse(what: str):
        def refused(*args: Any, **kwargs: Any) -> Any:
            attempts.append(what)
            raise AssertionError(f"{what} was attempted")

        return refused

    monkeypatch.setattr(socket.socket, "connect", refuse("socket.connect"))
    monkeypatch.setattr(socket, "create_connection", refuse("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", refuse("getaddrinfo"))
    monkeypatch.setattr(
        asyncio.base_events.BaseEventLoop,
        "create_connection",
        refuse("loop.create_connection"),
    )
    monkeypatch.setattr(
        asyncio.base_events.BaseEventLoop, "getaddrinfo", refuse("loop.getaddrinfo")
    )
    monkeypatch.setattr(aiohttp, "ClientSession", refuse("aiohttp.ClientSession"))
    return attempts
