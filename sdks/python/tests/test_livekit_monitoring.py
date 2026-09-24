"""Verify the exporter shared by monitor() and simulation().
Use real OpenTelemetry providers, in-memory exporters, and a local HTTP
collector to check settings, provider reuse, room attributes, and final flush.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from livekit.agents.telemetry import tracer as livekit_tracer
from opentelemetry import trace
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from room_stub import PRODUCTION_ROOM, SIMULATION_ROOM, egma_metadata

from egma import export, monitor
from egma.export import PROVIDER_REFERENCE

PROJECT_KEY = f"egma_sk_{'a' * 43}"
A_SIMULATION_ROOM = SIMULATION_ROOM


class ScriptedExporter:
    def __init__(self, results: list[SpanExportResult]) -> None:
        self.results = iter(results)
        self.batches: list[list[str]] = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.flushed = False
        self.stopped = False

    def export(self, spans) -> SpanExportResult:
        self.batches.append([span.name for span in spans])
        self.entered.set()
        if self.block:
            assert self.release.wait(1)
        return next(self.results, SpanExportResult.SUCCESS)

    def force_flush(self, timeout_millis=30_000) -> bool:
        self.flushed = True
        return True

    def shutdown(self) -> None:
        self.stopped = True


def named(name: str):
    return SimpleNamespace(name=name)


def test_simulation_export_orders_children_before_root_and_latches_failure():
    delegate = ScriptedExporter([
        SpanExportResult.FAILURE,
        SpanExportResult.SUCCESS,
    ])
    exporter = export._SimulationEvidenceExporter(delegate)

    first = exporter.export([named("agent_turn"), named("agent_session")])
    assert first == SpanExportResult.FAILURE
    assert exporter.export([named("tool_call")]) == SpanExportResult.SUCCESS
    final = exporter.export([named("llm_request"), named("agent_session")])
    assert final == SpanExportResult.FAILURE

    assert delegate.batches == [
        ["agent_turn"],
        ["tool_call"],
        ["llm_request"],
    ]


@dataclass
class StubJobRoom:
    name: str = PRODUCTION_ROOM


@dataclass
class StubJob:
    """A job, down to the two things the monitoring guard reads of one."""

    room: StubJobRoom = field(default_factory=StubJobRoom)
    metadata: str = ""


@dataclass(eq=False)
class StubJobContext:
    """A LiveKit job context, down to its shutdown callback contract."""

    job: StubJob = field(default_factory=StubJob)
    shutdown_callbacks: list[Any] = field(default_factory=list)

    def add_shutdown_callback(self, callback: Any) -> None:
        self.shutdown_callbacks.append(callback)


def in_the_room(name: str, metadata: str = "") -> StubJobContext:
    """A job whose room is named that."""
    return StubJobContext(job=StubJob(room=StubJobRoom(name=name), metadata=metadata))


def install_provider(monkeypatch, provider: TracerProvider) -> None:
    """Keep a test provider local instead of changing Python's global one."""

    monkeypatch.setattr(
        export,
        "_select_compatible_provider",
        lambda _verb, _reference: provider,
    )
    monkeypatch.setattr(
        export, "_register_provider", lambda _selected, _reference: None
    )


def test_environment_configures_the_exact_egma_trace_endpoint(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    built_with: list[tuple[str, str]] = []

    def build_exporter(
        endpoint: str, api_key: str, verb: str
    ) -> InMemorySpanExporter:
        built_with.append((endpoint, api_key, verb))
        return InMemorySpanExporter()

    monkeypatch.setattr(export, "_build_exporter", build_exporter)
    monkeypatch.setenv("EGMA_URL", "https://api.egma.ai/")
    monkeypatch.setenv("EGMA_API_KEY", PROJECT_KEY)
    context = StubJobContext()

    monitor(context)

    assert built_with == [
        ("https://api.egma.ai/v1/traces", PROJECT_KEY, "egma.monitor")
    ]
    assert len(context.shutdown_callbacks) == 1
    provider.shutdown()


@pytest.mark.parametrize(
    "context",
    [
        pytest.param(
            in_the_room(SIMULATION_ROOM),
            id="whichever worker was listening took the room",
        ),
    ],
)
def test_an_egma_simulation_does_not_create_a_production_exporter(
    monkeypatch, caplog, context
):
    """All three dispatch paths into an egma room, not just the one.

    A simulation's spans have their own trace, so exporting the agent's
    side of the same room through the production door would put an
    invented second conversation into Monitoring. The room's name is the
    one signal that arrives on all three paths: egma writes no dispatch
    metadata on any of them, so a worker reading that channel would
    export on every one.
    """
    monkeypatch.delenv("EGMA_URL", raising=False)
    monkeypatch.delenv("EGMA_API_KEY", raising=False)

    with caplog.at_level("WARNING", logger="egma"):
        monitor(context)

    assert export._state is None
    assert context.shutdown_callbacks == []
    # Said out loud, because a room's name is chosen by whoever mints the
    # join token: a production room named to look like a simulation would
    # lose its Monitoring record, and a dropped trace is evidence the
    # customer cannot get back.
    assert "not exported" in caplog.text


@pytest.mark.parametrize(
    "metadata",
    [
        pytest.param(egma_metadata(), id="egma's own key names, in a real room"),
    ],
)
def test_a_production_room_is_still_exported_whatever_its_metadata_says(
    monkeypatch, metadata
):
    """Dispatch metadata is the customer's channel and says nothing here.

    The second parameter is the one that has to hold. Dispatch metadata is
    the customer's to fill, so a production room whose JSON happens to use
    egma's key names is still a production room — and the cost of reading
    it otherwise is not a stray span but a missing one: a real
    conversation with no record in Monitoring at all, which is evidence
    nobody can get back.
    """
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    monkeypatch.setattr(
        export,
        "_build_exporter",
        lambda _endpoint, _key, _verb: InMemorySpanExporter(),
    )
    context = in_the_room(PRODUCTION_ROOM, metadata)

    monitor(
        context, endpoint="https://api.egma.ai", api_key=PROJECT_KEY
    )

    assert export._state is not None
    assert len(context.shutdown_callbacks) == 1
    provider.shutdown()


@pytest.mark.parametrize(
    "invalid_key",
    [
        "egma_sk_short",
        f"egma_sk_{'a' * 44}",
    ],
)
def test_invalid_project_key_is_refused_before_exporter_setup(invalid_key):
    with pytest.raises(ValueError) as refused:
        monitor(
            StubJobContext(),
            endpoint="https://api.egma.ai",
            api_key=invalid_key,
        )

    assert "invalid EGMA_API_KEY" in str(refused.value)
    assert invalid_key not in str(refused.value)


async def test_existing_telemetry_and_egma_both_receive_the_same_span(
    monkeypatch,
):
    provider = TracerProvider()
    existing = InMemorySpanExporter()
    egma = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(existing))
    monkeypatch.setattr(export, "_livekit_provider", lambda: provider)
    monkeypatch.setattr(
        export.trace, "get_tracer_provider", lambda: provider
    )
    registered: list[TracerProvider] = []
    monkeypatch.setattr(
        export,
        "set_tracer_provider",
        lambda selected, **_options: registered.append(selected),
    )
    monkeypatch.setattr(
        export, "_build_exporter", lambda _endpoint, _key, _verb: egma
    )
    context = StubJobContext()

    monitor(
        context,
        endpoint="https://api.egma.ai",
        api_key=PROJECT_KEY,
    )
    with provider.get_tracer("livekit-agents").start_as_current_span("session"):
        pass

    await context.shutdown_callbacks[0]()

    assert registered == [provider]
    assert [span.name for span in existing.get_finished_spans()] == ["session"]
    assert [span.name for span in egma.get_finished_spans()] == ["session"]
    provider.shutdown()


@pytest.mark.parametrize("other_flush_result", [None])
async def test_shared_telemetry_cannot_block_egmas_shutdown_flush(
    monkeypatch, caplog, other_flush_result
):
    class NoFlushResult(SpanProcessor):
        def on_start(self, span, parent_context=None):
            return None

        def on_end(self, span):
            return None

        def shutdown(self):
            return None

        def force_flush(self, timeout_millis=30_000):
            return other_flush_result

    class DeterministicBatchProcessor(SpanProcessor):
        def __init__(self, exporter):
            self.exporter = exporter
            self.pending = []

        def on_start(self, span, parent_context=None):
            return None

        def on_end(self, span):
            self.pending.append(span)

        def shutdown(self):
            self.force_flush()
            self.exporter.shutdown()

        def force_flush(self, timeout_millis=30_000):
            self.exporter.export(tuple(self.pending))
            self.pending.clear()
            return True

    provider = TracerProvider()
    provider.add_span_processor(NoFlushResult())
    install_provider(monkeypatch, provider)
    egma = InMemorySpanExporter()
    monkeypatch.setattr(
        export, "BatchSpanProcessor", DeterministicBatchProcessor
    )
    monkeypatch.setattr(
        export, "_build_exporter", lambda _endpoint, _key, _verb: egma
    )
    context = StubJobContext()

    monitor(
        context,
        endpoint="https://api.egma.ai",
        api_key=PROJECT_KEY,
    )
    with provider.get_tracer("livekit-agents").start_as_current_span("session"):
        pass

    await context.shutdown_callbacks[0]()

    assert [span.name for span in egma.get_finished_spans()] == ["session"]
    assert "could not flush" not in caplog.text
    provider.shutdown()


def test_repeated_setup_adds_one_exporter_and_one_job_callback(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    exporters: list[InMemorySpanExporter] = []

    def build_exporter(
        _endpoint: str, _key: str, _verb: str
    ) -> InMemorySpanExporter:
        exporter = InMemorySpanExporter()
        exporters.append(exporter)
        return exporter

    monkeypatch.setattr(export, "_build_exporter", build_exporter)
    context = StubJobContext()

    for _ in range(2):
        monitor(
            context,
            endpoint="https://api.egma.ai/v1/traces",
            api_key=PROJECT_KEY,
        )

    assert len(exporters) == 1
    assert len(context.shutdown_callbacks) == 1
    provider.shutdown()


def test_livekit_noop_provider_is_treated_as_not_configured(monkeypatch):
    noop = export.trace.NoOpTracerProvider()
    proxy = export.trace.ProxyTracerProvider()
    monkeypatch.setattr(export, "_livekit_provider", lambda: noop)
    monkeypatch.setattr(
        export.trace, "get_tracer_provider", lambda: proxy
    )

    provider = export._select_compatible_provider("egma.monitor", "")

    assert isinstance(provider, TracerProvider)
    provider.shutdown()


def test_changing_configuration_requires_a_worker_restart(monkeypatch):
    provider = TracerProvider()
    install_provider(monkeypatch, provider)
    monkeypatch.setattr(
        export,
        "_build_exporter",
        lambda _endpoint, _key, _verb: InMemorySpanExporter(),
    )
    context = StubJobContext()
    monitor(
        context,
        endpoint="https://api.egma.ai",
        api_key=f"egma_sk_{'a' * 43}",
    )

    with pytest.raises(ValueError) as refused:
        monitor(
            context,
            endpoint="https://api.egma.ai",
            api_key=f"egma_sk_{'b' * 43}",
        )

    assert "Restart" in str(refused.value)
    assert f"egma_sk_{'a' * 43}" not in str(refused.value)
    assert f"egma_sk_{'b' * 43}" not in str(refused.value)
    provider.shutdown()


# Simulation room names must be exported on both new resources and spans.
# Span metadata also supports an existing provider whose resource cannot change.


def test_a_production_provider_carries_no_provider_reference(monkeypatch):
    """Production traffic names no conversation, and must not start to.

    A resource that carried the attribute would send every production
    conversation down the simulation branch of Egma's door.
    """
    monkeypatch.setattr(export, "_livekit_provider", trace.ProxyTracerProvider)
    monkeypatch.setattr(
        export.trace, "get_tracer_provider", trace.ProxyTracerProvider
    )

    provider = export._select_compatible_provider("egma.monitor", "")

    assert PROVIDER_REFERENCE not in provider.resource.attributes
    provider.shutdown()


def test_the_room_name_is_stamped_on_every_span_through_livekits_own_seam(
    monkeypatch,
):
    """The case that matters: the provider is somebody else's.

    A customer already exporting to their own collector keeps their
    provider, resource and all — so the room name cannot go on that
    resource. LiveKit's ``set_tracer_provider(..., metadata=…)`` puts it
    on every span the provider starts instead, which is the copy Egma's
    door falls back to.
    """
    monkeypatch.setattr(livekit_tracer, "_tracer_provider", None, raising=False)
    provider = TracerProvider()
    exported = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exported))

    export._register_provider(provider, A_SIMULATION_ROOM)
    provider.get_tracer("livekit-agents").start_span("agent turn").end()

    [span] = exported.get_finished_spans()
    assert span.attributes[PROVIDER_REFERENCE] == A_SIMULATION_ROOM
    provider.shutdown()


def test_a_production_span_is_stamped_with_no_room_name(monkeypatch):
    """The other half of the same guard, on the span rather than the resource."""
    monkeypatch.setattr(livekit_tracer, "_tracer_provider", None, raising=False)
    provider = TracerProvider()
    exported = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exported))

    export._register_provider(provider, "")
    provider.get_tracer("livekit-agents").start_span("session").end()

    [span] = exported.get_finished_spans()
    assert PROVIDER_REFERENCE not in (span.attributes or {})
    provider.shutdown()
